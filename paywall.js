const statusEl = document.getElementById("status");

function setStatus(text) {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

async function openBilling() {
  if (!window.paywall) {
    setStatus("Paywall not configured.");
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const section = params.get("section");
  const resolveEvent = params.get("resolveEvent") || "signed-in";

  if (mode === "portal" || section) {
    if (typeof window.paywall.openPortal === "function") {
      try {
        await window.paywall.openPortal({ section });
        return;
      } catch (error) {
        // fallback below
      }
    }
    if (typeof window.paywall.open === "function") {
      try {
        await window.paywall.open({ view: section, section });
        return;
      } catch (error) {
        // fallback below
      }
      try {
        await window.paywall.open({ mode: "portal", section });
        return;
      } catch (error) {
        // fallback below
      }
    }
  }

  if (typeof window.paywall.open !== "function") {
    setStatus("Paywall not available.");
    return;
  }
  try {
    await window.paywall.open({ resolveEvent });
  } catch (error) {
    setStatus("Unable to open billing page.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setStatus("Loading billing...");
  openBilling();
});
