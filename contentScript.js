const state = {
  status: "idle",
  speed: 1,
  message: "",
  totalPages: 0,
  totalChunks: 0,
  currentChunk: 0,
  language: "",
  debug: {
    enabled: true,
    stage: "idle",
    pdfUrl: "",
    pageTextLengths: [],
    totalExtractedChars: 0,
    lastError: "",
    sourceType: "",
  },
};

const pdfjs = window.pdfjsLib;
const PAYWALL_LIMIT_SECONDS = 120;
let textChunks = [];
let currentChunkIndex = 0;
let isPreparing = false;
let restartOnResume = false;
let detectedLanguage = "";
let lastResolvedPdfUrl = "";
let currentAudio = null;
let currentAudioUrl = "";
let playbackToken = 0;
let playbackStartedAtMs = 0;
let paywallStopTimer = null;

if (pdfjs?.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "node_modules/pdfjs-dist/build/pdf.worker.min.js"
  );
}

function sendStateUpdate() {
  chrome.runtime.sendMessage({ type: "stateUpdate", state });
}

function updateDebug(patch) {
  state.debug = {
    ...state.debug,
    ...patch,
  };
  sendStateUpdate();
}

function setStatus(status, message = "") {
  state.status = status;
  state.message = message;
  sendStateUpdate();
}

function formatRemainingSeconds(seconds) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const wholeSeconds = Math.ceil(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const rest = wholeSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function clearPaywallTimer() {
  if (paywallStopTimer) {
    clearTimeout(paywallStopTimer);
    paywallStopTimer = null;
  }
}

function paywallReachedMessage() {
  return "Free limit reached: 0:05 of playback. Upgrade to continue.";
}

async function getPlaybackQuota() {
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

async function addPlaybackUsage(seconds) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "addPlaybackUsage", seconds },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Unable to save playback usage."));
          return;
        }
        resolve(response);
      }
    );
  });
}

function markPlaybackStart() {
  playbackStartedAtMs = Date.now();
}

async function commitPlaybackUsage() {
  if (!playbackStartedAtMs) {
    return null;
  }
  const elapsedMs = Date.now() - playbackStartedAtMs;
  playbackStartedAtMs = 0;
  const elapsedSeconds = elapsedMs / 1000;
  if (elapsedSeconds <= 0) {
    return null;
  }
  return addPlaybackUsage(elapsedSeconds);
}

async function enforcePaywallBeforePlayback() {
  const quota = await getPlaybackQuota();
  const remainingSeconds = Number(quota.remainingSeconds);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
    setStatus("error", paywallReachedMessage());
    return { allowed: false, remainingSeconds: 0 };
  }
  return { allowed: true, remainingSeconds };
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
  const maxLength = 400;

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

