const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const playBtn = document.getElementById("play");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const speedSelect = document.getElementById("speed");
const openFileBtn = document.getElementById("openFile");
const fileInput = document.getElementById("fileInput");
const getPlanToggle = document.getElementById("getPlanToggle");
const contactToggle = document.getElementById("contactToggle");
const paywallCard = document.getElementById("paywallCard");
const paywallClose = document.getElementById("paywallClose");
const billingStatus = document.getElementById("billingStatus");
const planToggle = document.getElementById("planToggle");
const checkoutButton = document.getElementById("checkoutButton");
const addonSection = document.getElementById("addonSection");
const addonOptions = Array.from(document.querySelectorAll(".addon-option"));
const planOptions = Array.from(document.querySelectorAll(".plan-option"));
const portalButton = document.getElementById("portalButton");
const contactForm = document.getElementById("contactForm");
const contactEmail = document.getElementById("contactEmail");
const contactMessage = document.getElementById("contactMessage");
const contactSend = document.getElementById("contactSend");
const contactCancel = document.getElementById("contactCancel");
const contactClose = document.getElementById("contactClose");
const contactStatus = document.getElementById("contactStatus");
const tokenInfo = document.getElementById("tokenInfo");
const devResetTrialBtn = document.getElementById("devResetTrial");

const API_CONFIG = window.PDF_TTS_CONFIG || {};
const API_BASE_URL = (API_CONFIG.apiBaseUrl || "").replace(/\/$/, "");
const AI_TTS_ENDPOINT =
  API_CONFIG.aiEndpoint || (API_BASE_URL ? `${API_BASE_URL}/tts` : "");
const AI_DEFAULT_VOICE = API_CONFIG.aiDefaultVoice || "alloy";

const STATUS_LABELS = {
  idle: "Ready",
  loading: "Preparing",
  reading: "Reading",
  paused: "Paused",
  finished: "Finished",
  limited: "Limit reached",
  error: "Unable to read",
};

const localState = {
  status: "idle",
  speed: 1,
  message: "Select a PDF file to start.",
  language: "",
};

let mode = "tab";
let localChunks = [];
let localChunkIndex = 0;
let localLanguage = "";
let localVoice = null;
let localVoices = [];
let localRestartOnResume = false;
let localSkipNextEnd = false;
let pdfjsModule = null;
let pdfjsLoading = null;
let lastKnownState = null;
let lastKnownMode = null;
let aiEnabled = isAiAvailable();
let localAiAudio = null;
let localAiAbortController = null;
let localAiCurrentUrl = null;
let localAiPlaybackToken = 0;
let localAiRestartOnResume = false;
let localAiSkipNextEnd = false;
let localAiPrefetch = null;
let localAiPrefetchController = null;
let localAiCurrentBaseSpeed = 1;
let accountState = {
  status: "unknown",
  minutesLeft: null,
  paid: false,
  subscriptionStatus: "none",
  plan: null,
  trialActive: false,
  portalAvailable: false,
};
let deviceTokenPromise = null;
let selectedPlan = "annual";
let isPaywallOpen = false;
let isContactOpen = false;
let resolvedApiBase = API_BASE_URL;

function setMode(nextMode) {
  mode = nextMode;
  if (mode === "local") {
    openFileBtn.classList.remove("hidden");
  } else {
    openFileBtn.classList.add("hidden");
  }
}

function isApiConfigured() {
  return Boolean(API_BASE_URL);
}

function isLocalApiBase(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl);
}

function getApiBaseCandidates() {
  if (!API_BASE_URL) {
    return [];
  }
  const candidates = [API_BASE_URL];
  if (API_BASE_URL.includes("localhost")) {
    candidates.push(API_BASE_URL.replace("localhost", "127.0.0.1"));
  } else if (API_BASE_URL.includes("127.0.0.1")) {
    candidates.push(API_BASE_URL.replace("127.0.0.1", "localhost"));
  }
  return Array.from(new Set(candidates));
}

