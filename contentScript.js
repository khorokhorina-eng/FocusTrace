const state = {
  status: "idle",
  speed: 1,
  message: "",
  totalPages: 0,
  totalChunks: 0,
  currentChunk: 0,
  language: "",
  ttsMode: "system",
  aiAvailable: false,
};

const AI_CONFIG = window.PDF_TTS_CONFIG || {};
const AI_TTS_ENDPOINT = AI_CONFIG.aiEndpoint || "";
const AI_DEFAULT_VOICE = AI_CONFIG.aiDefaultVoice || "alloy";
state.aiAvailable = Boolean(AI_TTS_ENDPOINT);
if (AI_CONFIG.aiEnabledByDefault && state.aiAvailable) {
  state.ttsMode = "ai";
}

let textChunks = [];
let currentChunkIndex = 0;
let isPreparing = false;
let skipNextEnd = false;
let restartOnResume = false;
let detectedLanguage = "";
let selectedVoice = null;
let availableVoices = [];
let pdfjsModule = null;
let pdfjsLoading = null;
let aiAudio = null;
let aiAbortController = null;
let aiCurrentUrl = null;
let aiPlaybackToken = 0;
let aiRestartOnResume = false;
let aiSkipNextEnd = false;
let aiPrefetch = null;
let aiPrefetchController = null;
let aiCurrentBaseSpeed = 1;

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

function isAiMode() {
  return state.ttsMode === "ai";
}

function isAiAvailable() {
  return Boolean(AI_TTS_ENDPOINT);
}

async function fetchAiAudio(text, language, speed, controller) {
  if (!isAiAvailable()) {
    throw new Error("AI voice is not configured.");
  }
  const usedController = controller || new AbortController();
  if (!controller) {
    aiAbortController = usedController;
  }
  const response = await fetch(AI_TTS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      language,
      speed,
      voice: AI_DEFAULT_VOICE,
    }),
    signal: usedController.signal,
  });
  if (!response.ok) {
    throw new Error("AI voice request failed.");
  }
  return response.blob();
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

function sendStateUpdate() {
  chrome.runtime.sendMessage({ type: "stateUpdate", state });
}

function setStatus(status, message = "") {
  state.status = status;
  state.message = message;
  sendStateUpdate();
}

