const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const playBtn = document.getElementById("play");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const speedSelect = document.getElementById("speed");
const upgradeBtn = document.getElementById("upgrade");
const debugPanelEl = document.getElementById("debugPanel");
const debugOutputEl = document.getElementById("debugOutput");

let activeTabId = null;

const STATUS_LABELS = {
  idle: "Ready",
  loading: "Preparing",
  reading: "Reading",
  paused: "Paused",
  finished: "Finished",
  error: "Unable to read",
};

function setControlsEnabled(enabled) {
  playBtn.disabled = !enabled;
  pauseBtn.disabled = !enabled;
  stopBtn.disabled = !enabled;
  speedSelect.disabled = !enabled;
}

function renderDebug(state) {
  if (!debugOutputEl) {
    return;
  }

  if (!state?.debug) {
    debugOutputEl.textContent = "No debug data yet.";
    if (debugPanelEl) {
      debugPanelEl.open = false;
    }
    return;
  }

  const debug = state.debug;
  const pageLengths = Array.isArray(debug.pageTextLengths) ? debug.pageTextLengths : [];
  const lines = [
    `stage: ${debug.stage || "-"}`,
    `sourceType: ${debug.sourceType || "-"}`,
    `pdfUrl: ${debug.pdfUrl || "-"}`,
    `pages: ${Number.isFinite(state.totalPages) ? state.totalPages : 0}`,
    `chunks: ${Number.isFinite(state.totalChunks) ? state.totalChunks : 0}`,
    `language: ${state.language || "-"}`,
    `totalExtractedChars: ${Number.isFinite(debug.totalExtractedChars) ? debug.totalExtractedChars : 0}`,
    `pageTextLengths: ${pageLengths.length ? pageLengths.join(", ") : "-"}`,
    `lastError: ${debug.lastError || "-"}`,
  ];

  debugOutputEl.textContent = lines.join("\n");
  if (debugPanelEl) {
    debugPanelEl.open = state.status === "error";
  }
}

function updateUI(state) {
  if (!state) {
    statusEl.textContent = "Open a PDF to start";
    hintEl.textContent = "Make sure the active tab is a PDF.";
    upgradeBtn.classList.add("hidden");
    setControlsEnabled(false);
    renderDebug(null);
    return;
  }

  const label = STATUS_LABELS[state.status] || "Ready";
  statusEl.textContent = label;
  hintEl.textContent = state.message || " ";
  const showUpgrade =
    state.status === "error" &&
    typeof state.message === "string" &&
    state.message.includes("Upgrade to continue");
  upgradeBtn.classList.toggle("hidden", !showUpgrade);

  if (state.speed) {
    speedSelect.value = String(state.speed);
  }

  pauseBtn.textContent = state.status === "paused" ? "Resume" : "Pause";
  playBtn.disabled = state.status === "reading" || state.status === "loading";
  pauseBtn.disabled = !(state.status === "reading" || state.status === "paused");
  stopBtn.disabled = !(state.status === "reading" || state.status === "paused");
  speedSelect.disabled = state.status === "loading";
  renderDebug(state);
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function sendMessageToTab(message) {
  return new Promise(async (resolve) => {
    const tab = await getActiveTab();
    if (!tab?.id) {
      updateUI(null);
      resolve(null);
      return;
    }
    activeTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        updateUI(null);
        resolve(null);
        return;
      }
      if (response?.state) {
        updateUI(response.state);
      }
      resolve(response);
    });
  });
}

async function refreshState() {
  await sendMessageToTab({ type: "getState" });
}

playBtn.addEventListener("click", () => {
  sendMessageToTab({ type: "start" });
});

pauseBtn.addEventListener("click", () => {
  if (pauseBtn.textContent === "Resume") {
    sendMessageToTab({ type: "resume" });
  } else {
    sendMessageToTab({ type: "pause" });
  }
});

stopBtn.addEventListener("click", () => {
  sendMessageToTab({ type: "stop" });
});

speedSelect.addEventListener("change", (event) => {
  const speed = Number.parseFloat(event.target.value);
  sendMessageToTab({ type: "setSpeed", speed });
});

upgradeBtn.addEventListener("click", () => {
  const url = chrome.runtime.getURL("paywall.html");
  chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "stateUpdate") {
    updateUI(message.state);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  updateUI(null);
  refreshState();
});