function buildApiUrl(baseUrl, path) {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function updateDevToolsVisibility() {
  if (!devResetTrialBtn) {
    return;
  }
  const shouldShow = isLocalApiBase(API_BASE_URL);
  devResetTrialBtn.classList.toggle("hidden", !shouldShow);
}

function createDeviceToken() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `device_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getDeviceToken() {
  if (deviceTokenPromise) {
    return deviceTokenPromise;
  }
  deviceTokenPromise = new Promise((resolve) => {
    chrome.storage.local.get(["deviceToken"], (result) => {
      if (result?.deviceToken) {
        resolve(result.deviceToken);
        return;
      }
      const nextToken = createDeviceToken();
      chrome.storage.local.set({ deviceToken: nextToken }, () => {
        resolve(nextToken);
      });
    });
  });
  return deviceTokenPromise;
}

async function apiFetch(path, options = {}) {
  if (!isApiConfigured()) {
    throw new Error("API not configured");
  }
  const token = await getDeviceToken();
  const headers = {
    ...(options.headers || {}),
    "x-device-token": token,
  };
  const baseCandidates = getApiBaseCandidates();
  const prioritizedBases = resolvedApiBase
    ? [resolvedApiBase, ...baseCandidates.filter((base) => base !== resolvedApiBase)]
    : baseCandidates;

  let lastNetworkError = null;
  for (const baseUrl of prioritizedBases) {
    const url = buildApiUrl(baseUrl, path);
    try {
      const response = await fetch(url, { ...options, headers });
      resolvedApiBase = baseUrl;
      return response;
    } catch (error) {
      lastNetworkError = error;
    }
  }
  throw lastNetworkError || new Error("API request failed");
}

function updateAccountUI() {
  const { status, paid, minutesLeft, trialActive, portalAvailable } =
    accountState;
  if (!isApiConfigured()) {
    if (billingStatus) {
      billingStatus.textContent = "Billing not configured.";
      billingStatus.classList.remove("hidden");
    }
    paywallCard.classList.add("hidden");
    portalButton.classList.add("hidden");
    tokenInfo.classList.add("hidden");
    return;
  }

  if (status === "loading") {
    if (billingStatus) {
      billingStatus.textContent = "Checking access...";
      billingStatus.classList.remove("hidden");
    }
    paywallCard.classList.add("hidden");
    portalButton.classList.add("hidden");
    tokenInfo.classList.add("hidden");
    return;
  }

  if (status === "error") {
    if (billingStatus) {
      billingStatus.textContent = "Unable to load account.";
      billingStatus.classList.remove("hidden");
    }
    portalButton.classList.add("hidden");
    tokenInfo.classList.add("hidden");
    paywallCard.classList.toggle("hidden", !isPaywallOpen);
    return;
  }

  const noMinutes = typeof minutesLeft === "number" && minutesLeft <= 0;
  const showAddons = paid && noMinutes;

  if (billingStatus) {
    billingStatus.textContent = paid
      ? noMinutes
        ? "Subscription active. No minutes left."
        : "Subscription active."
      : trialActive
      ? "Trial active."
      : "No active subscription.";
    billingStatus.classList.remove("hidden");
  }

  paywallCard.classList.toggle("hidden", !isPaywallOpen);
  planToggle.classList.toggle("hidden", paid);
  checkoutButton.classList.toggle("hidden", paid);
  addonSection.classList.toggle("hidden", !showAddons);
  portalButton.classList.toggle("hidden", !portalAvailable);
  if (trialActive) {
    getPlanToggle.classList.add("ghost");
    getPlanToggle.classList.remove("secondary");
  } else {
    getPlanToggle.classList.remove("ghost");
    getPlanToggle.classList.add("secondary");
  }

  if (paid && typeof minutesLeft === "number") {
    tokenInfo.textContent = `Minutes left: ${minutesLeft}`;
    tokenInfo.classList.remove("hidden");
  } else {
    tokenInfo.classList.add("hidden");
  }
}

async function refreshAccount() {
  if (!isApiConfigured()) {
    accountState = {
      status: "unavailable",
      minutesLeft: null,
      paid: false,
      subscriptionStatus: "none",
      plan: null,
      trialActive: false,
      portalAvailable: false,
    };
    updateAccountUI();
    return;
  }
  accountState.status = "loading";
  updateAccountUI();
  try {
    const response = await apiFetch("/me");
    if (!response.ok) {
      throw new Error("Account request failed");
    }
    const data = await response.json();
    const minutesLeft =
      typeof data.minutesLeft === "number" ? data.minutesLeft : null;
    const paid = Boolean(data.paid || data.subscriptionStatus === "active");
    const trialActive =
      !paid && typeof minutesLeft === "number" && minutesLeft > 0;
    accountState = {
      status: "ready",
      minutesLeft,
      paid,
      subscriptionStatus: data.subscriptionStatus || "none",
      plan: data.plan || null,
      trialActive,
      portalAvailable: Boolean(data.portalAvailable || data.subscriptionStatus === "active"),
    };
  } catch (error) {
    accountState = {
      status: "error",
      minutesLeft: null,
      paid: false,
      subscriptionStatus: "none",
      plan: null,
      trialActive: false,
      portalAvailable: false,
    };
  }
  updateAccountUI();
}

async function openCheckout(plan) {
  if (!isApiConfigured()) {
    if (billingStatus) {
      billingStatus.textContent = "Billing is not configured.";
      billingStatus.classList.remove("hidden");
    }
    return;
  }
  try {
    const response = await apiFetch("/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    if (!response.ok) {
      let message = "Unable to open checkout.";
      try {
        const data = await response.json();
        if (data?.error) {
          message = `Checkout error: ${data.error}`;
        }
      } catch (error) {
        // ignore parsing
      }
      if (billingStatus) {
        billingStatus.textContent = message;
        billingStatus.classList.remove("hidden");
      }
      return;
    }
    const data = await response.json();
    if (data?.url && chrome?.tabs?.create) {
      chrome.tabs.create({ url: data.url });
    }
  } catch (error) {
    if (billingStatus) {
      const message = error?.message
        ? `Unable to open checkout: ${error.message}`
        : "Unable to open checkout.";
      billingStatus.textContent = message;
      billingStatus.classList.remove("hidden");
    }
  }
}

async function resetTrialForTesting() {
  if (!isApiConfigured()) {
    return;
  }
  try {
    const response = await apiFetch("/dev/reset-trial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 5 }),
    });
    if (!response.ok) {
      let errorMessage = "Unable to reset test minutes.";
      try {
        const data = await response.json();
        if (data?.error) {
          errorMessage = data.error;
        }
      } catch (error) {
        // ignore
      }
      if (billingStatus) {
        billingStatus.textContent = errorMessage;
        billingStatus.classList.remove("hidden");
      }
      return;
    }
    if (billingStatus) {
      billingStatus.textContent = "Test minutes reset to 5.";
      billingStatus.classList.remove("hidden");
    }
    await refreshAccount();
  } catch (error) {
    if (billingStatus) {
      billingStatus.textContent =
        "Unable to reset test minutes. Is ai-server running?";
      billingStatus.classList.remove("hidden");
    }
  }
}

async function openPortal() {
  if (!isApiConfigured()) {
    return;
  }
  try {
    const response = await apiFetch("/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error("Portal failed");
    }
    const data = await response.json();
    if (data?.url && chrome?.tabs?.create) {
      chrome.tabs.create({ url: data.url });
    }
  } catch (error) {
    if (billingStatus) {
      billingStatus.textContent = "Unable to open portal.";
      billingStatus.classList.remove("hidden");
    }
  }
}

function setSelectedPlan(plan) {
  selectedPlan = plan;
  planOptions.forEach((option) => {
    option.classList.toggle("selected", option.dataset.plan === plan);
  });
}

function updatePanels() {
  const shouldShowPaywall = isPaywallOpen;
  paywallCard.classList.toggle("hidden", !shouldShowPaywall);
  contactForm.classList.toggle("hidden", !isContactOpen);
}

function setPaywallOpen(open) {
  isPaywallOpen = open;
  if (open) {
    isContactOpen = false;
  }
  updatePanels();
}

function setContactOpen(open) {
  isContactOpen = open;
  if (open) {
    isPaywallOpen = false;
  }
  updatePanels();
}

function setContactStatus(message, isError = false) {
  if (!contactStatus) {
    return;
  }
  contactStatus.textContent = message;
  contactStatus.classList.remove("hidden");
  contactStatus.style.color = isError ? "#dc2626" : "#64748b";
}

function toggleContactForm(show) {
  setContactOpen(show);
  if (!show) {
    setContactStatus("", false);
    contactStatus.classList.add("hidden");
  }
}

async function ensureAccess() {
  if (!isApiConfigured()) {
    if (billingStatus) {
      billingStatus.textContent = "Billing is not configured.";
      billingStatus.classList.remove("hidden");
    }
    return false;
  }
  await refreshAccount();
  if (accountState.trialActive) {
    return true;
  }
  if (accountState.paid) {
    return true;
  }
  if (typeof accountState.minutesLeft === "number" && accountState.minutesLeft > 0) {
    return true;
  }
  if (billingStatus) {
    billingStatus.textContent = "No minutes left. Choose a plan to continue.";
    billingStatus.classList.remove("hidden");
  }
  setPaywallOpen(true);
  return false;
}
function isAiAvailable() {
  return Boolean(AI_TTS_ENDPOINT);
}

function updateUI(state, nextMode = mode) {
  if (!state) {
    statusEl.textContent = "Open a PDF to start";
    hintEl.textContent = "Make sure the active tab is a PDF.";
    playBtn.disabled = true;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
    speedSelect.disabled = true;
    openFileBtn.classList.add("hidden");
    return;
  }

  lastKnownState = state;
  lastKnownMode = nextMode;
  const label = STATUS_LABELS[state.status] || "Ready";
  statusEl.textContent = label;
  hintEl.textContent = state.message || " ";

  if (state.speed) {
    speedSelect.value = String(state.speed);
  }

  pauseBtn.textContent = state.status === "paused" ? "Resume" : "Pause";
  playBtn.textContent = state.status === "finished" ? "Read Again" : "Read Aloud";
  if (nextMode === "local") {
    playBtn.disabled = state.status === "loading";
  } else {
    playBtn.disabled = state.status === "reading" || state.status === "loading";
  }
  pauseBtn.disabled = !(state.status === "reading" || state.status === "paused");
  stopBtn.disabled = !(state.status === "reading" || state.status === "paused");
  speedSelect.disabled = state.status === "loading";
  if (!isAiAvailable()) {
    playBtn.disabled = true;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
  }

  if (state.status === "limited") {
    setPaywallOpen(true);
    refreshAccount();
  }
}

function setLocalStatus(status, message = "") {
  localState.status = status;
  localState.message = message || localState.message;
  setMode("local");
  updateUI(localState, "local");
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function sendMessageInternal(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError });
        return;
      }
      resolve({ response });
    });
  });
}

function injectContentScript(tabId) {
  return new Promise((resolve) => {
    if (!chrome.scripting?.executeScript) {
      resolve(false);
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["config.js", "contentScript.js"],
      },
      () => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      }
    );
  });
}

async function sendMessageToTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    updateUI(null);
    return null;
  }

  const initial = await sendMessageInternal(tab.id, message);
  if (!initial.error) {
    if (initial.response?.state) {
      setMode("tab");
      updateUI(initial.response.state, "tab");
    }
    return initial.response;
  }

  const injected = await injectContentScript(tab.id);
  if (!injected) {
    if (lastKnownState) {
      updateUI(lastKnownState, lastKnownMode || mode);
    } else {
      updateUI(null);
    }
    return null;
  }

  const retry = await sendMessageInternal(tab.id, message);
  if (retry.error) {
    if (lastKnownState) {
      updateUI(lastKnownState, lastKnownMode || mode);
    } else {
      updateUI(null);
    }
    return null;
  }
  if (retry.response?.state) {
    setMode("tab");
    updateUI(retry.response.state, "tab");
  }
  return retry.response;
}

async function refreshState() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setLocalStatus("idle", "Select a PDF file to start.");
    return;
  }
  const response = await sendMessageToTab({ type: "getState" });
  if (response?.state) {
    setMode("tab");
    updateUI(response.state, "tab");
    aiEnabled = isAiAvailable();
    if (isAiAvailable() && response.state.ttsMode !== "ai") {
      await sendMessageToTab({ type: "setTtsMode", mode: "ai" });
    }
    if (!isAiAvailable()) {
      hintEl.textContent = "AI voice requires server setup.";
    }
    return;
  }
  if (tab.url?.startsWith("file://")) {
    setLocalStatus(
      "idle",
      "Local file detected. Enable file access or open the PDF here."
    );
    return;
  }
  setLocalStatus("idle", "Select a PDF file to start.");
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function splitIntoSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!matches) {
    return [];
  }
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function buildChunks(pages, options = {}) {
  const chunks = [];
  const maxLength = 900;
  const firstChunkMaxLength = 400;
  const useFirstChunkLimit = options.useFirstChunkLimit !== false;

  pages.forEach((pageText) => {
    const normalized = normalizeText(pageText);
    if (!normalized) {
      return;
    }
    const sentences = splitIntoSentences(normalized);
    const parts = sentences.length ? sentences : [normalized];
    let current = "";

    parts.forEach((sentence) => {
      const candidate = current ? `${current} ${sentence}` : sentence;
      const limit =
        chunks.length === 0 && useFirstChunkLimit
          ? firstChunkMaxLength
          : maxLength;
      if (candidate.length > limit) {
        if (current) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          chunks.push(sentence.trim());
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

async function detectLanguageFromText(text) {
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

function pickVoiceForLanguage(language) {
  if (!localVoices.length) {
    return null;
  }
  if (!language) {
    return localVoices.find((voice) => voice.default) || localVoices[0];
  }
  const lower = language.toLowerCase();
  const exact = localVoices.find(
    (voice) => voice.lang && voice.lang.toLowerCase() === lower
  );
  if (exact) {
    return exact;
  }
  const base = lower.split("-")[0];
  const partial = localVoices.find(
    (voice) => voice.lang && voice.lang.toLowerCase().startsWith(base)
  );
  return partial || localVoices.find((voice) => voice.default) || null;
}

function refreshVoices() {
  localVoices = speechSynthesis.getVoices() || [];
  if (!localVoice && localLanguage) {
    localVoice = pickVoiceForLanguage(localLanguage);
  }
}

if (speechSynthesis.onvoiceschanged !== undefined) {
  speechSynthesis.onvoiceschanged = refreshVoices;
}
refreshVoices();

async function loadPdfjs() {
  if (pdfjsModule) {
    return pdfjsModule;
  }
  if (!pdfjsLoading) {
    const moduleUrl = chrome.runtime.getURL(
      "node_modules/pdfjs-dist/legacy/build/pdf.min.mjs"
    );
    pdfjsLoading = import(moduleUrl)
      .then((module) => {
        pdfjsModule = module?.default || module;
        if (pdfjsModule?.GlobalWorkerOptions) {
          pdfjsModule.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
            "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"
          );
        }
        return pdfjsModule;
      })
      .catch((error) => {
        pdfjsLoading = null;
        throw error;
      });
  }
  return pdfjsLoading;
}

async function extractPdfTextFromBuffer(buffer) {
  const pdfjs = await loadPdfjs();
  if (!pdfjs?.getDocument) {
    throw new Error("PDF engine not available.");
  }
  const loadingTask = pdfjs.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => item.str)
      .filter(Boolean)
      .join(" ");
    pages.push(pageText);
  }

  return { pages, totalPages: pdf.numPages };
}

async function fetchAiAudio(text, language, speed, controller) {
  if (!AI_TTS_ENDPOINT) {
    throw new Error("AI voice is not configured.");
  }
  const usedController = controller || new AbortController();
  if (!controller) {
    localAiAbortController = usedController;
  }
  const payload = {
    input: text,
    text,
    speed,
    voice: AI_DEFAULT_VOICE,
    response_format: "mp3",
  };
  const token = await getDeviceToken();
  const response = await fetch(AI_TTS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-device-token": token,
    },
    body: JSON.stringify(payload),
    signal: usedController.signal,
  });
  if (!response.ok) {
    if (response.status === 402) {
      await refreshAccount();
      const error = new Error("not-enough-queries");
      error.code = "not-enough-queries";
      throw error;
    }
    if (response.status === 401) {
      const error = new Error("unauthorized");
      error.code = "unauthorized";
      throw error;
    }
    throw new Error("AI voice request failed.");
  }
  return response.blob();
}

function createLocalUtterance(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = localState.speed;
  if (localLanguage) {
    utterance.lang = localLanguage;
  }
  if (localVoice) {
    utterance.voice = localVoice;
  }
  utterance.onend = handleLocalUtteranceEnd;
  utterance.onerror = handleLocalUtteranceError;
  return utterance;
}

function handleLocalUtteranceEnd() {
  if (localSkipNextEnd) {
    localSkipNextEnd = false;
    return;
  }
  if (localState.status !== "reading") {
    return;
  }
  localChunkIndex += 1;
  if (localChunkIndex >= localChunks.length) {
    setLocalStatus("finished", "Finished reading this file.");
    return;
  }
  speakLocalChunk();
}

function handleLocalUtteranceError() {
  setLocalStatus("error", "Speech stopped unexpectedly.");
}

function stopLocalAiPlayback() {
  localAiPlaybackToken += 1;
  if (localAiAbortController) {
    localAiAbortController.abort();
    localAiAbortController = null;
  }
  if (localAiPrefetchController) {
    localAiPrefetchController.abort();
    localAiPrefetchController = null;
  }
  localAiPrefetch = null;
  if (localAiAudio) {
    localAiSkipNextEnd = true;
    localAiAudio.pause();
    localAiAudio = null;
  }
  if (localAiCurrentUrl) {
    URL.revokeObjectURL(localAiCurrentUrl);
    localAiCurrentUrl = null;
  }
  localAiCurrentBaseSpeed = 1;
}

function cancelLocalSpeech() {
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    localSkipNextEnd = true;
  } else {
    localSkipNextEnd = false;
  }
  speechSynthesis.cancel();
}

function startLocalAiPrefetch(index) {
  if (!isAiAvailable() || !localChunks.length) {
    return;
  }
  if (index < 0 || index >= localChunks.length) {
    return;
  }
  if (
    localAiPrefetch &&
    localAiPrefetch.index === index &&
    localAiPrefetch.speed === localState.speed
  ) {
    return;
  }
  if (localAiPrefetchController) {
    localAiPrefetchController.abort();
  }
  const chunk = localChunks[index];
  if (!chunk) {
    return;
  }
  const controller = new AbortController();
  localAiPrefetchController = controller;
  localAiPrefetch = {
    index,
    speed: localState.speed,
    promise: fetchAiAudio(chunk, localLanguage, localState.speed, controller),
  };
}

async function getLocalAiBlob(index) {
  if (!localChunks.length) {
    return null;
  }
  const speed = localState.speed;
  if (
    localAiPrefetch &&
    localAiPrefetch.index === index &&
    localAiPrefetch.speed === speed
  ) {
    try {
      const blob = await localAiPrefetch.promise;
      return { blob, baseSpeed: localAiPrefetch.speed };
    } finally {
      localAiPrefetch = null;
      localAiPrefetchController = null;
    }
  }
  const chunk = localChunks[index];
  if (!chunk) {
    return null;
  }
  const blob = await fetchAiAudio(chunk, localLanguage, speed);
  return { blob, baseSpeed: speed };
}

async function playLocalAiChunk() {
  if (!localChunks.length) {
    setLocalStatus("error", "No text available to read.");
    return;
  }
  if (localChunkIndex >= localChunks.length) {
    setLocalStatus("finished", "Finished reading this file.");
    return;
  }
  const chunk = localChunks[localChunkIndex];
  if (!chunk) {
    localChunkIndex += 1;
    playLocalAiChunk();
    return;
  }
  const token = localAiPlaybackToken;
  updateUI(localState, "local");
  try {
    const result = await getLocalAiBlob(localChunkIndex);
    if (
      token !== localAiPlaybackToken ||
      (localState.status !== "reading" && localState.status !== "loading")
    ) {
      return;
    }
    if (!result?.blob) {
      setLocalStatus("error", "AI voice failed.");
      return;
    }
    const { blob, baseSpeed } = result;
    const url = URL.createObjectURL(blob);
    localAiCurrentUrl = url;
    const audio = new Audio(url);
    localAiAudio = audio;
    localAiCurrentBaseSpeed = baseSpeed;
    audio.playbackRate = baseSpeed > 0 ? localState.speed / baseSpeed : 1;
    audio.onended = () => {
      if (localAiSkipNextEnd) {
        localAiSkipNextEnd = false;
        return;
      }
      URL.revokeObjectURL(url);
      localAiCurrentUrl = null;
      if (localState.status !== "reading") {
        return;
      }
      localChunkIndex += 1;
      startLocalAiPrefetch(localChunkIndex + 1);
      playLocalAiChunk();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      localAiCurrentUrl = null;
      setLocalStatus("error", "AI voice failed.");
    };
    await audio.play();
    setLocalStatus("reading", "");
    startLocalAiPrefetch(localChunkIndex + 1);
  } catch (error) {
    if (error?.code === "not-enough-queries") {
      setLocalStatus("error", "No minutes left. Open the extension to upgrade.");
      return;
    }
    setLocalStatus("error", "AI voice failed.");
  }
}

function speakLocalChunk() {
  if (!localChunks.length) {
    setLocalStatus("error", "No text available to read.");
    return;
  }
  if (localChunkIndex >= localChunks.length) {
    setLocalStatus("finished", "Finished reading this file.");
    return;
  }
  const chunk = localChunks[localChunkIndex];
  if (!chunk) {
    localChunkIndex += 1;
    speakLocalChunk();
    return;
  }
  updateUI(localState, "local");
  const utterance = createLocalUtterance(chunk);
  speechSynthesis.speak(utterance);
}

async function loadLocalFile(file) {
  if (!file) {
    return;
  }
  cancelLocalSpeech();
  stopLocalAiPlayback();
  localChunks = [];
  localChunkIndex = 0;
  localLanguage = "";
  localVoice = null;
  localRestartOnResume = false;
  localState.message = `Selected file: ${file.name}`;
  setLocalStatus("loading", "Loading PDF text...");
  try {
    const buffer = await file.arrayBuffer();
    const { pages } = await extractPdfTextFromBuffer(buffer);
    localChunks = buildChunks(pages);
    if (!localChunks.length) {
      setLocalStatus(
        "error",
        "No selectable text found. This PDF might be scanned."
      );
      return;
    }
    const sample = localChunks.slice(0, 3).join(" ").slice(0, 1000);
    localLanguage = await detectLanguageFromText(sample);
    localState.language = localLanguage;
    localVoice = pickVoiceForLanguage(localLanguage);
    localState.message = `Selected file: ${file.name}`;
    setLocalStatus("idle", localState.message);
    if (aiEnabled) {
      startLocalAiPrefetch(0);
    }
  } catch (error) {
    setLocalStatus("error", "Unable to read the selected file.");
  }
}

function startLocalAiReading() {
  if (!isAiAvailable()) {
    setLocalStatus("error", "AI voice is not configured.");
    return;
  }
  if (localState.status === "reading") {
    return;
  }
  if (localState.status === "paused") {
    resumeLocalAiReading();
    return;
  }
  if (!localChunks.length) {
    localState.message = "Select a PDF file to start.";
    updateUI(localState, "local");
    fileInput.click();
    return;
  }
  if (localState.status === "finished" || localState.status === "idle") {
    localChunkIndex = 0;
  }
  cancelLocalSpeech();
  stopLocalAiPlayback();
  setLocalStatus("loading", "Generating audio...");
  playLocalAiChunk();
}

function pauseLocalAiReading() {
  if (localState.status !== "reading") {
    return;
  }
  if (localAiAudio) {
    localAiAudio.pause();
  }
  setLocalStatus("paused", "");
}

function resumeLocalAiReading() {
  if (localState.status !== "paused") {
    return;
  }
  setLocalStatus("reading", "");
  if (localAiRestartOnResume) {
    localAiRestartOnResume = false;
    stopLocalAiPlayback();
    playLocalAiChunk();
    return;
  }
  if (localAiAudio) {
    localAiAudio.playbackRate =
      localAiCurrentBaseSpeed > 0
        ? localState.speed / localAiCurrentBaseSpeed
        : 1;
    localAiAudio.play();
  } else {
    playLocalAiChunk();
  }
}

function stopLocalAiReading() {
  stopLocalAiPlayback();
  localChunkIndex = 0;
  setLocalStatus("idle", localState.message);
}

function startLocalReading() {
  if (!isAiAvailable()) {
    setLocalStatus("error", "AI voice is not configured.");
    return;
  }
  startLocalAiReading();
}

function pauseLocalReading() {
  if (!isAiAvailable()) {
    setLocalStatus("error", "AI voice is not configured.");
    return;
  }
  pauseLocalAiReading();
}

function resumeLocalReading() {
  if (!isAiAvailable()) {
    setLocalStatus("error", "AI voice is not configured.");
    return;
  }
  resumeLocalAiReading();
}

function stopLocalReading() {
  if (!isAiAvailable()) {
    setLocalStatus("error", "AI voice is not configured.");
    return;
  }
  stopLocalAiReading();
}

function setLocalSpeed(speed) {
  if (!Number.isFinite(speed)) {
    return;
  }
  if (!isAiAvailable()) {
    return;
  }
  localState.speed = speed;
  if (aiEnabled) {
    if (localAiAudio) {
      localAiAudio.playbackRate =
        localAiCurrentBaseSpeed > 0
          ? localState.speed / localAiCurrentBaseSpeed
          : 1;
    }
    if (localAiPrefetchController) {
      localAiPrefetchController.abort();
      localAiPrefetchController = null;
      localAiPrefetch = null;
    }
    if (localState.status === "reading") {
      startLocalAiPrefetch(localChunkIndex + 1);
    }
    if (localState.status === "paused") {
      localAiRestartOnResume = false;
    }
    updateUI(localState, "local");
    return;
  }
  if (localState.status === "reading") {
    updateUI(localState, "local");
    return;
  }
  if (localState.status === "paused") {
    localRestartOnResume = true;
  }
  updateUI(localState, "local");
}

async function handleTabAction(message) {
  const response = await sendMessageToTab(message);
  if (response?.state) {
    setMode("tab");
    updateUI(response.state, "tab");
    return true;
  }
  return false;
}

playBtn.addEventListener("click", async () => {
  if (!isAiAvailable()) {
    statusEl.textContent = "AI voice is not configured.";
    hintEl.textContent = "Set apiBaseUrl or aiEndpoint in config.js.";
    return;
  }
  const hasAccess = await ensureAccess();
  if (!hasAccess) {
    return;
  }
  if (mode === "local") {
    startLocalReading();
    return;
  }
  if (isAiAvailable()) {
    await sendMessageToTab({ type: "setTtsMode", mode: "ai" });
  }
  const ok = await handleTabAction({ type: "start" });
  if (!ok) {
    setLocalStatus("idle", "Select a PDF file to start.");
    startLocalReading();
  }
});

pauseBtn.addEventListener("click", () => {
  if (pauseBtn.textContent === "Resume") {
    if (mode === "local") {
      resumeLocalReading();
    } else {
      sendMessageToTab({ type: "resume" });
    }
  } else {
    if (mode === "local") {
      pauseLocalReading();
    } else {
      sendMessageToTab({ type: "pause" });
    }
  }
});

stopBtn.addEventListener("click", () => {
  if (mode === "local") {
    stopLocalReading();
  } else {
    sendMessageToTab({ type: "stop" });
  }
});

speedSelect.addEventListener("change", (event) => {
  const speed = Number.parseFloat(event.target.value);
  if (mode === "local") {
    setLocalSpeed(speed);
  } else {
    sendMessageToTab({ type: "setSpeed", speed });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "stateUpdate" && mode === "tab") {
    updateUI(message.state, "tab");
  }
});

openFileBtn.addEventListener("click", () => {
  fileInput.click();
});

planOptions.forEach((option) => {
  option.addEventListener("click", () => {
    setSelectedPlan(option.dataset.plan || "monthly");
  });
});

if (getPlanToggle) {
  getPlanToggle.addEventListener("click", () => {
    setPaywallOpen(!isPaywallOpen);
  });
}

if (checkoutButton) {
  checkoutButton.addEventListener("click", () => {
    openCheckout(selectedPlan || "monthly");
  });
}

addonOptions.forEach((option) => {
  option.addEventListener("click", () => {
    const plan = option.dataset.plan;
    if (plan) {
      openCheckout(plan);
    }
  });
});

portalButton.addEventListener("click", () => {
  openPortal();
});

if (contactToggle) {
  contactToggle.addEventListener("click", () => {
    setContactOpen(!isContactOpen);
  });
}

if (paywallClose) {
  paywallClose.addEventListener("click", () => {
    setPaywallOpen(false);
  });
}

if (contactClose) {
  contactClose.addEventListener("click", () => {
    setContactOpen(false);
  });
}

if (contactCancel) {
  contactCancel.addEventListener("click", () => {
    toggleContactForm(false);
  });
}

if (contactSend) {
  contactSend.addEventListener("click", async () => {
    const email = contactEmail?.value?.trim() || "";
    const message = contactMessage?.value?.trim() || "";
    if (!email || !email.includes("@")) {
      setContactStatus("Enter a valid email address.", true);
      return;
    }
    if (!message || message.length < 3) {
      setContactStatus("Please enter a message.", true);
      return;
    }
    contactSend.disabled = true;
    setContactStatus("Sending...");
    try {
      const response = await apiFetch("/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, message }),
      });
      if (!response.ok) {
        let errorMessage = "Unable to send message.";
        try {
          const data = await response.json();
          if (data?.error) {
            errorMessage = data.error;
          }
        } catch (error) {
          // ignore
        }
        setContactStatus(errorMessage, true);
        return;
      }
      contactMessage.value = "";
      setContactStatus("Message sent. We'll reply by email.");
    } catch (error) {
      setContactStatus("Unable to send message.", true);
    } finally {
      contactSend.disabled = false;
    }
  });
}

if (devResetTrialBtn) {
  devResetTrialBtn.addEventListener("click", () => {
    resetTrialForTesting();
  });
}
fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  loadLocalFile(file);
});

document.addEventListener("DOMContentLoaded", () => {
  updateUI(null);
  if (!isAiAvailable()) {
    hintEl.textContent = "AI voice requires server setup.";
  }
  updateDevToolsVisibility();
  setSelectedPlan(selectedPlan);
  setPaywallOpen(false);
  setContactOpen(false);
  refreshAccount();
  refreshState();
});