function resolvePdfUrl() {
  if (document.contentType === "application/pdf") {
    return window.location.href;
  }
  const embed = document.querySelector(
    'embed[type="application/pdf"], object[type="application/pdf"]'
  );
  const source = embed?.src || embed?.data;
  if (source) {
    try {
      return new URL(source, window.location.href).href;
    } catch (error) {
      return source;
    }
  }
  return "";
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
  const maxLength = 900;

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
  const pdfjs = await loadPdfjs();
  if (!pdfjs?.getDocument) {
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
    return false;
  }
  isPreparing = true;
  try {
    const pdfUrl = resolvePdfUrl();
    if (!pdfUrl) {
      setStatus("error", "Active tab does not appear to be a PDF.");
      return false;
    }
    const { pages, totalPages } = await extractPdfText(pdfUrl);
    state.totalPages = totalPages;
    textChunks = buildChunks(pages);
    state.totalChunks = textChunks.length;
    state.currentChunk = 0;

    if (!textChunks.length) {
      setStatus(
        "error",
        "No selectable text found. This PDF might be scanned."
      );
      return false;
    }

    const sample = textChunks.slice(0, 3).join(" ").slice(0, 1000);
    detectedLanguage = await detectLanguageFromText(sample);
    state.language = detectedLanguage;
    selectedVoice = pickVoiceForLanguage(detectedLanguage);
    setStatus("idle", "");
    return true;
  } catch (error) {
    const message =
      "Unable to access PDF text. For local files, enable file access in the extension settings.";
    setStatus("error", message);
    return false;
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

function handleUtteranceEnd() {
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
    setStatus("finished", "");
    return;
  }
  speakCurrentChunk();
}

function handleUtteranceError() {
  setStatus("error", "Speech stopped unexpectedly.");
}

function speakCurrentChunk() {
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

function stopAiPlayback() {
  aiPlaybackToken += 1;
  if (aiAbortController) {
    aiAbortController.abort();
    aiAbortController = null;
  }
  if (aiPrefetchController) {
    aiPrefetchController.abort();
    aiPrefetchController = null;
  }
  aiPrefetch = null;
  if (aiAudio) {
    aiSkipNextEnd = true;
    aiAudio.pause();
    aiAudio = null;
  }
  if (aiCurrentUrl) {
    URL.revokeObjectURL(aiCurrentUrl);
    aiCurrentUrl = null;
  }
  aiCurrentBaseSpeed = 1;
}

function startAiPrefetch(index) {
  if (!isAiAvailable() || !textChunks.length) {
    return;
  }
  if (index < 0 || index >= textChunks.length) {
    return;
  }
  if (
    aiPrefetch &&
    aiPrefetch.index === index &&
    aiPrefetch.speed === state.speed
  ) {
    return;
  }
  if (aiPrefetchController) {
    aiPrefetchController.abort();
  }
  const chunk = textChunks[index];
  if (!chunk) {
    return;
  }
  const controller = new AbortController();
  aiPrefetchController = controller;
  aiPrefetch = {
    index,
    speed: state.speed,
    promise: fetchAiAudio(chunk, detectedLanguage, state.speed, controller),
  };
}

async function getAiBlob(index) {
  if (!textChunks.length) {
    return null;
  }
  const speed = state.speed;
  if (
    aiPrefetch &&
    aiPrefetch.index === index &&
    aiPrefetch.speed === speed
  ) {
    try {
      const blob = await aiPrefetch.promise;
      return { blob, baseSpeed: aiPrefetch.speed };
    } finally {
      aiPrefetch = null;
      aiPrefetchController = null;
    }
  }
  const chunk = textChunks[index];
  if (!chunk) {
    return null;
  }
  const blob = await fetchAiAudio(chunk, detectedLanguage, speed);
  return { blob, baseSpeed: speed };
}

async function playAiChunk() {
  if (!textChunks.length) {
    setStatus("error", "No text available to read.");
    return;
  }
  if (currentChunkIndex >= textChunks.length) {
    state.currentChunk = textChunks.length;
    setStatus("finished", "");
    return;
  }
  const chunk = textChunks[currentChunkIndex];
  if (!chunk) {
    currentChunkIndex += 1;
    playAiChunk();
    return;
  }
  const token = aiPlaybackToken;
  state.currentChunk = currentChunkIndex + 1;
  sendStateUpdate();
  try {
    const result = await getAiBlob(currentChunkIndex);
    if (token !== aiPlaybackToken || !isAiMode() || state.status !== "reading") {
      return;
    }
    if (!result?.blob) {
      setStatus("error", "AI voice failed.");
      return;
    }
    const { blob, baseSpeed } = result;
    const url = URL.createObjectURL(blob);
    aiCurrentUrl = url;
    const audio = new Audio(url);
    aiAudio = audio;
    aiCurrentBaseSpeed = baseSpeed;
    audio.playbackRate = baseSpeed > 0 ? state.speed / baseSpeed : 1;
    audio.onended = () => {
      if (aiSkipNextEnd) {
        aiSkipNextEnd = false;
        return;
      }
      URL.revokeObjectURL(url);
      aiCurrentUrl = null;
      if (!isAiMode() || state.status !== "reading") {
        return;
      }
      currentChunkIndex += 1;
      startAiPrefetch(currentChunkIndex + 1);
      playAiChunk();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      aiCurrentUrl = null;
      setStatus("error", "AI voice failed.");
    };
    await audio.play();
    startAiPrefetch(currentChunkIndex + 1);
  } catch (error) {
    setStatus("error", "AI voice failed.");
  }
}

async function startAiReading() {
  if (!isAiAvailable()) {
    setStatus("error", "AI voice is not configured.");
    return;
  }
  if (state.status === "reading") {
    return;
  }
  if (state.status === "paused") {
    resumeAiReading();
    return;
  }
  if (!textChunks.length) {
    setStatus("loading", "Loading PDF text...");
    const ready = await prepareText();
    if (!ready) {
      return;
    }
  }
  if (state.status === "finished" || state.status === "idle") {
    currentChunkIndex = 0;
  }
  cancelSpeech();
  stopAiPlayback();
  setStatus("reading", "");
  playAiChunk();
}

function pauseAiReading() {
  if (state.status !== "reading") {
    return;
  }
  if (aiAudio) {
    aiAudio.pause();
  }
  setStatus("paused", "");
}

function resumeAiReading() {
  if (state.status !== "paused") {
    return;
  }
  setStatus("reading", "");
  if (aiRestartOnResume) {
    aiRestartOnResume = false;
    stopAiPlayback();
    playAiChunk();
    return;
  }
  if (aiAudio) {
    aiAudio.playbackRate =
      aiCurrentBaseSpeed > 0 ? state.speed / aiCurrentBaseSpeed : 1;
    aiAudio.play();
  } else {
    playAiChunk();
  }
}

function stopAiReading() {
  stopAiPlayback();
  currentChunkIndex = 0;
  state.currentChunk = 0;
  setStatus("idle", "");
}

async function startReading() {
  if (isAiMode()) {
    await startAiReading();
    return;
  }
  if (state.status === "reading") {
    return;
  }
  if (state.status === "paused") {
    resumeReading();
    return;
  }

  if (!textChunks.length) {
    setStatus("loading", "Loading PDF text...");
    const ready = await prepareText();
    if (!ready || !textChunks.length) {
      return;
    }
  }

  if (state.status === "finished" || state.status === "idle") {
    currentChunkIndex = 0;
  }

  cancelSpeech();
  state.currentChunk = currentChunkIndex + 1;
  setStatus("reading", "");
  speakCurrentChunk();
}

function pauseReading() {
  if (isAiMode()) {
    pauseAiReading();
    return;
  }
  if (state.status !== "reading") {
    return;
  }
  speechSynthesis.pause();
  setStatus("paused", "");
}

function resumeReading() {
  if (isAiMode()) {
    resumeAiReading();
    return;
  }
  if (state.status !== "paused") {
    return;
  }
  setStatus("reading", "");
  if (restartOnResume) {
    restartOnResume = false;
    cancelSpeech();
    speakCurrentChunk();
    return;
  }
  speechSynthesis.resume();
}

function stopReading() {
  if (isAiMode()) {
    stopAiReading();
    return;
  }
  cancelSpeech();
  currentChunkIndex = 0;
  state.currentChunk = 0;
  setStatus("idle", "");
}

function setSpeed(speed) {
  if (!Number.isFinite(speed)) {
    return;
  }
  state.speed = speed;
  if (isAiMode()) {
    if (aiAudio) {
      aiAudio.playbackRate =
        aiCurrentBaseSpeed > 0 ? state.speed / aiCurrentBaseSpeed : 1;
    }
    if (aiPrefetchController) {
      aiPrefetchController.abort();
      aiPrefetchController = null;
      aiPrefetch = null;
    }
    if (state.status === "reading") {
      startAiPrefetch(currentChunkIndex + 1);
    }
    if (state.status === "paused") {
      aiRestartOnResume = false;
    }
    sendStateUpdate();
    return;
  }
  if (state.status === "reading") {
    sendStateUpdate();
    return;
  }
  if (state.status === "paused") {
    restartOnResume = true;
  }
  sendStateUpdate();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    sendResponse({ state });
    return false;
  }

  if (message.type === "getState") {
    sendResponse({ state });
    return false;
  }

  if (message.type === "start") {
    startReading().then(() => sendResponse({ state }));
    return true;
  }

  if (message.type === "pause") {
    pauseReading();
    sendResponse({ state });
    return false;
  }

  if (message.type === "resume") {
    resumeReading();
    sendResponse({ state });
    return false;
  }

  if (message.type === "stop") {
    stopReading();
    sendResponse({ state });
    return false;
  }

  if (message.type === "setSpeed") {
    setSpeed(message.speed);
    sendResponse({ state });
    return false;
  }

  if (message.type === "setTtsMode") {
    const nextMode = message.mode === "ai" ? "ai" : "system";
    if (nextMode === "ai" && !isAiAvailable()) {
      setStatus("error", "AI voice is not configured.");
      sendResponse({ state });
      return false;
    }
    if (state.ttsMode !== nextMode) {
      cancelSpeech();
      stopAiPlayback();
      currentChunkIndex = 0;
      state.currentChunk = 0;
      state.ttsMode = nextMode;
      setStatus("idle", "");
      sendResponse({ state });
      return false;
    }
    sendStateUpdate();
    sendResponse({ state });
    return false;
  }

  sendResponse({ state });
  return false;
});

window.addEventListener("beforeunload", () => {
  speechSynthesis.cancel();
  stopAiPlayback();
});
