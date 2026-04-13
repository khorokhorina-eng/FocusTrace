const pdfjs = window.pdfjsLib;
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const playBtn = document.getElementById("play");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const speedSelect = document.getElementById("speed");
const openFileBtn = document.getElementById("openFile");
const fileInput = document.getElementById("fileInput");
const limitUpgradeBtn = document.getElementById("limitUpgrade");
const upgradeBtn = document.getElementById("upgrade");
const contactBtn = document.getElementById("contact");
const paywallModal = document.getElementById("paywallModal");
const closePaywallBtn = document.getElementById("closePaywall");
const paywallStatusEl = document.getElementById("paywallStatus");
const trialEndedNoticeEl = document.getElementById("trialEndedNotice");
const continueCheckoutBtn = document.getElementById("continueCheckout");
const planCardEls = Array.from(document.querySelectorAll(".plan-card"));
const accountStateEl = document.getElementById("accountState");
const accountActionBtn = document.getElementById("accountAction");
const authMessageEl = document.getElementById("authMessage");
const authCopyEl = document.getElementById("authCopy");
const authSignedInEl = document.getElementById("authSignedIn");
const authGoogleBtn = document.getElementById("authGoogle");
const authSignedInTextEl = document.getElementById("authSignedInText");
const authSignOutBtn = document.getElementById("authSignOut");
const REMOTE_API_BASE_URL = "https://pdftext2speech.com";
const DEVICE_TOKEN_KEY = "deviceToken";

const state = {
  status: "idle",
  message: "Upload a .pdf file to start reading.",
  speed: 1,
  fileName: "",
  totalPages: 0,
  totalChunks: 0,
  currentChunk: 0,
  language: "",
};

let textChunks = [];
let currentChunkIndex = 0;
let detectedLanguage = "";
let currentAudio = null;
let currentAudioUrl = "";
let playbackToken = 0;
let paywallStopTimer = null;
let playbackUiTimer = null;
let playbackUsageFlushTimer = null;
let currentAudioBaseSpeed = 1;
let prefetchedChunk = null;
let prefetchPromise = null;
let lastKnownRemainingSeconds = 0;
let sessionRemainingSeconds = null;
let pendingUsageSeconds = 0;
let lastActivePlaybackTickMs = 0;
let currentFileBuffer = null;
let isPreparingText = false;
let preparationComplete = false;
let pendingStartPlayback = false;
let selectedPlanId = "annual";
let currentSubscription = { active: false, plan: null };
let authState = { signedIn: false, email: "", method: null };
let minFreePlaybackStartSeconds = 0;

const PLAN_META = {
  monthly: {
    buttonText: "Continue with 1-month plan",
  },
  annual: {
    buttonText: "Continue with 12-month plan",
  },
};

const STATUS_LABELS = {
  idle: "Ready",
  loading: "Loading",
  reading: "Reading",
  paused: "Paused",
  finished: "Finished",
  error: "Unable to read",
};

if (pdfjs?.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "vendor/pdfjs/pdf.worker.min.js"
  );
}

function setStatus(status, message = "") {
  state.status = status;
  state.message = message;
  updateUI();
}

function updateUI() {
  document.body.dataset.status = state.status;
  statusEl.textContent = STATUS_LABELS[state.status] || "Ready";
  hintEl.textContent = state.message || " ";
  pauseBtn.textContent = state.status === "paused" ? "Resume" : "Pause";
  const shouldShowLimitUpgrade =
    state.status === "error" &&
    typeof state.message === "string" &&
    state.message.includes("Upgrade to continue");
  limitUpgradeBtn.classList.toggle("hidden", !shouldShowLimitUpgrade);
  const trialExhausted = !currentSubscription?.active && getLiveRemainingSeconds() <= 0;
  trialEndedNoticeEl.classList.toggle("hidden", !trialExhausted);
  playBtn.disabled =
    !currentFileBuffer || state.status === "reading" || trialExhausted;
  pauseBtn.disabled = !(state.status === "reading" || state.status === "paused");
  stopBtn.disabled = !(state.status === "reading" || state.status === "paused");
  speedSelect.disabled = state.status === "loading";
  const activePlanId = currentSubscription?.plan?.planId || "";
  const isCurrentPlan = currentSubscription?.active && activePlanId === selectedPlanId;
  continueCheckoutBtn.textContent = isCurrentPlan
    ? "Current plan active"
    : authState.signedIn
    ? PLAN_META[selectedPlanId]?.buttonText || "Continue"
    : "Sign in to continue";
  continueCheckoutBtn.disabled = isCurrentPlan;
  accountStateEl.textContent = authState.signedIn
    ? `Signed in as ${authState.email}`
    : "Not signed in";
  accountActionBtn.textContent = authState.signedIn ? "Manage" : "Sign in";
  openFileBtn.classList.toggle("primary-cta", !currentFileBuffer);
  playBtn.classList.toggle("primary-cta", Boolean(currentFileBuffer));
}

