const toggleEl = document.getElementById('toggle');
const widgetDetailsEl = document.getElementById('widget-details');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const serverUrlInput = document.getElementById('server-url');
const saveUrlBtn = document.getElementById('save-url');
const sessionPickerEl = document.getElementById('session-picker');
const sessionListEl = document.getElementById('session-list');
const activeSessionEl = document.getElementById('active-session');
const activeSessionName = document.getElementById('active-session-name');
const changeSessionBtn = document.getElementById('change-session');
const connectionNoticeEl = document.getElementById('connection-notice');

let currentTabId = null;
let currentSessionId = null;

// Get the active tab ID
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Check if the MCP server is reachable and update status display
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
      if (sessionId && count > 0) {
        statusText.textContent = `Connected (${count} client${count !== 1 ? 's' : ''})`;
      } else {
        statusText.textContent = 'Connected';
      }
      // Show notice when multiple clients on same session
      if (sessionId && count > 1) {
        connectionNoticeEl.textContent = `This session has ${count} connected clients. The same site may be open in another tab.`;
        connectionNoticeEl.style.display = 'block';
      } else {
        connectionNoticeEl.style.display = 'none';
      }
      return true;
    }
  } catch {
    // not reachable
  }
  statusDot.className = 'status-dot disconnected';
  statusText.textContent = 'Server not reachable';
  connectionNoticeEl.style.display = 'none';
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

// Show widget details (status, session, server URL)
async function showDetails(serverUrl, sessionId) {
  widgetDetailsEl.style.display = 'block';
  serverUrlInput.value = serverUrl;
  currentSessionId = sessionId;

  await checkConnection(serverUrl, sessionId);

  // Show active session info
  if (sessionId) {
    chrome.runtime.sendMessage({ action: 'getSessions' }, (sessionsResp) => {
      if (sessionsResp && sessionsResp.sessions) {
        const matched = sessionsResp.sessions.find(s => s.sessionId === sessionId);
        activeSessionName.textContent = matched
          ? (matched.projectDir.split('/').pop() || matched.projectDir)
          : sessionId.slice(0, 8) + '...';
        activeSessionName.title = matched ? matched.projectDir : sessionId;
        activeSessionEl.style.display = 'flex';
      }
    });
  } else {
    activeSessionEl.style.display = 'none';
  }
}

// Hide widget details
function hideDetails() {
  widgetDetailsEl.style.display = 'none';
  sessionPickerEl.style.display = 'none';
  connectionNoticeEl.style.display = 'none';
  activeSessionEl.style.display = 'none';
}

// Initialize popup state
async function init() {
  const tab = await getCurrentTab();
  if (!tab) return;
  currentTabId = tab.id;

  chrome.runtime.sendMessage({ action: 'getState', tabId: currentTabId }, async (response) => {
    if (chrome.runtime.lastError) return;
    if (!response) return;

    toggleEl.checked = response.active;

    if (response.active) {
      await showDetails(response.serverUrl, response.sessionId || null);
    } else {
      hideDetails();
    }
  });
}

// Toggle handler
toggleEl.addEventListener('change', () => {
  if (currentTabId === null) return;
  chrome.runtime.sendMessage({ action: 'toggle', tabId: currentTabId }, async (response) => {
    if (chrome.runtime.lastError) return;
    if (!response) return;

    if (response.needsSessionPicker) {
      toggleEl.checked = false;
      // Show details container for the session picker
      widgetDetailsEl.style.display = 'block';
      chrome.runtime.sendMessage({ action: 'getState', tabId: currentTabId }, (stateResp) => {
        if (stateResp) serverUrlInput.value = stateResp.serverUrl;
      });
      chrome.runtime.sendMessage({ action: 'getSessions' }, (sessionsResp) => {
        if (sessionsResp && sessionsResp.sessions) {
          showSessionPicker(sessionsResp.sessions);
        }
      });
    } else {
      toggleEl.checked = response.active ?? false;
      sessionPickerEl.style.display = 'none';
      if (response.active) {
        // Re-init to fetch session info and show details
        init();
      } else {
        hideDetails();
      }
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