async function extractPdfText(url) {
  if (!pdfjs) {
    throw new Error("PDF engine not available.");
  }

  updateDebug({
    stage: "opening_pdf",
    pdfUrl: url,
    sourceType: url.startsWith("file://") ? "file" : "remote",
    pageTextLengths: [],
    totalExtractedChars: 0,
    lastError: "",
  });

  const openPdf = async (source) => {
    const loadingTask = pdfjs.getDocument(source);
    return loadingTask.promise;
  };

  let pdf = null;
  let lastError = null;

  if (url.startsWith("file://")) {
    const loadArrayBufferViaBackground = (candidateUrl) =>
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "fetchPdfBytes", url: candidateUrl },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!response?.ok || !response.bytes) {
              reject(new Error(response?.error || "Background fetch failed."));
              return;
            }
            if (Array.isArray(response.bytes)) {
              resolve(Uint8Array.from(response.bytes).buffer);
              return;
            }
            reject(new Error("Unsupported background response type."));
          }
        );
      });

    const loadArrayBufferWithXhr = (candidateUrl) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", candidateUrl, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
          if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
            resolve(xhr.response);
            return;
          }
          reject(new Error(`XHR local PDF failed (${xhr.status}).`));
        };
        xhr.onerror = () => {
          reject(new Error("XHR local PDF failed (network error)."));
        };
        xhr.send();
      });

    const candidates = [url];
    try {
      const decoded = decodeURIComponent(url);
      if (decoded !== url) {
        candidates.push(decoded);
      }
    } catch (_error) {
      // ignore malformed URI and keep original candidate
    }

    for (const candidate of candidates) {
      try {
        let buffer = null;
        try {
          updateDebug({ stage: "loading_file_background", pdfUrl: candidate });
          buffer = await loadArrayBufferViaBackground(candidate);
        } catch (backgroundError) {
          const backgroundMessage =
            backgroundError && backgroundError.message
              ? backgroundError.message
              : String(backgroundError);
          try {
            updateDebug({
              stage: "loading_file_fetch",
              pdfUrl: candidate,
              lastError: backgroundMessage,
            });
            const response = await fetch(candidate);
            if (!response.ok) {
              throw new Error(`fetch local PDF failed (${response.status}).`);
            }
            buffer = await response.arrayBuffer();
          } catch (fetchError) {
            const fetchMessage =
              fetchError && fetchError.message ? fetchError.message : String(fetchError);
            updateDebug({
              stage: "loading_file_xhr",
              pdfUrl: candidate,
              lastError: `${backgroundMessage}; ${fetchMessage}`,
            });
            const xhrBuffer = await loadArrayBufferWithXhr(candidate).catch((xhrError) => {
              const xhrMessage =
                xhrError && xhrError.message ? xhrError.message : String(xhrError);
              throw new Error(`${backgroundMessage}; ${fetchMessage}; ${xhrMessage}`);
            });
            buffer = xhrBuffer;
          }
        }
        pdf = await openPdf({ data: buffer });
        updateDebug({ stage: "pdf_opened", pdfUrl: candidate, lastError: "" });
        break;
      } catch (error) {
        lastError = error;
        updateDebug({
          stage: "open_failed",
          pdfUrl: candidate,
          lastError: error && error.message ? error.message : String(error),
        });
      }
    }

    if (!pdf) {
      throw (
        lastError ||
        new Error("Local PDF load failed: both fetch and XHR strategies failed.")
      );
    }
  }

  if (!pdf && !url.startsWith("file://")) {
    try {
      updateDebug({ stage: "loading_remote_pdf", pdfUrl: url });
      pdf = await openPdf({ url, withCredentials: false });
      updateDebug({ stage: "pdf_opened", pdfUrl: url, lastError: "" });
    } catch (error) {
      lastError = error;
      updateDebug({
        stage: "open_failed",
        pdfUrl: url,
        lastError: error && error.message ? error.message : String(error),
      });
    }
  }

  if (!pdf) {
    throw lastError || new Error("Unable to load PDF.");
  }

  const pages = [];
  const pageTextLengths = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    updateDebug({
      stage: `extracting_page_${pageNumber}`,
      pdfUrl: url,
    });
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => item.str)
      .filter(Boolean)
      .join(" ");
    pages.push(pageText);
    pageTextLengths.push(pageText.length);
  }

  updateDebug({
    stage: "text_extracted",
    pdfUrl: url,
    pageTextLengths,
    totalExtractedChars: pageTextLengths.reduce((sum, value) => sum + value, 0),
    lastError: "",
  });

  return { pages, totalPages: pdf.numPages };
}

function resolvePdfUrl() {
  const currentUrl = window.location.href;

  const decodeSafely = (value) => {
    let decoded = value;
    for (let i = 0; i < 3; i += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      } catch (_error) {
        break;
      }
    }
    return decoded;
  };

  const sanitizePdfUrl = (value) => {
    if (!value) {
      return "";
    }
    const cleaned = decodeSafely(String(value).trim().replace(/^"+|"+$/g, ""));
    if (!cleaned) {
      return "";
    }
    try {
      const parsed = new URL(cleaned);
      parsed.hash = "";
      if (parsed.protocol === "file:") {
        parsed.search = "";
      }
      return parsed.toString();
    } catch (_error) {
      const [withoutHash] = cleaned.split("#");
      const [withoutQuery] = withoutHash.split("?");
      return withoutQuery;
    }
  };

  if (window.location.protocol === "file:") {
    return sanitizePdfUrl(currentUrl);
  }

  try {
    const parsed = new URL(currentUrl);
    const candidates = [
      parsed.searchParams.get("src"),
      parsed.searchParams.get("url"),
      parsed.searchParams.get("file"),
    ];
    for (const raw of candidates) {
      const candidate = sanitizePdfUrl(raw);
      if (candidate && candidate.toLowerCase().includes(".pdf")) {
        return candidate;
      }
    }
  } catch (_error) {
    return sanitizePdfUrl(currentUrl);
  }
  return sanitizePdfUrl(currentUrl);
}