function getLiveRemainingSeconds() {
  if (Number.isFinite(sessionRemainingSeconds)) {
    return Math.max(0, sessionRemainingSeconds);
  }
  return Math.max(0, lastKnownRemainingSeconds);
}

function updateReadingStatus() {
  const remainingLabel = formatRemainingSeconds(getLiveRemainingSeconds());
  setStatus(
    "reading",
    state.fileName
      ? `Reading ${state.fileName} · about ${remainingLabel} left`
      : `Reading · about ${remainingLabel} left`
  );
}

function stopPlaybackUiTimer() {
  if (playbackUiTimer) {
    clearInterval(playbackUiTimer);
    playbackUiTimer = null;
  }
}

function stopPlaybackUsageFlushTimer() {
  if (playbackUsageFlushTimer) {
    clearInterval(playbackUsageFlushTimer);
    playbackUsageFlushTimer = null;
  }
}

function isAudioActivelyPlaying() {
  return Boolean(
    currentAudio &&
      !currentAudio.paused &&
      !currentAudio.ended &&
      currentAudio.readyState >= 2
  );
}

function resetPlaybackTracking() {
  pendingUsageSeconds = 0;
  lastActivePlaybackTickMs = 0;
}

function captureActivePlaybackDelta() {
  const now = Date.now();
  if (!lastActivePlaybackTickMs) {
    lastActivePlaybackTickMs = now;
    return 0;
  }

  if (!isAudioActivelyPlaying()) {
    lastActivePlaybackTickMs = now;
    return 0;
  }

  const elapsedSeconds = Math.max(0, (now - lastActivePlaybackTickMs) / 1000);
  lastActivePlaybackTickMs = now;
  if (elapsedSeconds <= 0) {
    return 0;
  }

  pendingUsageSeconds += elapsedSeconds;
  if (Number.isFinite(sessionRemainingSeconds)) {
    sessionRemainingSeconds = Math.max(0, sessionRemainingSeconds - elapsedSeconds);
    lastKnownRemainingSeconds = Math.max(0, sessionRemainingSeconds);
  }
  return elapsedSeconds;
}

function startPlaybackUiTimer() {
  stopPlaybackUiTimer();
  playbackUiTimer = setInterval(() => {
    if (state.status !== "reading") {
      stopPlaybackUiTimer();
      return;
    }
    captureActivePlaybackDelta();
    if (Number.isFinite(sessionRemainingSeconds) && sessionRemainingSeconds <= 0) {
      stopPlaybackUiTimer();
      const tokenAtStart = playbackToken;
      cleanupCurrentAudio();
      void exhaustPlaybackQuota(tokenAtStart).finally(() => {
        if (tokenAtStart !== playbackToken) {
          return;
        }
        playbackToken += 1;
        resetSessionQuotaTracking();
        showPaywallLimitReached();
      });
      return;
    }
    updateReadingStatus();
  }, 1000);
}

function startPlaybackUsageFlushTimer() {
  stopPlaybackUsageFlushTimer();
  playbackUsageFlushTimer = setInterval(() => {
    if (state.status !== "reading") {
      stopPlaybackUsageFlushTimer();
      return;
    }
    const tokenAtStart = playbackToken;
    captureActivePlaybackDelta();
    commitPlaybackUsage()
      .then((usage) => {
        if (tokenAtStart !== playbackToken || state.status !== "reading") {
          return;
        }
        if (usage && Number(usage.remainingSeconds) <= 0) {
          playbackToken += 1;
          cleanupCurrentAudio();
          resetSessionQuotaTracking();
          showPaywallLimitReached();
          return;
        }
        lastActivePlaybackTickMs = Date.now();
      })
      .catch(() => {
        if (tokenAtStart !== playbackToken || state.status !== "reading") {
          return;
        }
        lastActivePlaybackTickMs = Date.now();
      });
  }, 15000);
}

