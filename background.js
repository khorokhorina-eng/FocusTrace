const REMOTE_API_BASE_URL = "https://pdftext2speech.com";

const TTS_ENDPOINTS = [
  `${REMOTE_API_BASE_URL}/tts`,
];

const BILLING_ENDPOINTS = [
  REMOTE_API_BASE_URL,
];

const DEFAULT_FREE_TRIAL_SECONDS = 120;
const DEFAULT_MIN_FREE_PLAYBACK_START_SECONDS = 0;
const DEVICE_TOKEN_KEY = "deviceToken";
const AUTH_SESSION_KEY = "authSession";
const TRIAL_STATE_KEY = "trialState";

const SUBSCRIPTION_CACHE_MS = 30 * 1000;
let subscriptionCache = {
  deviceToken: "",
  active: false,
  status: "none",
  plan: null,
  minutesLeft: Math.ceil(DEFAULT_FREE_TRIAL_SECONDS / 60),
  remainingSeconds: DEFAULT_FREE_TRIAL_SECONDS,
  freeTrialSeconds: DEFAULT_FREE_TRIAL_SECONDS,
  minFreePlaybackStartSeconds: DEFAULT_MIN_FREE_PLAYBACK_START_SECONDS,
  timestamp: 0,
};

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }

  chrome.tabs.create({
    url: `${REMOTE_API_BASE_URL}/welcome.html`,
  });
});

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
  const deviceToken = await getOrCreateDeviceToken();
  const result = await readStorage([TRIAL_STATE_KEY]);
  const trialState = result?.[TRIAL_STATE_KEY];
  if (!trialState || trialState.deviceToken !== deviceToken) {
    return null;
  }
  if (!Number.isFinite(Number(trialState.remainingSeconds))) {
    return null;
  }
  return Math.max(0, Math.floor(Number(trialState.remainingSeconds)));
}

async function writeUsageSeconds(value) {
  const deviceToken = await getOrCreateDeviceToken();
  const safeSeconds = Number.isFinite(Number(value))
    ? Math.max(0, Math.floor(Number(value)))
    : null;

  if (safeSeconds === null) {
    await writeStorage({ [TRIAL_STATE_KEY]: null });
    return null;
  }

  await writeStorage({
    [TRIAL_STATE_KEY]: {
      deviceToken,
      remainingSeconds: safeSeconds,
      updatedAt: Date.now(),
    },
  });
  return safeSeconds;
}

