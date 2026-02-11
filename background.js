chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }
  chrome.storage.sync.set({ installDate: new Date().toISOString() });
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "openPaywall") {
    return;
  }
  try {
    const url = new URL(chrome.runtime.getURL("paywall.html"));
    if (message.mode) {
      url.searchParams.set("mode", message.mode);
    }
    if (message.section) {
      url.searchParams.set("section", message.section);
    }
    if (message.resolveEvent) {
      url.searchParams.set("resolveEvent", message.resolveEvent);
    }
    chrome.tabs.create({ url: url.toString() });
  } catch (error) {
    // ignore
  }
});