function cleanupCurrentAudio() {
  if (paywallStopTimer) {
    clearTimeout(paywallStopTimer);
    paywallStopTimer = null;
  }
  stopPlaybackUiTimer();
  stopPlaybackUsageFlushTimer();
  resetPlaybackTracking();
  currentAudioBaseSpeed = 1;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio.load();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = "";
  }
}

function clearPrefetch() {
  prefetchedChunk = null;
  prefetchPromise = null;
}

function resetSessionQuotaTracking() {
  sessionRemainingSeconds = null;
}

function schedulePaywallStop(token, remainingSeconds) {
  if (paywallStopTimer) {
    clearTimeout(paywallStopTimer);
    paywallStopTimer = null;
  }
}

function resetPreparedText() {
  cleanupCurrentAudio();
  clearPrefetch();
  textChunks = [];
  currentChunkIndex = 0;
  detectedLanguage = "";
  isPreparingText = false;
  preparationComplete = false;
  pendingStartPlayback = false;
  state.totalPages = 0;
  state.totalChunks = 0;
  state.currentChunk = 0;
  state.language = "";
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function splitIntoSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return matches ? matches.map((sentence) => sentence.trim()).filter(Boolean) : [];
}

function splitLongUnit(unit, maxLength) {
  const normalized = normalizeText(unit);
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const words = normalized.split(" ");
  const parts = [];
  let current = "";

  words.forEach((word) => {
    if (!word) {
      return;
    }
    if (word.length > maxLength) {
      if (current) {
        parts.push(current.trim());
        current = "";
      }
      for (let index = 0; index < word.length; index += maxLength) {
        parts.push(word.slice(index, index + maxLength));
      }
      return;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLength) {
      parts.push(current.trim());
      current = word;
      return;
    }

    current = candidate;
  });

  if (current) {
    parts.push(current.trim());
  }

  return parts;
}

function buildChunks(pages) {
  const chunks = [];
  const maxLength = 280;

  pages.forEach((pageText) => {
    const normalized = normalizeText(pageText);
    if (!normalized) {
      return;
    }

    const parts = splitIntoSentences(normalized);
    const units = (parts.length ? parts : [normalized]).flatMap((unit) =>
      splitLongUnit(unit, maxLength)
    );
    let current = "";

    units.forEach((unit) => {
      const candidate = current ? `${current} ${unit}` : unit;
      if (candidate.length > maxLength) {
        if (current) {
          chunks.push(current.trim());
          current = unit;
        } else {
          chunks.push(unit.trim());
          current = "";
        }
      } else {
        current = candidate;
      }
    });

    if (current) {
      chunks.push(current.trim());
    }
  });

  return chunks;
}

function detectLanguageFromText(text) {
  return new Promise((resolve) => {
    if (!chrome?.i18n?.detectLanguage) {
      resolve("");
      return;
    }

    chrome.i18n.detectLanguage(text, (result) => {
      if (chrome.runtime.lastError || !result?.languages?.length) {
        resolve("");
        return;
      }

      const best = result.languages
        .slice()
        .sort((a, b) => b.percentage - a.percentage)[0];
      resolve(best?.language || "");
    });
  });
}

function getPlaybackQuota() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "getPlaybackQuota" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Unable to read playback quota."));
        return;
      }
      resolve(response);
    });
  });
}

function addPlaybackUsage(seconds) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "addPlaybackUsage", seconds }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Unable to save playback usage."));
        return;
      }
      resolve(response);
    });
  });
}

function requestTtsBytes(text, speed = state.speed) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "synthesizeSpeech",
        text,
        speed: getEffectiveSpeed(speed),
        language: detectedLanguage,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok || !Array.isArray(response.bytes)) {
          reject(new Error(response?.error || "TTS request failed."));
          return;
        }
        resolve({
          bytes: response.bytes,
          mimeType: response.mimeType || "audio/mpeg",
        });
      }
    );
  });
}

async function prefetchNextChunk(nextIndex, token) {
  if (token !== playbackToken || nextIndex >= textChunks.length) {
    return;
  }
  if (
    prefetchedChunk &&
    prefetchedChunk.index === nextIndex &&
    prefetchedChunk.speed === state.speed
  ) {
    return;
  }
  if (prefetchPromise) {
    return prefetchPromise;
  }

  const chunkText = textChunks[nextIndex];
  const requestedSpeed = state.speed;
  prefetchPromise = requestTtsBytes(chunkText, requestedSpeed)
    .then((payload) => {
      if (token !== playbackToken) {
        return;
      }
      prefetchedChunk = {
        index: nextIndex,
        speed: requestedSpeed,
        payload,
      };
    })
    .catch(() => null)
    .finally(() => {
      prefetchPromise = null;
    });

  return prefetchPromise;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function readLocalStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function writeLocalStorage(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, () => resolve());
  });
}

