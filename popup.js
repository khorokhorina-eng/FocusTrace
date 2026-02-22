const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const minutesEl = document.getElementById("minutes");
const playBtn = document.getElementById("play");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const speedSelect = document.getElementById("speed");
const togglePlanBtn = document.getElementById("togglePlan");
const toggleContactBtn = document.getElementById("toggleContact");
const planPanel = document.getElementById("planPanel");
const contactPanel = document.getElementById("contactPanel");
const closePlanBtn = document.getElementById("closePlan");
const closeContactBtn = document.getElementById("closeContact");
const subscriptionStateEl = document.getElementById("subscriptionState");
const contactEmailEl = document.getElementById("contactEmail");
const contactMessageEl = document.getElementById("contactMessage");
const sendContactBtn = document.getElementById("sendContact");
const contactStatusEl = document.getElementById("contactStatus");

let activeTabId = null;
let activePanel = null;
let forcedPaywall = false;

const FREE_MINUTES_LIMIT_MS = 15 * 60 * 1000;

const STATUS_LABELS = {
  idle: "Ready",
  loading: "Preparing",
  reading: "Reading",
  paused: "Paused",
  finished: "Finished",
  limited: "Limit reached",
  error: "Unable to read",
};

function setControlsEnabled(enabled) {
  playBtn.disabled = !enabled;
  pauseBtn.disabled = !enabled;
  stopBtn.disabled = !enabled;
  speedSelect.disabled = !enabled;
}

function formatMinutesLeft(ms) {
  if (!Number.isFinite(ms)) {
    return "0 min";
  }
  const minutes = Math.max(Math.ceil(ms / 60000), 0);
  return `${minutes} min`;
}

function applyBillingPanels() {
  if (forcedPaywall) {
    activePanel = "plan";
  }

  const isPlanOpen = activePanel === "plan";
  const isContactOpen = activePanel === "contact" && !forcedPaywall;

  planPanel.classList.toggle("hidden", !isPlanOpen);
  planPanel.setAttribute("aria-hidden", String(!isPlanOpen));

  contactPanel.classList.toggle("hidden", !isContactOpen);
  contactPanel.setAttribute("aria-hidden", String(!isContactOpen));

  togglePlanBtn.classList.toggle("active", isPlanOpen);
  toggleContactBtn.classList.toggle("active", isContactOpen);
  toggleContactBtn.disabled = forcedPaywall;
  closePlanBtn.hidden = forcedPaywall;
}

function openPanel(name) {
  activePanel = name;
  applyBillingPanels();
}

function closePanel(name) {
  if (name === "plan" && forcedPaywall) {
    return;
  }
  if (activePanel === name) {
    activePanel = null;
  }
  applyBillingPanels();
}

function applyBillingState({ isSubscribed, freeMinutesLeftMs, paywallRequired }) {
  forcedPaywall = Boolean(paywallRequired && !isSubscribed);

  if (isSubscribed) {
    minutesEl.textContent = "Subscription active.";
    subscriptionStateEl.textContent = "Subscription active.";
  } else if (forcedPaywall) {
    minutesEl.textContent = "Free minutes are over. Upgrade to continue.";
    subscriptionStateEl.textContent = "No active subscription. Free minutes are over.";
  } else {
    minutesEl.textContent = `Free minutes left: ${formatMinutesLeft(freeMinutesLeftMs)}.`;
    subscriptionStateEl.textContent = "No active subscription.";
  }

  applyBillingPanels();
}

function readBillingSnapshot() {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve(null);
      return;
    }

    chrome.storage.local.get(["freeUsageMs", "subscriptionActive"], (result) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(result || null);
    });
  });
}

function applyBillingSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  const usageCandidate = Number(snapshot.freeUsageMs);
  const usageMs = Number.isFinite(usageCandidate) ? Math.max(usageCandidate, 0) : 0;
  const isSubscribed = Boolean(snapshot.subscriptionActive);
  const freeMinutesLeftMs = Math.max(FREE_MINUTES_LIMIT_MS - usageMs, 0);
  applyBillingState({
    isSubscribed,
    freeMinutesLeftMs,
    paywallRequired: !isSubscribed && freeMinutesLeftMs <= 0,
  });
}

function updateUI(state) {
  if (!state) {
    statusEl.textContent = "Open a PDF to start";
    hintEl.textContent = "Make sure the active tab is a PDF.";
    setControlsEnabled(false);
    return;
  }

  const label = STATUS_LABELS[state.status] || "Ready";
  statusEl.textContent = label;
  hintEl.textContent = state.message || " ";

  if (state.speed) {
    speedSelect.value = String(state.speed);
  }

  const paywallRequired = Boolean(state.paywallRequired || state.status === "limited");
  pauseBtn.textContent = state.status === "paused" ? "Resume" : "Pause";
  playBtn.disabled = paywallRequired || state.status === "reading" || state.status === "loading";
  pauseBtn.disabled =
    paywallRequired || !(state.status === "reading" || state.status === "paused");
  stopBtn.disabled =
    paywallRequired || !(state.status === "reading" || state.status === "paused");
  speedSelect.disabled = paywallRequired || state.status === "loading";

  applyBillingState({
    isSubscribed: Boolean(state.isSubscribed),
    freeMinutesLeftMs: Number.isFinite(state.freeMinutesLeftMs)
      ? state.freeMinutesLeftMs
      : FREE_MINUTES_LIMIT_MS,
    paywallRequired: Boolean(state.paywallRequired),
  });
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
  if (forcedPaywall) {
    openPanel("plan");
    return;
  }
  sendMessageToTab({ type: "start" });
});

pauseBtn.addEventListener("click", () => {
  if (forcedPaywall) {
    openPanel("plan");
    return;
  }
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

togglePlanBtn.addEventListener("click", () => {
  if (activePanel === "plan") {
    closePanel("plan");
    return;
  }
  openPanel("plan");
});

toggleContactBtn.addEventListener("click", () => {
  if (forcedPaywall) {
    return;
  }
  if (activePanel === "contact") {
    closePanel("contact");
    return;
  }
  openPanel("contact");
});

closePlanBtn.addEventListener("click", () => {
  closePanel("plan");
});

closeContactBtn.addEventListener("click", () => {
  closePanel("contact");
});

sendContactBtn.addEventListener("click", () => {
  const email = contactEmailEl.value.trim();
  const message = contactMessageEl.value.trim();
  if (!email || !message) {
    contactStatusEl.textContent = "Please fill in email and message.";
    return;
  }
  contactStatusEl.textContent = "Thanks! We received your message.";
  contactMessageEl.value = "";
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "stateUpdate") {
    updateUI(message.state);
  }
});

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (!changes.freeUsageMs && !changes.subscriptionActive) {
      return;
    }
    readBillingSnapshot().then(applyBillingSnapshot);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  updateUI(null);
  applyBillingPanels();
  readBillingSnapshot().then(applyBillingSnapshot);
  refreshState();
});
