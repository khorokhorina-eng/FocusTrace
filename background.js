const LOCAL_TTS_ENDPOINTS = [
  "http://127.0.0.1:8787/tts",
  "http://localhost:8787/tts",
];

const LOCAL_BILLING_ENDPOINTS = [
  "http://127.0.0.1:8787",
  "http://localhost:8787",
];

const PAYWALL_LIMIT_SECONDS = 5;
const PAYWALL_USED_SECONDS_KEY = "paywallUsedSeconds";
const INSTALL_ID_KEY = "installId";

const SUBSCRIPTION_CACHE_MS = 30 * 1000;
let subscriptionCache = {
  installId: "",
  active: false,
  status: "none",
  plan: null,
  timestamp: 0,
};

function readStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function writeStorage(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, () => resolve());
  });
}

async function readUsageSeconds() {
  const result = await readStorage([PAYWALL_USED_SECONDS_KEY]);
  const value = Number(result?.[PAYWALL_USED_SECONDS_KEY]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function writeUsageSeconds(value) {
  await writeStorage({ [PAYWALL_USED_SECONDS_KEY]: value });
}

async function getOrCreateInstallId() {
  const result = await readStorage([INSTALL_ID_KEY]);
  const existing = typeof result?.[INSTALL_ID_KEY] === "string" ? result[INSTALL_ID_KEY] : "";
  if (existing) {
    return existing;
  }
  const created = (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) ||
    `install_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await writeStorage({ [INSTALL_ID_KEY]: created });
  return created;
}

async function fetchJsonFromEndpoints(pathname, options = {}) {
  let lastError = null;

  for (const baseUrl of LOCAL_BILLING_ENDPOINTS) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, options);
      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_error) {
          data = { raw: text };
        }
      }
      if (!response.ok) {
        throw new Error(data?.error || `Request failed with ${response.status}`);
      }
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || "Local billing server is unreachable.");
}

async function getSubscriptionStatus(forceRefresh = false) {
  const installId = await getOrCreateInstallId();
  const now = Date.now();

  if (
    !forceRefresh &&
    subscriptionCache.installId === installId &&
    now - subscriptionCache.timestamp < SUBSCRIPTION_CACHE_MS
  ) {
    return {
      installId,
      active: subscriptionCache.active,
      status: subscriptionCache.status,
      plan: subscriptionCache.plan,
    };
  }

  const data = await fetchJsonFromEndpoints(
    `/stripe/subscription-status?installId=${encodeURIComponent(installId)}`
  );

  subscriptionCache = {
    installId,
    active: !!data.active,
    status: data.status || "none",
    plan: data.plan || null,
    timestamp: now,
  };

  return {
    installId,
    active: subscriptionCache.active,
    status: subscriptionCache.status,
    plan: subscriptionCache.plan,
  };
}

async function getPlaybackQuota() {
  const sub = await getSubscriptionStatus(false).catch(() => ({ active: false }));

  if (sub.active) {
    return {
      usedSeconds: 0,
      limitSeconds: PAYWALL_LIMIT_SECONDS,
      remainingSeconds: Number.MAX_SAFE_INTEGER,
      isLimited: false,
      isSubscribed: true,
      subscriptionStatus: sub.status || "active",
      plan: sub.plan || null,
    };
  }

  const usedSeconds = await readUsageSeconds();
  const remainingSeconds = Math.max(0, PAYWALL_LIMIT_SECONDS - usedSeconds);
  return {
    usedSeconds,
    limitSeconds: PAYWALL_LIMIT_SECONDS,
    remainingSeconds,
    isLimited: remainingSeconds <= 0,
    isSubscribed: false,
    subscriptionStatus: "none",
    plan: null,
  };
}

async function addPlaybackUsage(rawSeconds) {
  const quota = await getPlaybackQuota();
  if (quota.isSubscribed) {
    return quota;
  }

  const delta = Number(rawSeconds);
  if (!Number.isFinite(delta) || delta <= 0) {
    return getPlaybackQuota();
  }

  const usedSeconds = await readUsageSeconds();
  const nextUsedSeconds = usedSeconds + delta;
  await writeUsageSeconds(nextUsedSeconds);
  return getPlaybackQuota();
}

async function fetchPdfBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Background fetch failed (${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  return { bytes: Array.from(new Uint8Array(buffer)) };
}

async function synthesizeSpeech({ text, speed, language }) {
  if (!text || typeof text !== "string") {
    throw new Error("TTS text is empty.");
  }

  let lastError = null;
  for (const endpoint of LOCAL_TTS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, speed, language }),
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(
          `Local TTS returned ${response.status}${details ? `: ${details}` : ""}`
        );
      }

      const buffer = await response.arrayBuffer();
      return {
        bytes: Array.from(new Uint8Array(buffer)),
        mimeType: response.headers.get("content-type") || "audio/mpeg",
      };
    } catch (error) {
      lastError = error;
    }
  }

  const message =
    lastError && lastError.message
      ? lastError.message
      : "Unable to reach local TTS service on port 8787.";
  throw new Error(message);
}

async function createCheckoutSession(planId, returnUrl) {
  const installId = await getOrCreateInstallId();
  const data = await fetchJsonFromEndpoints("/stripe/checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installId, planId, returnUrl }),
  });
  return {
    installId,
    url: data.url,
    sessionId: data.sessionId,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "getPlaybackQuota") {
    getPlaybackQuota()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to read quota.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "addPlaybackUsage") {
    addPlaybackUsage(message.seconds)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to save quota.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "createCheckoutSession") {
    createCheckoutSession(message.planId, message.returnUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to create checkout session.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "refreshSubscriptionStatus") {
    getSubscriptionStatus(true)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to refresh subscription status.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "fetchPdfBytes" && message.url) {
    fetchPdfBytes(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Background fetch failed.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "synthesizeSpeech") {
    synthesizeSpeech(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "TTS request failed.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  return false;
});