async function getOrCreateDeviceToken() {
  const result = await readLocalStorage([DEVICE_TOKEN_KEY]);
  const existing = typeof result?.[DEVICE_TOKEN_KEY] === "string" ? result[DEVICE_TOKEN_KEY] : "";
  if (existing) {
    return existing;
  }
  const created =
    (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) ||
    `device_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await writeLocalStorage({ [DEVICE_TOKEN_KEY]: created });
  return created;
}

function setPaywallStatus(text, ok = false) {
  paywallStatusEl.textContent = text;
  paywallStatusEl.style.color = ok ? "#24553a" : "#6f665c";
}

function updateAuthUI() {
  authCopyEl.classList.toggle("hidden", authState.signedIn);
  authGoogleBtn.classList.toggle("hidden", authState.signedIn);
  authSignedInEl.classList.toggle("hidden", !authState.signedIn);
  authSignedInTextEl.textContent = authState.signedIn
    ? `Signed in as ${authState.email}`
    : "";
  authMessageEl.textContent = authState.signedIn
    ? ""
    : !currentSubscription?.active && getLiveRemainingSeconds() <= 0
    ? "Your free trial has ended. Pay for a plan to keep listening."
    : "Use your free trial first. Sign in with Google when you want to buy a plan.";
  updateUI();
}

async function loadAuthState() {
  try {
    const result = await sendRuntimeMessage({ type: "getAuthState" });
    authState = {
      signedIn: !!result.signedIn,
      email: result.email || "",
      method: result.method || null,
    };
  } catch (_error) {
    authState = { signedIn: false, email: "", method: null };
  }
  updateAuthUI();
}

async function refreshQuotaSnapshot() {
  if (state.status === "reading" || state.status === "paused") {
    return;
  }

  try {
    const quota = await getPlaybackQuota();
    if (Number.isFinite(Number(quota.minFreePlaybackStartSeconds))) {
      minFreePlaybackStartSeconds = Math.max(0, Number(quota.minFreePlaybackStartSeconds));
    }
    if (Number.isFinite(Number(quota.remainingSeconds))) {
      lastKnownRemainingSeconds = Math.max(0, Number(quota.remainingSeconds));
      sessionRemainingSeconds = null;
      updateUI();
    }
  } catch (_error) {
    // Keep the last known UI state if quota refresh fails.
  }
}

async function signInWithGoogle() {
  authGoogleBtn.disabled = true;
  authGoogleBtn.textContent = "Opening Google...";
  try {
    await sendRuntimeMessage({
      type: "startGoogleSignIn",
      returnUrl: chrome.runtime.getURL("paywall.html"),
    });
    setPaywallStatus("Complete Google sign-in in the opened tab. The extension page will reopen automatically.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to start Google sign-in.");
  } finally {
    authGoogleBtn.disabled = false;
    authGoogleBtn.textContent = "Continue with Google";
  }
}

async function startGoogleSignInFromPaywall() {
  continueCheckoutBtn.disabled = true;
  const initialLabel = continueCheckoutBtn.textContent;
  continueCheckoutBtn.textContent = "Opening Google...";
  try {
    const deviceToken = await getOrCreateDeviceToken();
    const target = new URL(`${REMOTE_API_BASE_URL}/auth/google/start`);
    target.searchParams.set("device_token", deviceToken);
    target.searchParams.set("return_url", chrome.runtime.getURL("paywall.html"));
    chrome.tabs.create({ url: target.toString() });
    setPaywallStatus(
      "Complete Google sign-in in the opened tab. The extension page will reopen automatically."
    );
  } catch (error) {
    setPaywallStatus(error.message || "Unable to start Google sign-in.");
  } finally {
    continueCheckoutBtn.disabled = false;
    continueCheckoutBtn.textContent = initialLabel;
  }
}

async function signOutAccount() {
  try {
    const result = await sendRuntimeMessage({ type: "signOut" });
    authState = {
      signedIn: !!result.signedIn,
      email: result.email || "",
      method: result.method || null,
    };
    setPaywallStatus("Signed out. Sign in again before checkout.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to sign out.");
  }
  updateAuthUI();
}

function renderPaywallSelection() {
  planCardEls.forEach((card) => {
    const planId = card.dataset.planId || "";
    card.classList.toggle("selected", planId === selectedPlanId);
  });
  updateUI();
}

async function loadSubscriptionStatus() {
  setPaywallStatus("Checking subscription status...");
  try {
    const result = await sendRuntimeMessage({ type: "refreshSubscriptionStatus" });
    currentSubscription = result || { active: false, plan: null };
    if (currentSubscription.active) {
      const currentPlanId = currentSubscription.plan?.planId || "";
      if (currentPlanId) {
        selectedPlanId = currentPlanId;
      }
      setPaywallStatus("Subscription active on this device.", true);
    } else {
    setPaywallStatus(
      authState.signedIn
        ? "No active subscription detected."
        : "Sign in before checkout to keep your paid plan attached to your account."
    );
    }
    renderPaywallSelection();
  } catch (error) {
    setPaywallStatus(error.message || "Failed to load subscription status.");
  }
}

function openPaywall() {
  paywallModal.classList.remove("hidden");
  if (!currentSubscription?.active && getLiveRemainingSeconds() <= 0) {
    setPaywallStatus("Your free trial has ended. Pay for a plan to keep listening.");
  }
  void loadAuthState().then(() => {
    loadSubscriptionStatus();
  });
}

function closePaywall() {
  paywallModal.classList.add("hidden");
}

async function openCheckoutForSelectedPlan() {
  if (!authState.signedIn) {
    setPaywallStatus("Continue with Google before checkout.");
    await startGoogleSignInFromPaywall();
    return;
  }

  await loadAuthState();

  if (!authState.signedIn) {
    setPaywallStatus("Continue with Google before checkout.");
    await signInWithGoogle();
    return;
  }

  continueCheckoutBtn.disabled = true;
  setPaywallStatus("Creating Stripe Checkout session...");
  try {
    const result = await sendRuntimeMessage({
      type: "createCheckoutSession",
      planId: selectedPlanId,
      returnUrl: chrome.runtime.getURL("paywall.html"),
    });
    if (!result.url) {
      throw new Error("Checkout URL is missing.");
    }
    chrome.tabs.create({ url: result.url });
    setPaywallStatus("Stripe Checkout opened in a new tab.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to open checkout.");
  } finally {
    continueCheckoutBtn.disabled = false;
  }
}

function formatRemainingSeconds(seconds) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${Math.ceil(safeSeconds)} sec`;
}

