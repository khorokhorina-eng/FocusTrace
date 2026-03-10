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
const continueCheckoutBtn = document.getElementById("continueCheckout");
const planCardEls = Array.from(document.querySelectorAll(".plan-card"));

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
let playbackStartedAtMs = 0;
let paywallStopTimer = null;
let currentFileBuffer = null;
let selectedPlanId = "yearly";
let currentSubscription = { active: false, plan: null };

const PLAN_META = {
  monthly: {
    buttonText: "Continue with 1-month plan",
  },
  yearly: {
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
    "node_modules/pdfjs-dist/build/pdf.worker.min.js"
  );
}

function setStatus(status, message = "") {
  state.status = status;
  state.message = message;
  updateUI();
}

function updateUI() {
  statusEl.textContent = STATUS_LABELS[state.status] || "Ready";
  hintEl.textContent = state.message || " ";
  pauseBtn.textContent = state.status === "paused" ? "Resume" : "Pause";
  const shouldShowLimitUpgrade =
    state.status === "error" &&
    typeof state.message === "string" &&
    state.message.includes("Upgrade to continue");
  limitUpgradeBtn.classList.toggle("hidden", !shouldShowLimitUpgrade);
  playBtn.disabled =
    !currentFileBuffer || state.status === "loading" || state.status === "reading";
  pauseBtn.disabled = !(state.status === "reading" || state.status === "paused");
  stopBtn.disabled = !(state.status === "reading" || state.status === "paused");
  speedSelect.disabled = state.status === "loading";
  const activePlanId = currentSubscription?.plan?.planId || "";
  const isCurrentPlan = currentSubscription?.active && activePlanId === selectedPlanId;
  continueCheckoutBtn.textContent =
    isCurrentPlan ? "Current plan active" : PLAN_META[selectedPlanId]?.buttonText || "Continue";
  continueCheckoutBtn.disabled = isCurrentPlan;
}

function cleanupCurrentAudio() {
  if (paywallStopTimer) {
    clearTimeout(paywallStopTimer);
    paywallStopTimer = null;
  }
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

function schedulePaywallStop(token, remainingSeconds) {
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
    return;
  }

  paywallStopTimer = setTimeout(async () => {
    if (token !== playbackToken || state.status !== "reading") {
      return;
    }
    cleanupCurrentAudio();
    await commitPlaybackUsage().catch(() => null);
    setStatus("error", paywallReachedMessage());
  }, remainingSeconds * 1000);
}

function resetPreparedText() {
  cleanupCurrentAudio();
  textChunks = [];
  currentChunkIndex = 0;
  detectedLanguage = "";
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

function buildChunks(pages) {
  const chunks = [];
  const maxLength = 400;

  pages.forEach((pageText) => {
    const normalized = normalizeText(pageText);
    if (!normalized) {
      return;
    }

    const parts = splitIntoSentences(normalized);
    const units = parts.length ? parts : [normalized];
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

function requestTtsBytes(text) {
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

function setPaywallStatus(text, ok = false) {
  paywallStatusEl.textContent = text;
  paywallStatusEl.style.color = ok ? "#15803d" : "#6b7280";
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
      setPaywallStatus("Unlimited listening with one plan.");
    }
    renderPaywallSelection();
  } catch (error) {
    setPaywallStatus(error.message || "Failed to load subscription status.");
  }
}

function openPaywall() {
  paywallModal.classList.remove("hidden");
  loadSubscriptionStatus();
}

function closePaywall() {
  paywallModal.classList.add("hidden");
}

async function openCheckoutForSelectedPlan() {
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
  const wholeSeconds = Math.ceil(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const rest = wholeSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function paywallReachedMessage() {
  return "Free limit reached: 0:05 of playback. Upgrade to continue.";
}

async function commitPlaybackUsage() {
  if (!playbackStartedAtMs) {
    return null;
  }

  const elapsedSeconds = (Date.now() - playbackStartedAtMs) / 1000;
  playbackStartedAtMs = 0;
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

async function extractPdfText(arrayBuffer) {
  if (!pdfjs) {
    throw new Error("PDF engine not available.");
  }

  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
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

async function prepareSelectedFile(file) {
  if (!file) {
    return;
  }

  resetPreparedText();
  state.fileName = file.name || "";
  setStatus("loading", "Preparing PDF text...");

  try {
    currentFileBuffer = await file.arrayBuffer();
    const { pages, totalPages } = await extractPdfText(currentFileBuffer.slice(0));
    textChunks = buildChunks(pages);
    state.totalPages = totalPages;
    state.totalChunks = textChunks.length;
    state.currentChunk = 0;

    if (!textChunks.length) {
      setStatus("error", "No selectable text found. This PDF might be scanned.");
      return;
    }

    const sample = textChunks.slice(0, 3).join(" ").slice(0, 1000);
    detectedLanguage = await detectLanguageFromText(sample);
    state.language = detectedLanguage;
    setStatus("idle", `${file.name} is ready to read.`);
  } catch (error) {
    const details = error && error.message ? error.message : "Unable to prepare the PDF.";
    currentFileBuffer = null;
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
  await commitPlaybackUsage().catch(() => null);
  currentChunkIndex += 1;

  if (currentChunkIndex >= textChunks.length) {
    state.currentChunk = textChunks.length;
    cleanupCurrentAudio();
    setStatus("finished", `${state.fileName || "PDF"} finished.`);
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
    cleanupCurrentAudio();
    setStatus("finished", `${state.fileName || "PDF"} finished.`);
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
    payload = await requestTtsBytes(textChunks[currentChunkIndex]);
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
  currentAudio.onended = () => {
    handleAudioEnded(token);
  };
  currentAudio.onerror = () => {
    cleanupCurrentAudio();
    setStatus("error", "Audio playback failed.");
  };

  playbackStartedAtMs = Date.now();
  schedulePaywallStop(token, quota.remainingSeconds);

  try {
    await currentAudio.play();
    setStatus("reading", state.fileName ? `Reading ${state.fileName}` : "Reading");
  } catch (error) {
    cleanupCurrentAudio();
    const details = error && error.message ? error.message : "Unable to start audio playback.";
    setStatus("error", details);
  }
}

async function startPlayback() {
  if (!textChunks.length) {
    setStatus("error", "Upload a PDF with selectable text first.");
    return;
  }

  if (state.status === "finished") {
    currentChunkIndex = 0;
  }

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
    playbackStartedAtMs = Date.now();
    schedulePaywallStop(playbackToken, quota.remainingSeconds);
    await currentAudio.play();
    setStatus("reading", state.fileName ? `Reading ${state.fileName}` : "Reading");
    return;
  }

  if (paywallStopTimer) {
    clearTimeout(paywallStopTimer);
    paywallStopTimer = null;
  }
  currentAudio.pause();
  await commitPlaybackUsage().catch(() => null);
  setStatus("paused", state.fileName ? `Paused ${state.fileName}` : "Paused");
}

async function stopPlayback() {
  playbackToken += 1;
  await commitPlaybackUsage().catch(() => null);
  cleanupCurrentAudio();
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

speedSelect.addEventListener("change", (event) => {
  state.speed = Number.parseFloat(event.target.value) || 1;
});

upgradeBtn.addEventListener("click", () => {
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
  openCheckoutForSelectedPlan();
});

planCardEls.forEach((card) => {
  card.addEventListener("click", () => {
    selectedPlanId = card.dataset.planId || selectedPlanId;
    renderPaywallSelection();
  });
});

updateUI();
