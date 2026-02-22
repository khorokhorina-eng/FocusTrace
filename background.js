chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }
  chrome.storage.sync.set({ installDate: new Date().toISOString() });
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