function paywallReachedMessage() {
  return "Your free trial has ended. Pay for a plan to keep listening.";
}

async function exhaustPlaybackQuota(token = playbackToken) {
  if (token !== playbackToken) {
    return;
  }
  const usage = await commitPlaybackUsage().catch(() => null);
  const remainingSeconds = Number(usage?.remainingSeconds);
  if (Number.isFinite(remainingSeconds) && remainingSeconds > 0) {
    await addPlaybackUsage(remainingSeconds).catch(() => null);
  }
  lastKnownRemainingSeconds = 0;
  sessionRemainingSeconds = 0;
}

function getEffectiveSpeed(value = state.speed) {
  const baseSpeed = Number.isFinite(value) ? value : 1;
  if (typeof detectedLanguage === "string" && detectedLanguage.toLowerCase().startsWith("ru")) {
    return Math.min(2, baseSpeed * 1.2);
  }
  return baseSpeed;
}

function showPaywallLimitReached() {
  stopPlaybackUiTimer();
  setStatus("error", paywallReachedMessage());
  updateUI();
  openPaywall();
}

async function commitPlaybackUsage() {
  captureActivePlaybackDelta();
  const elapsedSeconds = pendingUsageSeconds;
  pendingUsageSeconds = 0;
  if (elapsedSeconds <= 0) {
    return null;
  }

  const optimisticBaseSeconds = Number.isFinite(sessionRemainingSeconds)
    ? sessionRemainingSeconds
    : lastKnownRemainingSeconds;
  const optimisticRemainingSeconds = Math.max(0, optimisticBaseSeconds - elapsedSeconds);

  try {
    const result = await addPlaybackUsage(elapsedSeconds);
    if (Number.isFinite(Number(result?.remainingSeconds))) {
      lastKnownRemainingSeconds = Math.max(0, Number(result.remainingSeconds));
      sessionRemainingSeconds = lastKnownRemainingSeconds;
    } else {
      lastKnownRemainingSeconds = optimisticRemainingSeconds;
      sessionRemainingSeconds = optimisticRemainingSeconds;
    }
    return result;
  } catch (_error) {
    lastKnownRemainingSeconds = optimisticRemainingSeconds;
    sessionRemainingSeconds = optimisticRemainingSeconds;
    return {
      remainingSeconds: optimisticRemainingSeconds,
      localOnly: true,
    };
  }
}

