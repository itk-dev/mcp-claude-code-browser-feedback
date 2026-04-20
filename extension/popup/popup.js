const toggleEl = document.getElementById('toggle');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const serverUrlInput = document.getElementById('server-url');
const saveUrlBtn = document.getElementById('save-url');
const sessionPickerEl = document.getElementById('session-picker');
const sessionListEl = document.getElementById('session-list');
const activeSessionEl = document.getElementById('active-session');
const activeSessionName = document.getElementById('active-session-name');
const changeSessionBtn = document.getElementById('change-session');

let currentTabId = null;
let currentSessionId = null;

// Get the active tab ID
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Check if the MCP server is reachable
async function checkConnection(serverUrl, sessionId) {
  try {
    const url = sessionId
      ? `${serverUrl}/status?session=${sessionId}`
      : `${serverUrl}/status`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const data = await resp.json();
      const count = data.connectedClients || 0;
      statusDot.className = 'status-dot connected';
      statusText.textContent = `Connected (${count} client${count !== 1 ? 's' : ''}, port ${data.port || serverUrl.split(':').pop()})`;
      return true;
    }
  } catch {
    // not reachable
  }
  statusDot.className = 'status-dot disconnected';
  statusText.textContent = 'Server not reachable';
  return false;
}

// Show session picker for manual selection
function showSessionPicker(sessions) {
  sessionListEl.innerHTML = '';

  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item';

    const dirEl = document.createElement('div');
    dirEl.className = 'session-item-dir';
    // Show last path segment as label, full path as tooltip
    const dirLabel = session.projectDir.split('/').pop() || session.projectDir;
    dirEl.textContent = dirLabel;
    dirEl.title = session.projectDir;
    item.appendChild(dirEl);

    if (session.projectUrl) {
      const urlEl = document.createElement('div');
      urlEl.className = 'session-item-url';
      urlEl.textContent = session.projectUrl;
      item.appendChild(urlEl);
    }

    item.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'selectSession',
        tabId: currentTabId,
        sessionId: session.sessionId,
      }, () => {
        sessionPickerEl.style.display = 'none';
        init();
      });
    });

    sessionListEl.appendChild(item);
  }

  sessionPickerEl.style.display = 'block';
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
    currentSessionId = response.sessionId || null;
    sessionPickerEl.style.display = 'none';
    await checkConnection(response.serverUrl, currentSessionId);

    // Show active session info
    if (currentSessionId) {
      chrome.runtime.sendMessage({ action: 'getSessions' }, (sessionsResp) => {
        if (sessionsResp && sessionsResp.sessions) {
          const matched = sessionsResp.sessions.find(s => s.sessionId === currentSessionId);
          activeSessionName.textContent = matched
            ? (matched.projectDir.split('/').pop() || matched.projectDir)
            : currentSessionId.slice(0, 8) + '...';
          activeSessionName.title = matched ? matched.projectDir : currentSessionId;
          activeSessionEl.style.display = 'flex';
        }
      });
    } else {
      activeSessionEl.style.display = 'none';
    }
  });
}

// Toggle handler
toggleEl.addEventListener('change', () => {
  if (currentTabId === null) return;
  chrome.runtime.sendMessage({ action: 'toggle', tabId: currentTabId }, (response) => {
    if (chrome.runtime.lastError) return;
    if (!response) return;

    if (response.needsSessionPicker) {
      // Multiple sessions, no auto-match — show picker
      toggleEl.checked = false;
      chrome.runtime.sendMessage({ action: 'getSessions' }, (sessionsResp) => {
        if (sessionsResp && sessionsResp.sessions) {
          showSessionPicker(sessionsResp.sessions);
        }
      });
    } else {
      toggleEl.checked = response.active ?? false;
      sessionPickerEl.style.display = 'none';
    }
  });
});

// Change session button
changeSessionBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getSessions' }, (sessionsResp) => {
    if (sessionsResp && sessionsResp.sessions) {
      showSessionPicker(sessionsResp.sessions);
    }
  });
});

// Save server URL
saveUrlBtn.addEventListener('click', () => {
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  if (!url) return;

  chrome.runtime.sendMessage({ action: 'setServerUrl', serverUrl: url }, () => {
    checkConnection(url, currentSessionId);
  });
});

init();
