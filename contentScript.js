const FREE_MINUTES_LIMIT_MS = 15 * 60 * 1000;
const STORAGE_KEYS = {
  freeUsageMs: "freeUsageMs",
  subscriptionActive: "subscriptionActive",
};

const state = {
  status: "idle",
  speed: 1,
  message: "",
  totalPages: 0,
  totalChunks: 0,
  currentChunk: 0,
  language: "",
  freeUsageMs: 0,
  freeMinutesLeftMs: FREE_MINUTES_LIMIT_MS,
  freeMinutesTotalMs: FREE_MINUTES_LIMIT_MS,
  isSubscribed: false,
  paywallRequired: false,
};

const pdfjs = window.pdfjsLib;
let textChunks = [];
let currentChunkIndex = 0;
let isPreparing = false;
let skipNextEnd = false;
let restartOnResume = false;
let detectedLanguage = "";
let selectedVoice = null;
let availableVoices = [];

let freeUsageMs = 0;
let subscriptionActive = false;
let billingLoaded = false;
let usageSessionStartedAt = null;
let usageTicker = null;
let limitHandlingInProgress = false;

if (pdfjs?.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "node_modules/pdfjs-dist/build/pdf.worker.min.js"
  );
}

function refreshVoices() {
  availableVoices = speechSynthesis.getVoices() || [];
  if (!selectedVoice && detectedLanguage) {
    selectedVoice = pickVoiceForLanguage(detectedLanguage);
  }
}

if (speechSynthesis.onvoiceschanged !== undefined) {
  speechSynthesis.onvoiceschanged = refreshVoices;
}
refreshVoices();

function getStorage(keys) {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve({});
      return;
    }
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function setStorage(values) {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }
    chrome.storage.local.set(values, () => {
      resolve();
    });
  });
}

function getUsageWithCurrentSessionMs() {
  if (!usageSessionStartedAt) {
    return freeUsageMs;
  }
  return freeUsageMs + Math.max(Date.now() - usageSessionStartedAt, 0);
}

function getFreeMinutesLeftMs() {
  return Math.max(FREE_MINUTES_LIMIT_MS - getUsageWithCurrentSessionMs(), 0);
}

function isPaywallRequired() {
  return !subscriptionActive && getFreeMinutesLeftMs() <= 0;
}

function syncBillingState() {
  state.freeUsageMs = Math.floor(getUsageWithCurrentSessionMs());
  state.freeMinutesLeftMs = getFreeMinutesLeftMs();
  state.freeMinutesTotalMs = FREE_MINUTES_LIMIT_MS;
  state.isSubscribed = subscriptionActive;
  state.paywallRequired = isPaywallRequired();
}

async function ensureBillingLoaded() {
  if (billingLoaded) {
    return;
  }
  const stored = await getStorage([
    STORAGE_KEYS.freeUsageMs,
    STORAGE_KEYS.subscriptionActive,
  ]);
  const usageCandidate = Number(stored[STORAGE_KEYS.freeUsageMs]);
  freeUsageMs = Number.isFinite(usageCandidate) ? Math.max(usageCandidate, 0) : 0;
  subscriptionActive = Boolean(stored[STORAGE_KEYS.subscriptionActive]);
  billingLoaded = true;
  syncBillingState();
}

async function persistUsage() {
  await setStorage({
    [STORAGE_KEYS.freeUsageMs]: Math.floor(freeUsageMs),
  });
}

function startUsageSession() {
  if (subscriptionActive || usageSessionStartedAt || state.status !== "reading") {
    return;
  }
  usageSessionStartedAt = Date.now();
  syncBillingState();
}

async function flushUsageSession({ persist = true } = {}) {
  if (!usageSessionStartedAt) {
    syncBillingState();
    return;
  }
  const elapsedMs = Math.max(Date.now() - usageSessionStartedAt, 0);
  usageSessionStartedAt = null;
  freeUsageMs += elapsedMs;
  if (!subscriptionActive) {
    freeUsageMs = Math.min(freeUsageMs, FREE_MINUTES_LIMIT_MS);
  }
  syncBillingState();
  if (persist) {
    await persistUsage();
  }
}

function clearUsageTicker() {
  if (usageTicker) {
    clearInterval(usageTicker);
    usageTicker = null;
  }
}