async function enforcePaywallBeforePlayback() {
  if (Number.isFinite(sessionRemainingSeconds)) {
    const remainingSeconds = Math.max(0, sessionRemainingSeconds);
    lastKnownRemainingSeconds = remainingSeconds;
    if (remainingSeconds <= 0) {
      showPaywallLimitReached();
      return { allowed: false, remainingSeconds: 0 };
    }
    return { allowed: true, remainingSeconds };
  }

  const quota = await getPlaybackQuota();
  if (Number.isFinite(Number(quota.minFreePlaybackStartSeconds))) {
    minFreePlaybackStartSeconds = Math.max(0, Number(quota.minFreePlaybackStartSeconds));
  }
  const quotaRemainingSeconds = Number(quota.remainingSeconds);
  let remainingSeconds = quotaRemainingSeconds;
  if (Number.isFinite(quotaRemainingSeconds)) {
    const normalizedQuotaSeconds = Math.max(0, quotaRemainingSeconds);
    remainingSeconds =
      Number.isFinite(lastKnownRemainingSeconds) && lastKnownRemainingSeconds > 0
        ? Math.min(lastKnownRemainingSeconds, normalizedQuotaSeconds)
        : normalizedQuotaSeconds;
    lastKnownRemainingSeconds = remainingSeconds;
    sessionRemainingSeconds = remainingSeconds;
  }
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
    showPaywallLimitReached();
    return { allowed: false, remainingSeconds: 0 };
  }
  if (!currentSubscription?.active && remainingSeconds <= minFreePlaybackStartSeconds) {
    lastKnownRemainingSeconds = 0;
    sessionRemainingSeconds = 0;
    showPaywallLimitReached();
    return { allowed: false, remainingSeconds: 0 };
  }
  return { allowed: true, remainingSeconds };
}

async function openPdfDocument(arrayBuffer) {
  if (!pdfjs) {
    throw new Error("PDF engine not available.");
  }

  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
  return loadingTask.promise;
}

function appendPreparedPage(pageText) {
  const nextChunks = buildChunks([pageText]);
  if (!nextChunks.length) {
    return false;
  }
  textChunks.push(...nextChunks);
  state.totalChunks = textChunks.length;
  return true;
}

async function waitForPreparedChunks(token) {
  if (token !== playbackToken) {
    return;
  }
  if (currentChunkIndex < textChunks.length) {
    await speakCurrentChunk(token);
    return;
  }
  if (preparationComplete) {
    state.currentChunk = textChunks.length;
    cleanupCurrentAudio();
    resetSessionQuotaTracking();
    setStatus("finished", `${state.fileName || "PDF"} finished.`);
    return;
  }
  setStatus("loading", "Preparing more pages...");
  setTimeout(() => {
    void waitForPreparedChunks(token);
  }, 250);
}

