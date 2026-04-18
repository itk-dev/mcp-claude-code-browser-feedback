/**
 * Content script for Claude Code Browser Feedback extension.
 *
 * Runs in the ISOLATED world. Injects/removes the widget by adding or
 * removing a <script src="...widget.js"> tag in the page's MAIN world.
 */

let injectedScript = null;

function activate(serverUrl, sessionId) {
  if (injectedScript) return; // already active

  injectedScript = document.createElement('script');
  const url = sessionId
    ? `${serverUrl}/widget.js?session=${sessionId}`
    : `${serverUrl}/widget.js`;
  injectedScript.src = url;
  injectedScript.id = 'claude-feedback-ext-script';
  document.documentElement.appendChild(injectedScript);
}

function deactivate() {
  // Call destroy() in the MAIN world via an inline script
  const teardown = document.createElement('script');
  teardown.textContent = `
    if (typeof window.__claudeFeedbackDestroy === 'function') {
      window.__claudeFeedbackDestroy();
    }
  `;
  document.documentElement.appendChild(teardown);
  teardown.remove();

  // Remove the injected widget script tag
  if (injectedScript) {
    injectedScript.remove();
    injectedScript = null;
  }
  // Also remove any script tag that might have been left from a previous session
  const existing = document.getElementById('claude-feedback-ext-script');
  if (existing) existing.remove();
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'activate') {
    activate(message.serverUrl, message.sessionId);
    sendResponse({ ok: true });
  } else if (message.action === 'deactivate') {
    deactivate();
    sendResponse({ ok: true });
  } else if (message.action === 'ping') {
    sendResponse({ ok: true });
  }
});

// On load, check if this tab should be active (handles navigation/reload)
chrome.runtime.sendMessage({ action: 'getTabState' }, (response) => {
  if (chrome.runtime.lastError) return; // extension context invalidated
  if (response && response.active) {
    activate(response.serverUrl, response.sessionId);
  }
});
