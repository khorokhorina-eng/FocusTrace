const state = {
  status: "idle",
  speed: 1,
  message: "",
  totalPages: 0,
  totalChunks: 0,
  currentChunk: 0,
  language: "",
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

async function startReading() {
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
  if (state.status !== "reading") {
    return;
  }
  speechSynthesis.pause();
  setStatus("paused", "");
}

function resumeReading() {
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

  sendResponse({ state });
  return false;
});

window.addEventListener("beforeunload", () => {
  speechSynthesis.cancel();
});
