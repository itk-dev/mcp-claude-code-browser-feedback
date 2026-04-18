/**
 * Background script (service worker for Chrome, event page for Firefox)
 * for the Claude Code Browser Feedback extension.
 *
 * Tracks per-tab enabled state, updates badge, and re-injects on navigation.
 * Supports session isolation for multi-project scenarios.
 */

const DEFAULT_SERVER_URL = 'http://localhost:9877';

// In-memory set of active tab IDs (persisted to storage for reload survival)
const activeTabs = new Set();

// Per-tab session mapping: tabId -> sessionId
const tabSessionMap = new Map();

// Load persisted state on startup
chrome.storage.local.get(['activeTabs', 'serverUrl', 'tabSessions'], (result) => {
  if (result.activeTabs) {
    for (const id of result.activeTabs) activeTabs.add(id);
  }
  if (result.tabSessions) {
    for (const [tabId, sessionId] of Object.entries(result.tabSessions)) {
      tabSessionMap.set(Number(tabId), sessionId);
    }
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
  const sessions = {};
  for (const [tabId, sessionId] of tabSessionMap) {
    sessions[tabId] = sessionId;
  }
  chrome.storage.local.set({
    activeTabs: Array.from(activeTabs),
    tabSessions: sessions,
  });
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

// Fetch available sessions from the MCP server
async function fetchSessions(serverUrl) {
  try {
    const resp = await fetch(`${serverUrl}/sessions`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) return (await resp.json()).sessions || [];
  } catch {
    // Server not reachable
  }
  return [];
}

// Auto-match a tab URL to a session based on project URL detection
async function resolveSessionForTab(tabUrl, serverUrl) {
  const sessions = await fetchSessions(serverUrl);
  if (sessions.length === 0) return null;
  if (sessions.length === 1) return sessions[0].sessionId;

  // Try matching tab's origin against each session's detected project URL
  let tabOrigin;
  try {
    tabOrigin = new URL(tabUrl).origin;
  } catch {
    return null;
  }

  for (const session of sessions) {
    if (session.projectUrl) {
      try {
        const sessionOrigin = new URL(session.projectUrl).origin;
        if (tabOrigin === sessionOrigin) return session.sessionId;
      } catch {
        // Skip invalid URLs
      }
    }
  }

  // No match found — caller should show session picker
  return null;
}

// Toggle widget on a specific tab
async function toggleTab(tabId) {
  const serverUrl = await getServerUrl();
  const isActive = activeTabs.has(tabId);

  if (isActive) {
    // Deactivate
    activeTabs.delete(tabId);
    tabSessionMap.delete(tabId);
    await sendToTab(tabId, { action: 'deactivate' });
    updateBadge(tabId, false);
    persistActiveTabs();
    return { active: false };
  }

  // Activate — resolve session first
  let sessionId = tabSessionMap.get(tabId);

  if (!sessionId) {
    const tab = await chrome.tabs.get(tabId);
    sessionId = await resolveSessionForTab(tab.url, serverUrl);
  }

  if (!sessionId) {
    // Cannot auto-match, need user to pick a session
    return { active: false, needsSessionPicker: true };
  }

  activeTabs.add(tabId);
  tabSessionMap.set(tabId, sessionId);
  await sendToTab(tabId, { action: 'activate', serverUrl, sessionId });
  updateBadge(tabId, true);
  persistActiveTabs();
  return { active: true };
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'toggle') {
    const tabId = message.tabId;
    toggleTab(tabId).then((result) => {
      sendResponse(result);
    });
    return true; // async response
  }

  if (message.action === 'getTabState') {
    // Called by content script on page load
    const tabId = sender.tab?.id;
    if (tabId && activeTabs.has(tabId)) {
      getServerUrl().then((serverUrl) => {
        sendResponse({
          active: true,
          serverUrl,
          sessionId: tabSessionMap.get(tabId) || null,
        });
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
        sessionId: tabSessionMap.get(tabId) || null,
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

  if (message.action === 'getSessions') {
    getServerUrl().then(serverUrl => {
      fetchSessions(serverUrl).then(sessions => {
        sendResponse({ sessions });
      });
    });
    return true; // async response
  }

  if (message.action === 'selectSession') {
    // User picked a session from the popup picker
    const { tabId, sessionId } = message;
    tabSessionMap.set(tabId, sessionId);
    activeTabs.add(tabId);

    getServerUrl().then(async (serverUrl) => {
      await sendToTab(tabId, { action: 'activate', serverUrl, sessionId });
      updateBadge(tabId, true);
      persistActiveTabs();
      sendResponse({ active: true });
    });
    return true; // async response
  }
});

// Re-inject widget when an active tab navigates to a new page
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && activeTabs.has(tabId)) {
    const serverUrl = await getServerUrl();
    const sessionId = tabSessionMap.get(tabId) || null;
    updateBadge(tabId, true);
    await sendToTab(tabId, { action: 'activate', serverUrl, sessionId });
  }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabs.has(tabId)) {
    activeTabs.delete(tabId);
    tabSessionMap.delete(tabId);
    persistActiveTabs();
  }
});