async function prepareText() {
  if (isPreparing) {
    return;
  }
  isPreparing = true;
  try {
    const pdfUrl = resolvePdfUrl();
    lastResolvedPdfUrl = pdfUrl;
    updateDebug({
      stage: "preparing_text",
      pdfUrl,
      pageTextLengths: [],
      totalExtractedChars: 0,
      lastError: "",
      sourceType: pdfUrl.startsWith("file://") ? "file" : "remote",
    });
    const { pages, totalPages } = await extractPdfText(pdfUrl);
    state.totalPages = totalPages;
    textChunks = buildChunks(pages);
    state.totalChunks = textChunks.length;
    state.currentChunk = 0;
    updateDebug({
      stage: "chunks_built",
      totalExtractedChars: pages.reduce((sum, page) => sum + page.length, 0),
      lastError: "",
    });

    if (!textChunks.length) {
      updateDebug({
        stage: "no_text_chunks",
        lastError: "PDF opened, but no selectable text was extracted.",
      });
      setStatus("error", "No selectable text found. This PDF might be scanned.");
      isPreparing = false;
      return;
    }

    const sample = textChunks.slice(0, 3).join(" ").slice(0, 1000);
    detectedLanguage = await detectLanguageFromText(sample);
    state.language = detectedLanguage;
    updateDebug({
      stage: "ready",
      lastError: "",
    });
    setStatus("idle", "");
  } catch (error) {
    const details =
      error && typeof error.message === "string" ? error.message : "";
    updateDebug({
      stage: "prepare_failed",
      lastError: details || "Unknown PDF preparation error.",
    });
    const message = details
      ? `Unable to access PDF text: ${details} (resolved: ${lastResolvedPdfUrl})`
      : "Unable to access PDF text. For local files, enable file access in the extension settings.";
    setStatus("error", message);
  } finally {
    isPreparing = false;
  }
}