async function prepareSelectedFile(file) {
  if (!file) {
    return;
  }

  resetPreparedText();
  state.fileName = file.name || "";
  setStatus("loading", "Preparing PDF text...");

  try {
    isPreparingText = true;
    preparationComplete = false;
    currentFileBuffer = await file.arrayBuffer();
    const pdf = await openPdfDocument(currentFileBuffer.slice(0));
    state.totalPages = pdf.numPages;
    state.currentChunk = 0;
    let languageQueued = false;
    let firstChunkReady = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => item.str)
        .filter(Boolean)
        .join(" ");
      const addedChunks = appendPreparedPage(pageText);

      if (addedChunks && !languageQueued) {
        languageQueued = true;
        const sample = textChunks.slice(0, 3).join(" ").slice(0, 1000);
        void detectLanguageFromText(sample).then((language) => {
          detectedLanguage = language;
          state.language = detectedLanguage;
          updateUI();
        });
      }

      if (addedChunks && !firstChunkReady) {
        firstChunkReady = true;
        if (pendingStartPlayback) {
          pendingStartPlayback = false;
          playbackToken += 1;
          void speakCurrentChunk(playbackToken);
        } else {
          setStatus("idle", `${file.name} is ready. Preparing remaining pages...`);
        }
      }
    }

    preparationComplete = true;
    isPreparingText = false;

    if (!textChunks.length) {
      setStatus("error", "No selectable text found. This PDF might be scanned.");
      return;
    }

    if (!detectedLanguage) {
      const sample = textChunks.slice(0, 3).join(" ").slice(0, 1000);
      detectedLanguage = await detectLanguageFromText(sample);
      state.language = detectedLanguage;
    }

    if (state.status !== "reading" && state.status !== "paused") {
      setStatus("idle", `${file.name} is ready to read.`);
    }
  } catch (error) {
    const details = error && error.message ? error.message : "Unable to prepare the PDF.";
    currentFileBuffer = null;
    isPreparingText = false;
    preparationComplete = false;
    setStatus("error", details);
  }
}

async function handleAudioEnded(token) {
  if (token !== playbackToken || state.status !== "reading") {
    return;
  }

  if (paywallStopTimer) {
    clearTimeout(paywallStopTimer);
    paywallStopTimer = null;
  }
  const usage = await commitPlaybackUsage().catch(() => null);
  if (usage && Number(usage.remainingSeconds) <= 0) {
    cleanupCurrentAudio();
    lastKnownRemainingSeconds = 0;
    sessionRemainingSeconds = 0;
    resetSessionQuotaTracking();
    showPaywallLimitReached();
    return;
  }
  currentChunkIndex += 1;

  if (currentChunkIndex >= textChunks.length) {
    await waitForPreparedChunks(token);
    return;
  }

  await speakCurrentChunk(token);
}

async function speakCurrentChunk(token = playbackToken) {
  if (token !== playbackToken) {
    return;
  }

  if (!textChunks.length) {
    setStatus("error", "Upload a PDF with selectable text first.");
    return;
  }

  while (currentChunkIndex < textChunks.length && !textChunks[currentChunkIndex]) {
    currentChunkIndex += 1;
  }

  if (currentChunkIndex >= textChunks.length) {
    await waitForPreparedChunks(token);
    return;
  }

  state.currentChunk = currentChunkIndex + 1;

  let quota;
  try {
    quota = await enforcePaywallBeforePlayback();
  } catch (error) {
    const details = error && error.message ? error.message : "Unable to validate playback quota.";
    setStatus("error", details);
    return;
  }

  if (!quota.allowed) {
    return;
  }

  setStatus("loading", `Generating audio... ${formatRemainingSeconds(quota.remainingSeconds)} left`);

  let payload;
  try {
    currentAudioBaseSpeed = getEffectiveSpeed(state.speed);
    if (
      prefetchedChunk &&
      prefetchedChunk.index === currentChunkIndex &&
      prefetchedChunk.speed === state.speed
    ) {
      payload = prefetchedChunk.payload;
      prefetchedChunk = null;
    } else {
      payload = await requestTtsBytes(textChunks[currentChunkIndex]);
    }
  } catch (error) {
    const details = error && error.message ? error.message : "TTS request failed.";
    setStatus("error", details);
    return;
  }

  if (token !== playbackToken) {
    return;
  }

  cleanupCurrentAudio();
  currentAudio = new Audio();
  currentAudioUrl = URL.createObjectURL(
    new Blob([Uint8Array.from(payload.bytes)], { type: payload.mimeType })
  );
  currentAudio.src = currentAudioUrl;
  currentAudio.playbackRate = getEffectiveSpeed(state.speed);
  currentAudio.onended = () => {
    handleAudioEnded(token);
  };
  currentAudio.onerror = () => {
    cleanupCurrentAudio();
    setStatus("error", "Audio playback failed.");
  };

    lastActivePlaybackTickMs = Date.now();
    sessionRemainingSeconds = quota.remainingSeconds;
    schedulePaywallStop(token, quota.remainingSeconds);

  try {
    await currentAudio.play();
    lastActivePlaybackTickMs = Date.now();
    void prefetchNextChunk(currentChunkIndex + 1, token);
    updateReadingStatus();
    startPlaybackUiTimer();
    startPlaybackUsageFlushTimer();
  } catch (error) {
    cleanupCurrentAudio();
    const details = error && error.message ? error.message : "Unable to start audio playback.";
    setStatus("error", details);
  }
}

