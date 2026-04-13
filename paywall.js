const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const closeBtn = document.getElementById("close");
const planButtons = Array.from(document.querySelectorAll("button[data-plan-id]"));
const authMessageEl = document.getElementById("authMessage");
const authCopyEl = document.getElementById("authCopy");
const authSignedInEl = document.getElementById("authSignedIn");
const authGoogleBtn = document.getElementById("authGoogle");
const authSignedInTextEl = document.getElementById("authSignedInText");
const authSignOutBtn = document.getElementById("authSignOut");

let currentSubscription = { active: false, plan: null };
let authState = { signedIn: false, email: "", method: null };

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
    button.textContent = isCurrentPlan
      ? "Current plan"
      : authState.signedIn
      ? "Upgrade"
      : "Sign in first";
  });
}

async function loadAuthState() {
  const result = await sendMessage({ type: "getAuthState" });
  authState = {
    signedIn: !!result.signedIn,
    email: result.email || "",
    method: result.method || null,
  };
  authCopyEl.hidden = authState.signedIn;
  authGoogleBtn.hidden = authState.signedIn;
  authSignedInEl.hidden = !authState.signedIn;
  authSignedInTextEl.textContent = authState.signedIn ? `Signed in as ${authState.email}` : "";
  authMessageEl.textContent = authState.signedIn
    ? ""
    : "Use your 5 free minutes first. Sign in with Google when you want to buy a plan.";
  updateButtons();
}

async function signInWithGoogle() {
  authGoogleBtn.disabled = true;
  authGoogleBtn.textContent = "Opening Google...";
  try {
    await sendMessage({
      type: "startGoogleSignIn",
      returnUrl: chrome.runtime.getURL("paywall.html"),
    });
    setStatus("Complete Google sign-in in the opened tab. This page will work after you return.");
  } catch (error) {
    setStatus(error.message || "Unable to start Google sign-in.");
  } finally {
    authGoogleBtn.disabled = false;
    authGoogleBtn.textContent = "Continue with Google";
  }
}

async function signOut() {
  try {
    await sendMessage({ type: "signOut" });
    await loadAuthState();
    setStatus("Signed out. Sign in again before checkout.");
  } catch (error) {
    setStatus(error.message || "Unable to sign out.");
  }
}

async function openCheckout(planId, button) {
  if (!planId) {
    return;
  }
  await loadAuthState();
  if (!authState.signedIn) {
    setStatus("Continue with Google before checkout.");
    await signInWithGoogle();
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
    await loadAuthState();
    const result = await sendMessage({ type: "refreshSubscriptionStatus" });
    currentSubscription = result || { active: false, plan: null };
    updateButtons();

    if (currentSubscription.active) {
      const planName =
        currentSubscription.plan?.planId === "annual" ? "Yearly plan" : "Monthly plan";
      setStatus(`Subscription active. Current plan: ${planName}.`, true);
      return;
    }

    setStatus(
      authState.signedIn
        ? "No active subscription detected."
        : "Sign in before checkout to keep your paid plan attached to your account."
    );
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

authGoogleBtn.addEventListener("click", () => {
  signInWithGoogle();
});

authSignOutBtn.addEventListener("click", () => {
  signOut();
});

closeBtn.addEventListener("click", () => {
  window.close();
});

window.addEventListener("focus", () => {
  loadSubscriptionStatus();
});

updateButtons();
loadSubscriptionStatus();
