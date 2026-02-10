const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const playBtn = document.getElementById("play");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const speedSelect = document.getElementById("speed");
const openFileBtn = document.getElementById("openFile");
const fileInput = document.getElementById("fileInput");

const AI_CONFIG = window.PDF_TTS_CONFIG || {};
const AI_TTS_ENDPOINT = AI_CONFIG.aiEndpoint || "";
const AI_DEFAULT_VOICE = AI_CONFIG.aiDefaultVoice || "alloy";

const STATUS_LABELS = {
  idle: "Ready",
  loading: "Preparing",
  reading: "Reading",
  paused: "Paused",
  finished: "Finished",
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

function setMode(nextMode) {
  mode = nextMode;
  if (mode === "local") {
    openFileBtn.classList.remove("hidden");
  } else {
    openFileBtn.classList.add("hidden");
  }
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
  const response = await fetch(AI_TTS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: text,
      text,
      speed,
      voice: AI_DEFAULT_VOICE,
      response_format: "mp3",
    }),
    signal: usedController.signal,
  });
  if (!response.ok) {
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
    if (token !== localAiPlaybackToken || localState.status !== "reading") {
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
    startLocalAiPrefetch(localChunkIndex + 1);
  } catch (error) {
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
  setLocalStatus("reading", "");
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
  if (aiEnabled) {
    startLocalAiReading();
    return;
  }
  if (localState.status === "reading") {
    return;
  }
  if (localState.status === "paused") {
    resumeLocalReading();
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
  setLocalStatus("reading", "");
  speakLocalChunk();
}

function pauseLocalReading() {
  if (aiEnabled) {
    pauseLocalAiReading();
    return;
  }
  if (localState.status !== "reading") {
    return;
  }
  speechSynthesis.pause();
  setLocalStatus("paused", "");
}

function resumeLocalReading() {
  if (aiEnabled) {
    resumeLocalAiReading();
    return;
  }
  if (localState.status !== "paused") {
    return;
  }
  setLocalStatus("reading", "");
  if (localRestartOnResume) {
    localRestartOnResume = false;
    cancelLocalSpeech();
    speakLocalChunk();
    return;
  }
  speechSynthesis.resume();
}

function stopLocalReading() {
  if (aiEnabled) {
    stopLocalAiReading();
    return;
  }
  cancelLocalSpeech();
  localChunkIndex = 0;
  setLocalStatus("idle", localState.message);
}

function setLocalSpeed(speed) {
  if (!Number.isFinite(speed)) {
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

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  loadLocalFile(file);
});

document.addEventListener("DOMContentLoaded", () => {
  updateUI(null);
  if (!isAiAvailable()) {
    hintEl.textContent = "AI voice requires server setup.";
  }
  refreshState();
});