async function startPlayback() {
  if (!textChunks.length && isPreparingText) {
    pendingStartPlayback = true;
    setStatus("loading", "Preparing first pages...");
    return;
  }

  if (!textChunks.length) {
    setStatus("error", "Upload a PDF with selectable text first.");
    return;
  }

  if (state.status === "finished") {
    currentChunkIndex = 0;
  }

  pendingStartPlayback = false;
  playbackToken += 1;
  await speakCurrentChunk(playbackToken);
}

async function pausePlayback() {
  if (!currentAudio) {
    return;
  }

  if (state.status === "paused") {
    let quota;
    try {
      quota = await enforcePaywallBeforePlayback();
    } catch (error) {
      const details = error && error.message ? error.message : "Unable to validate playback quota.";
      setStatus("error", details);
      return;
    }
    if (!quota.allowed) {
      return;
    }
    lastActivePlaybackTickMs = Date.now();
    schedulePaywallStop(playbackToken, quota.remainingSeconds);
    await currentAudio.play();
    updateReadingStatus();
    startPlaybackUiTimer();
    startPlaybackUsageFlushTimer();
    return;
  }

  if (paywallStopTimer) {
    clearTimeout(paywallStopTimer);
    paywallStopTimer = null;
  }
  stopPlaybackUiTimer();
  currentAudio.pause();
  await commitPlaybackUsage().catch(() => null);
  setStatus("paused", state.fileName ? `Paused ${state.fileName}` : "Paused");
}

async function stopPlayback() {
  playbackToken += 1;
  await commitPlaybackUsage().catch(() => null);
  cleanupCurrentAudio();
  clearPrefetch();
  resetSessionQuotaTracking();
  currentChunkIndex = 0;
  state.currentChunk = 0;
  if (currentFileBuffer) {
    setStatus("idle", state.fileName ? `${state.fileName} is ready to read.` : "Ready");
    return;
  }
  setStatus("idle", "Upload a .pdf file to start reading.");
}

openFileBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  await prepareSelectedFile(file);
  event.target.value = "";
});

playBtn.addEventListener("click", () => {
  startPlayback();
});

pauseBtn.addEventListener("click", () => {
  pausePlayback();
});

stopBtn.addEventListener("click", () => {
  stopPlayback();
});

speedSelect.addEventListener("change", async (event) => {
  state.speed = Number.parseFloat(event.target.value) || 1;
  clearPrefetch();
  if (currentAudio) {
    currentAudio.playbackRate = getEffectiveSpeed(state.speed);
  }
  if (state.status === "reading") {
    setStatus("loading", "Updating speed...");
    if (paywallStopTimer) {
      clearTimeout(paywallStopTimer);
      paywallStopTimer = null;
    }
    setTimeout(() => {
      if (currentAudio && !currentAudio.paused) {
        updateReadingStatus();
        startPlaybackUiTimer();
      }
    }, 250);
    return;
  }
});

upgradeBtn.addEventListener("click", () => {
  openPaywall();
});

accountActionBtn.addEventListener("click", () => {
  openPaywall();
});

limitUpgradeBtn.addEventListener("click", () => {
  openPaywall();
});

contactBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "mailto:support@pdftext2speech.com" });
});

closePaywallBtn.addEventListener("click", () => {
  closePaywall();
});

continueCheckoutBtn.addEventListener("click", () => {
  if (!authState.signedIn) {
    void startGoogleSignInFromPaywall();
    return;
  }
  void openCheckoutForSelectedPlan();
});

authGoogleBtn.addEventListener("click", () => {
  signInWithGoogle();
});

authSignOutBtn.addEventListener("click", () => {
  signOutAccount();
});

planCardEls.forEach((card) => {
  card.addEventListener("click", () => {
    selectedPlanId = card.dataset.planId || selectedPlanId;
    renderPaywallSelection();
  });
});

window.addEventListener("focus", () => {
  void loadAuthState().then(() => {
    return refreshQuotaSnapshot();
  }).then(() => {
    if (!paywallModal.classList.contains("hidden")) {
      return loadSubscriptionStatus();
    }
    return null;
  });
});

updateUI();
void loadAuthState().then(() => refreshQuotaSnapshot());

window.addEventListener("beforeunload", () => {
  commitPlaybackUsage().catch(() => null);
  cleanupCurrentAudio();
});
