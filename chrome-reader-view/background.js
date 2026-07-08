async function ensureReaderInjected(tabId) {
  const [{ result: isLoaded }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Boolean(window.__dailyReaderViewLoaded)
  });

  if (!isLoaded) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["reader-overlay.css"]
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["lib/Readability.js", "content.js"]
    });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/.test(tab.url || "")) {
    return;
  }

  await ensureReaderInjected(tab.id);
  chrome.tabs.sendMessage(tab.id, { action: "toggle-reader-view" });
});
