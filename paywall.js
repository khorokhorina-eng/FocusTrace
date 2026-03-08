const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const closeBtn = document.getElementById("close");
const planButtons = Array.from(document.querySelectorAll("button[data-plan-id]"));

let currentSubscription = { active: false, plan: null };

function setStatus(text, ok = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("ok", ok);
}

function sendMessage(message) {
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

function updateButtons() {
  const activePlanId = currentSubscription?.plan?.planId || "";

  planButtons.forEach((button) => {
    const planId = button.dataset.planId || "";
    const isCurrentPlan = currentSubscription?.active && activePlanId === planId;
    button.disabled = isCurrentPlan;
    button.textContent = isCurrentPlan ? "Current plan" : "Upgrade";
  });
}

async function openCheckout(planId, button) {
  if (!planId) {
    return;
  }

  const initialLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Creating checkout...";
  setStatus("Creating Stripe Checkout session...");

  try {
    const result = await sendMessage({
      type: "createCheckoutSession",
      planId,
      returnUrl: chrome.runtime.getURL("paywall.html"),
    });

    if (!result.url) {
      throw new Error("Checkout URL is missing.");
    }

    setStatus("Redirecting to Stripe Checkout...");
    window.location.assign(result.url);
  } catch (error) {
    setStatus(error.message || "Unable to open checkout.");
  } finally {
    if (button.textContent === "Creating checkout...") {
      button.textContent = initialLabel;
    }
    updateButtons();
  }
}

async function loadSubscriptionStatus() {
  setStatus("Checking subscription status...");

  try {
    const result = await sendMessage({ type: "refreshSubscriptionStatus" });
    currentSubscription = result || { active: false, plan: null };
    updateButtons();

    if (currentSubscription.active) {
      const planName =
        currentSubscription.plan?.planId === "yearly" ? "Yearly plan" : "Monthly plan";
      setStatus(`Subscription active. Current plan: ${planName}.`, true);
      return;
    }

    setStatus("No active subscription detected.");
  } catch (error) {
    currentSubscription = { active: false, plan: null };
    updateButtons();
    setStatus(error.message || "Failed to refresh subscription status.");
  }
}

planButtons.forEach((button) => {
  button.addEventListener("click", () => {
    openCheckout(button.dataset.planId || "", button);
  });
});

refreshBtn.addEventListener("click", () => {
  loadSubscriptionStatus();
});

closeBtn.addEventListener("click", () => {
  window.close();
});

updateButtons();
loadSubscriptionStatus();