async function handleLimitReached() {
  if (state.status === "limited" || limitHandlingInProgress) {
    return;
  }
  limitHandlingInProgress = true;
  try {
    cancelSpeech();
    clearUsageTicker();
    await flushUsageSession({ persist: true });
    currentChunkIndex = 0;
    state.currentChunk = 0;
    setStatus("limited", "Free minutes are over. Upgrade to continue reading.");
  } finally {
    limitHandlingInProgress = false;
  }
}

function ensureUsageTicker() {
  if (usageTicker) {
    return;
  }
  usageTicker = setInterval(() => {
    if (state.status !== "reading") {
      clearUsageTicker();
      return;
    }
    syncBillingState();
    if (isPaywallRequired()) {
      handleLimitReached();
      return;
    }
    sendStateUpdate();
  }, 1000);
}

function sendStateUpdate() {
  syncBillingState();
  chrome.runtime.sendMessage({ type: "stateUpdate", state });
}

function setStatus(status, message = "") {
  state.status = status;
  state.message = message;
  sendStateUpdate();
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

function buildChunks(pages) {
  const chunks = [];
  const maxLength = 1200;

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
      if (candidate.length > maxLength) {
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
  if (!availableVoices.length) {
    return null;
  }
  if (!language) {
    return (
      availableVoices.find((voice) => voice.default) || availableVoices[0]
    );
  }
  const lower = language.toLowerCase();
  const exact = availableVoices.find(
    (voice) => voice.lang && voice.lang.toLowerCase() === lower
  );
  if (exact) {
    return exact;
  }
  const base = lower.split("-")[0];
  const partial = availableVoices.find(
    (voice) => voice.lang && voice.lang.toLowerCase().startsWith(base)
  );
  return partial || availableVoices.find((voice) => voice.default) || null;
}

async function extractPdfText(url) {
  if (!pdfjs) {
    throw new Error("PDF engine not available.");
  }
  const loadingTask = pdfjs.getDocument({ url, withCredentials: true });
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

async function prepareText() {
  if (isPreparing) {
    return;
  }
  isPreparing = true;
  try {
    const { pages, totalPages } = await extractPdfText(window.location.href);
    state.totalPages = totalPages;
    textChunks = buildChunks(pages);
    state.totalChunks = textChunks.length;
    state.currentChunk = 0;

    if (!textChunks.length) {
      setStatus(
        "error",
        "No selectable text found. This PDF might be scanned."
      );
      isPreparing = false;
      return;
    }

    const sample = textChunks.slice(0, 3).join(" ").slice(0, 1000);
    detectedLanguage = await detectLanguageFromText(sample);
    state.language = detectedLanguage;
    selectedVoice = pickVoiceForLanguage(detectedLanguage);
    setStatus("idle", "");
  } catch (error) {
    const message =
      "Unable to access PDF text. For local files, enable file access in the extension settings.";
    setStatus("error", message);
  } finally {
    isPreparing = false;
  }
}

function createUtterance(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = state.speed;
  if (detectedLanguage) {
    utterance.lang = detectedLanguage;
  }
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }
  utterance.onend = handleUtteranceEnd;
  utterance.onerror = handleUtteranceError;
  return utterance;
}

async function handleUtteranceEnd() {
  if (skipNextEnd) {
    skipNextEnd = false;
    return;
  }
  if (state.status !== "reading") {
    return;
  }
  currentChunkIndex += 1;
  if (currentChunkIndex >= textChunks.length) {
    state.currentChunk = textChunks.length;
    clearUsageTicker();
    await flushUsageSession({ persist: true });
    setStatus("finished", "");
    return;
  }
  speakCurrentChunk();
}

async function handleUtteranceError() {
  clearUsageTicker();
  await flushUsageSession({ persist: true });
  setStatus("error", "Speech stopped unexpectedly.");
}

function speakCurrentChunk() {
  if (isPaywallRequired()) {
    handleLimitReached();
    return;
  }
  if (!textChunks.length) {
    setStatus("error", "No text available to read.");
    return;
  }
  if (currentChunkIndex >= textChunks.length) {
    setStatus("finished", "");
    return;
  }
  const chunk = textChunks[currentChunkIndex];
  if (!chunk) {
    currentChunkIndex += 1;
    speakCurrentChunk();
    return;
  }
  state.currentChunk = currentChunkIndex + 1;
  sendStateUpdate();
  const utterance = createUtterance(chunk);
  speechSynthesis.speak(utterance);
}

function cancelSpeech() {
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    skipNextEnd = true;
  } else {
    skipNextEnd = false;
  }
  speechSynthesis.cancel();
}

async function startReading() {
  await ensureBillingLoaded();
  if (isPaywallRequired()) {
    setStatus("limited", "Free minutes are over. Upgrade to continue reading.");
    return;
  }

  if (state.status === "reading") {
    return;
  }
  if (state.status === "paused") {
    await resumeReading();
    return;
  }

  if (!textChunks.length) {
    setStatus("loading", "Loading PDF text...");
    await prepareText();
    if (!textChunks.length) {
      return;
    }
  }

  if (state.status === "finished" || state.status === "idle" || state.status === "limited") {
    currentChunkIndex = 0;
  }

  cancelSpeech();
  state.currentChunk = currentChunkIndex + 1;
  setStatus("reading", "");
  startUsageSession();
  ensureUsageTicker();
  speakCurrentChunk();
}

async function pauseReading() {
  if (state.status !== "reading") {
    return;
  }
  speechSynthesis.pause();
  clearUsageTicker();
  await flushUsageSession({ persist: true });
  setStatus("paused", "");
}

async function resumeReading() {
  await ensureBillingLoaded();
  if (state.status !== "paused") {
    return;
  }
  if (isPaywallRequired()) {
    setStatus("limited", "Free minutes are over. Upgrade to continue reading.");
    return;
  }
  setStatus("reading", "");
  startUsageSession();
  ensureUsageTicker();
  if (restartOnResume) {
    restartOnResume = false;
    cancelSpeech();
    speakCurrentChunk();
    return;
  }
  speechSynthesis.resume();
}

async function stopReading() {
  cancelSpeech();
  clearUsageTicker();
  await flushUsageSession({ persist: true });
  currentChunkIndex = 0;
  state.currentChunk = 0;
  setStatus("idle", "");
}

function setSpeed(speed) {
  if (!Number.isFinite(speed)) {
    return;
  }
  state.speed = speed;
  if (state.status === "reading") {
    cancelSpeech();
    speakCurrentChunk();
    return;
  }
  if (state.status === "paused") {
    restartOnResume = true;
  }
  sendStateUpdate();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    ensureBillingLoaded().then(() => sendResponse({ state }));
    return true;
  }

  if (message.type === "getState") {
    ensureBillingLoaded().then(() => sendResponse({ state }));
    return true;
  }

  if (message.type === "start") {
    startReading().then(() => sendResponse({ state }));
    return true;
  }

  if (message.type === "pause") {
    pauseReading().then(() => sendResponse({ state }));
    return true;
  }

  if (message.type === "resume") {
    resumeReading().then(() => sendResponse({ state }));
    return true;
  }

  if (message.type === "stop") {
    stopReading().then(() => sendResponse({ state }));
    return true;
  }

  if (message.type === "setSpeed") {
    setSpeed(message.speed);
    sendResponse({ state });
    return false;
  }

  sendResponse({ state });
  return false;
});

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    let shouldSync = false;

    if (changes[STORAGE_KEYS.freeUsageMs]) {
      const usageCandidate = Number(changes[STORAGE_KEYS.freeUsageMs].newValue);
      freeUsageMs = Number.isFinite(usageCandidate) ? Math.max(usageCandidate, 0) : 0;
      shouldSync = true;
    }

    if (changes[STORAGE_KEYS.subscriptionActive]) {
      subscriptionActive = Boolean(changes[STORAGE_KEYS.subscriptionActive].newValue);
      shouldSync = true;
    }

    if (!shouldSync) {
      return;
    }

    syncBillingState();

    if (subscriptionActive && state.status === "limited") {
      setStatus("idle", "");
      return;
    }

    if (isPaywallRequired() && state.status === "reading") {
      handleLimitReached();
      return;
    }

    sendStateUpdate();
  });
}

ensureBillingLoaded().then(() => {
  sendStateUpdate();
});

window.addEventListener("beforeunload", () => {
  clearUsageTicker();
  flushUsageSession({ persist: true });
  speechSynthesis.cancel();
});