async function getOrCreateDeviceToken() {
  const result = await readStorage([DEVICE_TOKEN_KEY]);
  const existing = typeof result?.[DEVICE_TOKEN_KEY] === "string" ? result[DEVICE_TOKEN_KEY] : "";
  if (existing) {
    return existing;
  }
  const created =
    (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) ||
    `device_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await writeStorage({ [DEVICE_TOKEN_KEY]: created });
  return created;
}

async function getAuthState() {
  const deviceToken = await getOrCreateDeviceToken();
  const cached = await readStorage([AUTH_SESSION_KEY]);
  const cachedSession = cached?.[AUTH_SESSION_KEY];

  try {
    const data = await fetchJsonFromEndpoints(`/auth/me?device_token=${encodeURIComponent(deviceToken)}`);
    const session = {
      email: typeof data?.email === "string" ? data.email.trim() : "",
      method: data?.method || null,
      signedInAt: data?.signedInAt || null,
    };
    await writeStorage({ [AUTH_SESSION_KEY]: session.email ? session : null });
    return {
      signedIn: Boolean(session.email),
      email: session.email,
      method: session.method,
      signedInAt: session.signedInAt,
      deviceToken,
    };
  } catch (_error) {
    const email = typeof cachedSession?.email === "string" ? cachedSession.email.trim() : "";
    return {
      signedIn: Boolean(email),
      email,
      method: email ? cachedSession?.method || "email" : null,
      signedInAt: cachedSession?.signedInAt || null,
      deviceToken,
    };
  }
}

async function signOut() {
  const deviceToken = await getOrCreateDeviceToken();
  try {
    await fetchJsonFromEndpoints("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_token: deviceToken }),
    });
  } catch (_error) {
    // Clear local state even if the remote logout endpoint is not available.
  }
  await writeStorage({ [AUTH_SESSION_KEY]: null });
  return {
    signedIn: false,
    email: "",
    method: null,
    signedInAt: null,
    deviceToken,
  };
}

function getConfiguredFreeTrialSeconds(data) {
  if (Number.isFinite(Number(data?.freeTrialSeconds))) {
    return Math.max(0, Math.floor(Number(data.freeTrialSeconds)));
  }
  return subscriptionCache.freeTrialSeconds || DEFAULT_FREE_TRIAL_SECONDS;
}

function getConfiguredMinStartSeconds(data) {
  if (Number.isFinite(Number(data?.minFreePlaybackStartSeconds))) {
    return Math.max(0, Math.floor(Number(data.minFreePlaybackStartSeconds)));
  }
  return (
    subscriptionCache.minFreePlaybackStartSeconds ||
    DEFAULT_MIN_FREE_PLAYBACK_START_SECONDS
  );
}

async function startGoogleSignIn(returnUrl) {
  const deviceToken = await getOrCreateDeviceToken();
  const target = new URL(`${REMOTE_API_BASE_URL}/auth/google/start`);
  target.searchParams.set("device_token", deviceToken);
  if (typeof returnUrl === "string" && returnUrl.trim()) {
    target.searchParams.set("return_url", returnUrl.trim());
  }
  await chrome.tabs.create({ url: target.toString() });
  return { started: true, deviceToken };
}

async function fetchJsonFromEndpoints(pathname, options = {}) {
  const deviceToken = await getOrCreateDeviceToken();
  let lastError = null;

  for (const baseUrl of BILLING_ENDPOINTS) {
    try {
      const headers = {
        ...(options.headers || {}),
        "x-device-token": deviceToken,
      };
      const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers,
      });
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

  throw new Error(lastError?.message || "Remote billing server is unreachable.");
}

async function getSubscriptionStatus(forceRefresh = false) {
  const deviceToken = await getOrCreateDeviceToken();
  const now = Date.now();
  const localRemainingSeconds = await readUsageSeconds();

  if (
    !forceRefresh &&
    subscriptionCache.deviceToken === deviceToken &&
    now - subscriptionCache.timestamp < SUBSCRIPTION_CACHE_MS
  ) {
    return {
      deviceToken,
      active: subscriptionCache.active,
      status: subscriptionCache.status,
      plan: subscriptionCache.plan,
      minutesLeft: subscriptionCache.minutesLeft,
      remainingSeconds: Number.isFinite(localRemainingSeconds)
        ? Math.min(subscriptionCache.remainingSeconds, localRemainingSeconds)
        : subscriptionCache.remainingSeconds,
      freeTrialSeconds: subscriptionCache.freeTrialSeconds,
      minFreePlaybackStartSeconds: subscriptionCache.minFreePlaybackStartSeconds,
    };
  }

  const data = await fetchJsonFromEndpoints("/me");
  const configuredFreeTrialSeconds = getConfiguredFreeTrialSeconds(data);
  const configuredMinStartSeconds = getConfiguredMinStartSeconds(data);
  const serverRemainingSeconds = Number.isFinite(Number(data.remainingSeconds))
    ? Math.max(0, Number(data.remainingSeconds))
    : Number.isFinite(Number(data.minutesLeft))
    ? Math.max(0, Number(data.minutesLeft)) * 60
    : configuredFreeTrialSeconds;
  const isAnonymousTrial = !data.paid && !data.signedIn;
  const effectiveRemainingSeconds = isAnonymousTrial && Number.isFinite(localRemainingSeconds)
    ? Math.min(serverRemainingSeconds, localRemainingSeconds)
    : serverRemainingSeconds;

  subscriptionCache = {
    deviceToken,
    active: !!data.paid,
    status: data.subscriptionStatus || "none",
    plan: data.plan ? { planId: data.plan } : null,
    remainingSeconds: effectiveRemainingSeconds,
    minutesLeft: Number.isFinite(Number(data.minutesLeft))
      ? Math.max(0, Number(data.minutesLeft))
      : Math.ceil(configuredFreeTrialSeconds / 60),
    freeTrialSeconds: configuredFreeTrialSeconds,
    minFreePlaybackStartSeconds: configuredMinStartSeconds,
    timestamp: now,
  };

  if (isAnonymousTrial) {
    await writeUsageSeconds(effectiveRemainingSeconds);
  } else {
    await writeUsageSeconds(null);
  }

  return {
    deviceToken,
    active: subscriptionCache.active,
    status: subscriptionCache.status,
    plan: subscriptionCache.plan,
    minutesLeft: subscriptionCache.minutesLeft,
    remainingSeconds: subscriptionCache.remainingSeconds,
    freeTrialSeconds: subscriptionCache.freeTrialSeconds,
    minFreePlaybackStartSeconds: subscriptionCache.minFreePlaybackStartSeconds,
  };
}

async function getPlaybackQuota() {
  const sub = await getSubscriptionStatus(true).catch(() => ({ active: false }));
  const remainingSeconds = Number.isFinite(Number(sub.remainingSeconds))
    ? Math.max(0, Number(sub.remainingSeconds))
    : Number.isFinite(Number(sub.minutesLeft))
    ? Math.max(0, Number(sub.minutesLeft)) * 60
    : sub.active
    ? Number.MAX_SAFE_INTEGER
    : 0;

  if (sub.active) {
    return {
      usedSeconds: 0,
      limitSeconds: remainingSeconds,
      remainingSeconds,
      isLimited: remainingSeconds <= 0,
      isSubscribed: true,
      subscriptionStatus: sub.status || "active",
      plan: sub.plan || null,
      freeTrialSeconds: Number.isFinite(Number(sub.freeTrialSeconds))
        ? Math.max(0, Number(sub.freeTrialSeconds))
        : DEFAULT_FREE_TRIAL_SECONDS,
      minFreePlaybackStartSeconds: Number.isFinite(Number(sub.minFreePlaybackStartSeconds))
        ? Math.max(0, Number(sub.minFreePlaybackStartSeconds))
        : DEFAULT_MIN_FREE_PLAYBACK_START_SECONDS,
    };
  }

  const minFreePlaybackStartSeconds = Number.isFinite(Number(sub.minFreePlaybackStartSeconds))
    ? Math.max(0, Number(sub.minFreePlaybackStartSeconds))
    : DEFAULT_MIN_FREE_PLAYBACK_START_SECONDS;
  const freeTrialSeconds = Number.isFinite(Number(sub.freeTrialSeconds))
    ? Math.max(0, Number(sub.freeTrialSeconds))
    : DEFAULT_FREE_TRIAL_SECONDS;

  return {
    usedSeconds: 0,
    limitSeconds: freeTrialSeconds,
    remainingSeconds,
    isLimited: remainingSeconds <= minFreePlaybackStartSeconds,
    isSubscribed: false,
    subscriptionStatus: "none",
    plan: sub.plan || null,
    freeTrialSeconds,
    minFreePlaybackStartSeconds,
  };
}

async function addPlaybackUsage(rawSeconds) {
  const seconds = Number(rawSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return getPlaybackQuota();
  }

  const data = await fetchJsonFromEndpoints("/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seconds }),
  });

  subscriptionCache = {
    ...subscriptionCache,
    active: !!data.paid,
    status: data.subscriptionStatus || subscriptionCache.status || "none",
    plan: data.plan ? { planId: data.plan } : null,
    minutesLeft: Number.isFinite(Number(data.minutesLeft))
      ? Math.max(0, Number(data.minutesLeft))
      : subscriptionCache.minutesLeft,
    remainingSeconds: Number.isFinite(Number(data.remainingSeconds))
      ? Math.max(0, Number(data.remainingSeconds))
      : subscriptionCache.remainingSeconds,
    freeTrialSeconds: getConfiguredFreeTrialSeconds(data),
    minFreePlaybackStartSeconds: getConfiguredMinStartSeconds(data),
    timestamp: Date.now(),
  };

  if (!data.paid) {
    await writeUsageSeconds(subscriptionCache.remainingSeconds);
  }

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

  const deviceToken = await getOrCreateDeviceToken();
  let lastError = null;
  for (const endpoint of TTS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-token": deviceToken,
        },
        body: JSON.stringify({ input: text, speed, language }),
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(
          `Remote TTS returned ${response.status}${details ? `: ${details}` : ""}`
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
      : "Unable to reach the remote TTS service.";
  throw new Error(message);
}

async function createCheckoutSession(planId, returnUrl) {
  const deviceToken = await getOrCreateDeviceToken();
  const authState = await getAuthState();

  if (!authState.signedIn || !authState.email) {
    throw new Error("Sign in required before checkout.");
  }

  const data = await fetchJsonFromEndpoints("/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_token: deviceToken,
      plan: planId,
      return_url: returnUrl || "",
    }),
  });
  return {
    deviceToken,
    email: authState.email,
    url: data.url,
    sessionId: data.sessionId || null,
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

  if (message.type === "getAuthState") {
    getAuthState()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to read auth state.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "startGoogleSignIn") {
    startGoogleSignIn(message.returnUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to start Google sign-in.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "signOut") {
    signOut()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to sign out.";
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