function cleanupCurrentAudio() {
  clearPaywallTimer();
  playbackStartedAtMs = 0;
  if (currentAudio) {
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

async function requestTtsBytes(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "synthesizeSpeech",
        text,
        speed: state.speed,
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

async function handleAudioEnded(token) {
  if (token !== playbackToken || state.status !== "reading") {
    return;
  }
  clearPaywallTimer();
  await commitPlaybackUsage().catch(() => null);
  currentChunkIndex += 1;
  if (currentChunkIndex >= textChunks.length) {
    state.currentChunk = textChunks.length;
    cleanupCurrentAudio();
    setStatus("finished", "");
    return;
  }
  speakCurrentChunk(token);
}

async function speakCurrentChunk(token = playbackToken) {
  if (token !== playbackToken) {
    return;
  }
  if (!textChunks.length) {
    setStatus("error", "No text available to read.");
    return;
  }

  while (currentChunkIndex < textChunks.length && !textChunks[currentChunkIndex]) {
    currentChunkIndex += 1;
  }

  if (currentChunkIndex >= textChunks.length) {
    cleanupCurrentAudio();
    setStatus("finished", "");
    return;
  }

  state.currentChunk = currentChunkIndex + 1;
  sendStateUpdate();

  const chunk = textChunks[currentChunkIndex];
  let quota;
  try {
    quota = await enforcePaywallBeforePlayback();
  } catch (error) {
    const details =
      error && typeof error.message === "string"
        ? error.message
        : "Unable to validate playback quota.";
    setStatus("error", details);
    return;
  }
  if (!quota.allowed) {
    return;
  }

  setStatus(
    "loading",
    `Generating audio... ${formatRemainingSeconds(quota.remainingSeconds)} left`
  );

  let payload;
  try {
    payload = await requestTtsBytes(chunk);
  } catch (error) {
    const details =
      error && typeof error.message === "string" ? error.message : "TTS request failed.";
    setStatus("error", details);
    return;
  }

  if (token !== playbackToken || state.status === "idle") {
    return;
  }

  try {
    cleanupCurrentAudio();
    const blob = new Blob([Uint8Array.from(payload.bytes)], {
      type: payload.mimeType,
    });
    currentAudioUrl = URL.createObjectURL(blob);
    currentAudio = new Audio(currentAudioUrl);
    currentAudio.onended = () => {
      handleAudioEnded(token);
    };
    currentAudio.onerror = async () => {
      if (token !== playbackToken) {
        return;
      }
      clearPaywallTimer();
      await commitPlaybackUsage().catch(() => null);
      setStatus("error", "Failed to play generated audio.");
    };
    setStatus("reading", "");
    await currentAudio.play();
    markPlaybackStart();
    clearPaywallTimer();
    paywallStopTimer = setTimeout(async () => {
      if (token !== playbackToken || state.status !== "reading") {
        return;
      }
      await commitPlaybackUsage().catch(() => null);
      playbackToken += 1;
      cleanupCurrentAudio();
      state.currentChunk = currentChunkIndex + 1;
      setStatus("error", paywallReachedMessage());
    }, Math.max(1, Math.floor(quota.remainingSeconds * 1000)));
  } catch (error) {
    clearPaywallTimer();
    await commitPlaybackUsage().catch(() => null);
    const details =
      error && typeof error.message === "string" ? error.message : "Failed to play audio.";
    setStatus("error", details);
  }
}

async function startReading() {
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

  if (state.status === "finished" || state.status === "idle") {
    currentChunkIndex = 0;
  }

  playbackToken += 1;
  restartOnResume = false;
  setStatus("reading", "");
  await speakCurrentChunk(playbackToken);
}

async function pauseReading() {
  if (state.status !== "reading") {
    return;
  }
  clearPaywallTimer();
  await commitPlaybackUsage().catch(() => null);
  if (currentAudio) {
    currentAudio.pause();
  }
  setStatus("paused", "");
}

async function resumeReading() {
  if (state.status !== "paused") {
    return;
  }

  let quota;
  try {
    quota = await enforcePaywallBeforePlayback();
  } catch (error) {
    const details =
      error && typeof error.message === "string"
        ? error.message
        : "Unable to validate playback quota.";
    setStatus("error", details);
    return;
  }
  if (!quota.allowed) {
    return;
  }

  if (restartOnResume || !currentAudio) {
    restartOnResume = false;
    playbackToken += 1;
    setStatus("reading", "");
    await speakCurrentChunk(playbackToken);
    return;
  }

  setStatus("reading", "");
  try {
    await currentAudio.play();
    markPlaybackStart();
    clearPaywallTimer();
    paywallStopTimer = setTimeout(async () => {
      if (state.status !== "reading") {
        return;
      }
      await commitPlaybackUsage().catch(() => null);
      playbackToken += 1;
      cleanupCurrentAudio();
      state.currentChunk = currentChunkIndex + 1;
      setStatus("error", paywallReachedMessage());
    }, Math.max(1, Math.floor(quota.remainingSeconds * 1000)));
  } catch (_error) {
    playbackToken += 1;
    await speakCurrentChunk(playbackToken);
  }
}

async function stopReading() {
  clearPaywallTimer();
  await commitPlaybackUsage().catch(() => null);
  playbackToken += 1;
  cleanupCurrentAudio();
  restartOnResume = false;
  currentChunkIndex = 0;
  state.currentChunk = 0;
  setStatus("idle", "");
}

async function setSpeed(speed) {
  if (!Number.isFinite(speed)) {
    return;
  }
  state.speed = speed;
  if (state.status === "reading") {
    clearPaywallTimer();
    await commitPlaybackUsage().catch(() => null);
    playbackToken += 1;
    cleanupCurrentAudio();
    setStatus("reading", "");
    await speakCurrentChunk(playbackToken);
    return;
  }
  if (state.status === "paused") {
    restartOnResume = true;
  }
  sendStateUpdate();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    setSpeed(message.speed).then(() => sendResponse({ state }));
    return true;
  }

  sendResponse({ state });
  return false;
});

window.addEventListener("beforeunload", () => {
  commitPlaybackUsage().catch(() => null);
  cleanupCurrentAudio();
});
