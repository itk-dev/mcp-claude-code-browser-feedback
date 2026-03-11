/**
 * Background script (service worker for Chrome, event page for Firefox)
 * for the Claude Code Browser Feedback extension.
 *
 * Tracks per-tab enabled state, updates badge, and re-injects on navigation.
 */

const DEFAULT_SERVER_URL = 'http://localhost:9877';

// In-memory set of active tab IDs (persisted to storage for reload survival)
const activeTabs = new Set();

// Load persisted state on startup
chrome.storage.local.get(['activeTabs', 'serverUrl'], (result) => {
  if (result.activeTabs) {
    for (const id of result.activeTabs) activeTabs.add(id);
  }
});

function getServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get('serverUrl', (result) => {
      resolve(result.serverUrl || DEFAULT_SERVER_URL);
    });
  });
}

function persistActiveTabs() {
  chrome.storage.local.set({ activeTabs: Array.from(activeTabs) });
}

function updateBadge(tabId, active) {
  if (active) {
    chrome.action.setBadgeText({ text: 'ON', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// Send message to a tab's content script, swallowing errors for uninjected tabs
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script not yet injected or tab is gone
    return null;
  }
}

// Toggle widget on a specific tab
async function toggleTab(tabId) {
  const serverUrl = await getServerUrl();
  const isActive = activeTabs.has(tabId);

  if (isActive) {
    // Deactivate
    activeTabs.delete(tabId);
    await sendToTab(tabId, { action: 'deactivate' });
    updateBadge(tabId, false);
  } else {
    // Activate
    activeTabs.add(tabId);
    await sendToTab(tabId, { action: 'activate', serverUrl });
    updateBadge(tabId, true);
  }

  persistActiveTabs();
  return !isActive; // return new state
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'toggle') {
    const tabId = message.tabId;
    toggleTab(tabId).then((newState) => {
      sendResponse({ active: newState });
    });
    return true; // async response
  }

  if (message.action === 'getTabState') {
    // Called by content script on page load
    const tabId = sender.tab?.id;
    if (tabId && activeTabs.has(tabId)) {
      getServerUrl().then((serverUrl) => {
        sendResponse({ active: true, serverUrl });
      });
      return true; // async response
    }
    sendResponse({ active: false });
    return false;
  }

  if (message.action === 'getState') {
    // Called by popup
    const tabId = message.tabId;
    getServerUrl().then((serverUrl) => {
      sendResponse({
        active: activeTabs.has(tabId),
        serverUrl,
      });
    });
    return true; // async response
  }

  if (message.action === 'setServerUrl') {
    chrome.storage.local.set({ serverUrl: message.serverUrl }, () => {
      sendResponse({ ok: true });
    });
    return true; // async response
  }
});

// Re-inject widget when an active tab navigates to a new page
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && activeTabs.has(tabId)) {
    const serverUrl = await getServerUrl();
    updateBadge(tabId, true);
    await sendToTab(tabId, { action: 'activate', serverUrl });
  }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabs.has(tabId)) {
    activeTabs.delete(tabId);
    persistActiveTabs();
  }
});
