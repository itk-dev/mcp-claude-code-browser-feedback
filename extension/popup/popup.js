const toggleEl = document.getElementById('toggle');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const serverUrlInput = document.getElementById('server-url');
const saveUrlBtn = document.getElementById('save-url');

let currentTabId = null;

// Get the active tab ID
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Check if the MCP server is reachable
async function checkConnection(serverUrl) {
  try {
    const resp = await fetch(`${serverUrl}/status`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const data = await resp.json();
      statusDot.className = 'status-dot connected';
      statusText.textContent = `Connected (${data.connectedClients || 0} client${(data.connectedClients || 0) !== 1 ? 's' : ''}, port ${data.port || serverUrl.split(':').pop()})`;
      return true;
    }
  } catch {
    // not reachable
  }
  statusDot.className = 'status-dot disconnected';
  statusText.textContent = 'Server not reachable';
  return false;
}

// Initialize popup state
async function init() {
  const tab = await getCurrentTab();
  if (!tab) return;
  currentTabId = tab.id;

  // Get current state from background
  chrome.runtime.sendMessage({ action: 'getState', tabId: currentTabId }, async (response) => {
    if (chrome.runtime.lastError) return;
    if (!response) return;

    toggleEl.checked = response.active;
    serverUrlInput.value = response.serverUrl;
    await checkConnection(response.serverUrl);
  });
}

// Toggle handler
toggleEl.addEventListener('change', () => {
  if (currentTabId === null) return;
  chrome.runtime.sendMessage({ action: 'toggle', tabId: currentTabId }, (response) => {
    if (chrome.runtime.lastError) return;
    toggleEl.checked = response?.active ?? false;
  });
});

// Save server URL
saveUrlBtn.addEventListener('click', () => {
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  if (!url) return;

  chrome.runtime.sendMessage({ action: 'setServerUrl', serverUrl: url }, () => {
    checkConnection(url);
  });
});

init();
