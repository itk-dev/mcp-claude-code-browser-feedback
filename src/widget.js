/**
 * Browser Feedback Widget for Claude Code
 * 
 * This widget provides a floating button that allows users to:
 * - Select elements on the page
 * - Capture screenshots
 * - Add descriptions
 * - Send feedback directly to Claude Code via WebSocket
 */

(function() {
  'use strict';

  // Prevent double initialization (JS-level, not DOM-level)
  if (window.__CLAUDE_FEEDBACK_WIDGET__) {
    console.log('[Claude Feedback] Widget already initialized');
    return;
  }
  window.__CLAUDE_FEEDBACK_WIDGET__ = true;

  let shadowRoot = null;    // Shadow DOM root for style isolation

  // Configuration
  const WS_URL = '__WEBSOCKET_URL__'; // Injected by server
  const WIDGET_VERSION = '__WIDGET_VERSION__'; // Injected by server
  const WIDGET_ID = 'claude-feedback-widget';
  
  // State
  let ws = null;
  let isConnected = false;
  let isAnnotationMode = false;
  let selectedElement = null;
  let consoleLogs = [];
  let networkErrors = [];
  let pendingItems = [];
  let localPendingItems = [];  // Client-side storage for offline mode
  let isPendingQueueOpen = false;

  // Platform detection for keyboard shortcuts
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modifierKey = isMac ? 'metaKey' : 'ctrlKey';
  const modifierSymbol = isMac ? '⌘' : 'Ctrl+';

  // Helper to get widget elements from shadow root
  function getEl(id) {
    return shadowRoot ? shadowRoot.getElementById(id) : null;
  }

  // References for cleanup (populated by bindEvents / startSelfHealing / connectWebSocket)
  let _listeners = {};        // Named event listener refs from bindEvents
  let _selfHealObserver = null;
  let _selfHealInterval = null;
  let _wsReconnectTimeout = null;

  // ============================================
  // Console Log Capture
  // ============================================
  
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  function captureConsoleLogs() {
    ['log', 'warn', 'error'].forEach(method => {
      console[method] = function(...args) {
        consoleLogs.push({
          type: method,
          timestamp: new Date().toISOString(),
          message: args.map(arg => {
            try {
              return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
            } catch {
              return String(arg);
            }
          }).join(' '),
        });
        // Keep only last 50 logs
        if (consoleLogs.length > 50) consoleLogs.shift();
        originalConsole[method].apply(console, args);
      };
    });
  }

  // Capture unhandled errors
  function onWindowError(event) {
    consoleLogs.push({
      type: 'error',
      timestamp: new Date().toISOString(),
      message: `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
      stack: event.error?.stack,
    });
  }
  window.addEventListener('error', onWindowError);

  // ============================================
  // Styles
  // ============================================

  const styles = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      z-index: 2147483647;
    }

    .cf-root {
      all: initial;
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #374151;
      color-scheme: light;
      -webkit-text-size-adjust: 100%;
    }

    .cf-root *, .cf-root *::before, .cf-root *::after {
      box-sizing: border-box;
    }

    .cf-root input, .cf-root textarea, .cf-root select, .cf-root button {
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      color: inherit;
    }

    #${WIDGET_ID}-button {
      background: linear-gradient(135deg, #da7756 0%, #e78d6d 100%);
      color: white;
      border: none;
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(218, 119, 86, 0.4);
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #${WIDGET_ID}-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(218, 119, 86, 0.5);
    }

    #${WIDGET_ID}-button .shortcut-hint {
      font-size: 11px;
      opacity: 0.8;
      margin-left: 4px;
      background: rgba(255, 255, 255, 0.2);
      padding: 2px 6px;
      border-radius: 4px;
    }

    #${WIDGET_ID}-button.disconnected {
      background: linear-gradient(135deg, #6b7280 0%, #9ca3af 100%);
      box-shadow: 0 4px 12px rgba(107, 114, 128, 0.4);
    }

    #${WIDGET_ID}-button .claude-icon {
      flex-shrink: 0;
    }

    /* Button group container */
    #${WIDGET_ID}-button-group {
      display: none;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    #${WIDGET_ID}-button-group.visible {
      display: flex;
    }

    /* Shared button group segment style */
    #${WIDGET_ID}-button-group button {
      border: none;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: filter 0.15s ease;
      color: white;
    }

    #${WIDGET_ID}-button-group button:hover {
      filter: brightness(1.1);
    }

    /* + Add segment */
    #${WIDGET_ID}-add-btn {
      background: linear-gradient(135deg, #da7756 0%, #e78d6d 100%);
    }

    /* Pending segment */
    #${WIDGET_ID}-pending-btn {
      background: #ffffff;
      color: #1f2937 !important;
      border-left: 1px solid #e5e7eb !important;
      border-right: 1px solid #e5e7eb !important;
    }

    /* Pending count badge */
    #${WIDGET_ID}-pending-count {
      background: #da7756;
      color: white;
      font-size: 11px;
      font-weight: 700;
      min-width: 20px;
      height: 20px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 6px;
    }

    /* Send segment */
    #${WIDGET_ID}-send-btn-group {
      background: linear-gradient(135deg, #22c55e 0%, #4ade80 100%);
    }

    #${WIDGET_ID}-queue-panel {
      position: fixed;
      bottom: 60px;
      right: 20px;
      width: 320px;
      max-width: 90vw;
      max-height: 300px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      z-index: 2147483646;
      display: none;
      flex-direction: column;
      overflow: hidden;
    }

    #${WIDGET_ID}-queue-panel.active {
      display: flex;
    }

    #${WIDGET_ID}-queue-header {
      background: #f3f4f6;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #e5e7eb;
    }

    #${WIDGET_ID}-queue-header h4 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: #374151;
    }

    #${WIDGET_ID}-queue-close {
      background: none;
      border: none;
      color: #6b7280;
      font-size: 18px;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
    }

    #${WIDGET_ID}-queue-close:hover {
      color: #374151;
    }

    #${WIDGET_ID}-queue-footer {
      display: none;
      gap: 8px;
      padding: 10px 16px;
      border-top: 1px solid #e5e7eb;
      background: #f9fafb;
    }

    #${WIDGET_ID}-queue-footer button {
      flex: 1;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid #e5e7eb;
      background: white;
      color: #374151;
      transition: all 0.15s ease;
    }

    #${WIDGET_ID}-queue-footer button:hover {
      background: #f3f4f6;
      border-color: #d1d5db;
    }

    #${WIDGET_ID}-queue-list {
      overflow-y: auto;
      flex: 1;
      padding: 8px 0;
    }

    #${WIDGET_ID}-queue-empty {
      padding: 24px;
      text-align: center;
      color: #9ca3af;
      font-size: 13px;
    }

    .${WIDGET_ID}-queue-item {
      padding: 10px 16px;
      border-bottom: 1px solid #f3f4f6;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .${WIDGET_ID}-queue-item:last-child {
      border-bottom: none;
    }

    .${WIDGET_ID}-queue-item-content {
      flex: 1;
      min-width: 0;
    }

    .${WIDGET_ID}-queue-item-selector {
      font-family: monospace;
      font-size: 11px;
      color: #6b7280;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .${WIDGET_ID}-queue-item-description {
      font-size: 13px;
      color: #374151;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .${WIDGET_ID}-queue-item-time {
      font-size: 11px;
      color: #9ca3af;
      margin-top: 4px;
    }

    .${WIDGET_ID}-queue-item-delete {
      background: none;
      border: none;
      color: #9ca3af;
      cursor: pointer;
      padding: 4px;
      font-size: 14px;
      line-height: 1;
      flex-shrink: 0;
    }

    .${WIDGET_ID}-queue-item-delete:hover {
      color: #ef4444;
    }

    #${WIDGET_ID}-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.3);
      z-index: 2147483646;
      cursor: crosshair;
      display: none;
    }

    #${WIDGET_ID}-overlay.active {
      display: block;
    }

    #${WIDGET_ID}-highlight {
      position: fixed;
      pointer-events: none;
      border: 3px solid #da7756;
      background: rgba(218, 119, 86, 0.1);
      border-radius: 4px;
      z-index: 2147483646;
      display: none;
    }

    #${WIDGET_ID}-highlight.selected {
      border-color: #3b82f6;
      background: rgba(59, 130, 246, 0.1);
    }

    #${WIDGET_ID}-tooltip {
      position: fixed;
      background: #1f2937;
      color: white;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      z-index: 2147483647;
      pointer-events: none;
      display: none;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${WIDGET_ID}-panel {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 400px;
      max-width: 90vw;
      max-height: 80vh;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
      z-index: 2147483647;
      display: none;
      overflow: hidden;
    }

    #${WIDGET_ID}-panel.active {
      display: flex;
      flex-direction: column;
    }

    #${WIDGET_ID}-panel.minimized {
      max-height: none;
      height: auto;
    }

    #${WIDGET_ID}-panel.minimized #${WIDGET_ID}-panel-body {
      display: none;
    }

    #${WIDGET_ID}-panel-header {
      background: linear-gradient(135deg, #da7756 0%, #e78d6d 100%);
      color: white;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
      user-select: none;
    }

    #${WIDGET_ID}-panel-header h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    #${WIDGET_ID}-panel-controls {
      display: flex;
      gap: 6px;
    }

    #${WIDGET_ID}-panel-minimize,
    #${WIDGET_ID}-panel-close {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #${WIDGET_ID}-panel-minimize:hover,
    #${WIDGET_ID}-panel-close:hover {
      background: rgba(255, 255, 255, 0.3);
    }

    #${WIDGET_ID}-panel-body {
      padding: 20px;
      overflow-y: auto;
      max-height: calc(90vh - 60px);
    }

    #${WIDGET_ID}-screenshot-preview {
      width: 100%;
      border-radius: 8px;
      border: 1px solid #e5e7eb;
      margin-bottom: 16px;
      max-height: 200px;
      object-fit: contain;
      background: #f9fafb;
    }

    #${WIDGET_ID}-element-info-wrapper {
      margin-bottom: 16px;
    }

    #${WIDGET_ID}-element-info-toggle {
      background: none;
      border: none;
      color: #6b7280;
      font-size: 13px;
      cursor: pointer;
      padding: 4px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    #${WIDGET_ID}-element-info-toggle:hover {
      color: #374151;
    }

    #${WIDGET_ID}-element-info-toggle .toggle-icon {
      font-size: 10px;
      transition: transform 0.2s ease;
    }

    #${WIDGET_ID}-element-info-wrapper.expanded #${WIDGET_ID}-element-info-toggle .toggle-icon {
      transform: rotate(90deg);
    }

    #${WIDGET_ID}-element-info {
      background: #f3f4f6;
      color: #374151;
      padding: 12px;
      border-radius: 8px;
      font-family: monospace;
      font-size: 12px;
      margin-top: 8px;
      word-break: break-all;
      display: none;
    }

    #${WIDGET_ID}-element-info-wrapper.expanded #${WIDGET_ID}-element-info {
      display: block;
    }

    #${WIDGET_ID}-description {
      width: 100%;
      min-height: 100px;
      padding: 12px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 14px;
      resize: vertical;
      margin-bottom: 16px;
      background: white;
    }

    #${WIDGET_ID}-description:focus {
      outline: none;
      border-color: #da7756;
    }

    #${WIDGET_ID}-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    #${WIDGET_ID}-options label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: #374151;
      cursor: pointer;
    }

    #${WIDGET_ID}-options input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: #da7756;
    }

    #${WIDGET_ID}-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    }

    #${WIDGET_ID}-actions button {
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    #${WIDGET_ID}-cancel-btn {
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      color: #374151;
    }

    #${WIDGET_ID}-cancel-btn:hover {
      background: #e5e7eb;
    }

    #${WIDGET_ID}-send-btn {
      background: linear-gradient(135deg, #da7756 0%, #e78d6d 100%);
      border: none;
      color: white;
    }

    #${WIDGET_ID}-send-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(218, 119, 86, 0.4);
    }

    #${WIDGET_ID}-send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    #${WIDGET_ID}-send-btn .shortcut-hint {
      font-size: 11px;
      opacity: 0.7;
      margin-left: 6px;
    }

    #${WIDGET_ID}-instructions {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #1f2937;
      color: white;
      padding: 12px 24px;
      border-radius: 12px;
      font-size: 14px;
      z-index: 2147483647;
      display: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    #${WIDGET_ID}-instructions.active {
      display: block;
    }

    #${WIDGET_ID}-success {
      position: fixed;
      top: 20px;
      right: 20px;
      background: #22c55e;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      z-index: 2147483647;
      display: none;
      animation: slideIn 0.3s ease;
    }

    #${WIDGET_ID}-error {
      position: fixed;
      top: 20px;
      right: 20px;
      background: #ef4444;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      z-index: 2147483647;
      display: none;
      animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    @keyframes countBump {
      0%   { transform: scale(1); }
      40%  { transform: scale(1.3); }
      100% { transform: scale(1); }
    }
  `;

  // ============================================
  // HTML Structure
  // ============================================

  function createWidget() {
    // Remove stale remnants to make this idempotent
    const existing = document.getElementById(WIDGET_ID);
    if (existing) existing.remove();

    // Create host element and attach shadow root
    const host = document.createElement('div');
    host.id = WIDGET_ID;
    shadowRoot = host.attachShadow({ mode: 'open' });

    // Inject styles into shadow root
    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    shadowRoot.appendChild(styleEl);

    // Create widget content inside shadow root
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="cf-root">
      <div id="${WIDGET_ID}-button-area" style="position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 10px;">
        <!-- State 1: Single button (shown when no pending items) -->
        <button id="${WIDGET_ID}-button" class="disconnected" title="Click to annotate an element and send feedback to Claude. Add multiple items before sending.">
          <svg class="claude-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H4.104v-.08l2.878-1.17-.107-.312h-.063L3.87 12.802v-.064l6.048-3.318V9.3L4.14 6.622l.064-.064 4.848 1.336.063-.063-.08-.392L4.66 3.893 8.34 5.58l.312-.072V5.34L6.35 2.766l2.374 1.68.08-.064-.032-.44L6.83.782 9.3 3.67l.12-.048.064-3.59h.064l.663 3.222.168.056L12.12.614v.064l-.92 3.406.072.128h.08L14.12.766v.08l-1.92 3.83.064.104 3.63-2.63-.064.08-2.35 3.734.04.12.128.024 3.934-1.4-.08.08-3.07 2.63v.08l.112.063 3.83-.92-.064.08-3.35 1.6v.04l.12.128 3.566.128-.08.064-3.606.695-.064.136.032.048 3.83 1.4-.08.048-3.83-.015-.128.104-.008.072 3.35 2.446-.08.032-3.59-1.344-.12.064-.04.104 2.342 3.35-.08.016-2.998-2.566-.088.056-.128.168.87 3.95h-.08l-1.664-3.35-.112-.04-.08.04-.6 4.12h-.064l.12-3.862-.12-.136-.088.008-1.92 3.398-.048-.064.84-3.83-.072-.12-.136-.024-2.566 2.998-.032-.08 1.824-3.59-.056-.128-.104-.024-3.19 1.824.048-.08 2.566-2.87-.048-.127-.12-.016-3.67.463z"/>
          </svg>
          <span>Add annotation</span>
          <span class="shortcut-hint" id="${WIDGET_ID}-button-shortcut" style="display: none;">Shift+C</span>
        </button>

        <!-- State 2: Button group (shown when pending items exist) -->
        <div id="${WIDGET_ID}-button-group">
          <button id="${WIDGET_ID}-add-btn" title="Add another annotation">
            <span>+ Add</span>
          </button>
          <button id="${WIDGET_ID}-pending-btn">
            <span>Pending</span>
            <span id="${WIDGET_ID}-pending-count">0</span>
          </button>
          <button id="${WIDGET_ID}-send-btn-group" title="Send all feedback to Claude">
            <span>Send</span>
          </button>
        </div>
      </div>

      <div id="${WIDGET_ID}-queue-panel">
        <div id="${WIDGET_ID}-queue-header">
          <h4>Pending Feedback</h4>
          <button id="${WIDGET_ID}-queue-close" title="Close">×</button>
        </div>
        <div id="${WIDGET_ID}-queue-list">
          <div id="${WIDGET_ID}-queue-empty">No pending feedback</div>
        </div>
        <div id="${WIDGET_ID}-queue-footer" style="display: none;">
          <button id="${WIDGET_ID}-export-md-btn">Export Markdown</button>
          <button id="${WIDGET_ID}-export-gh-btn">Create GitHub Issue</button>
        </div>
      </div>

      <div id="${WIDGET_ID}-overlay"></div>
      <div id="${WIDGET_ID}-highlight"></div>
      <div id="${WIDGET_ID}-tooltip"></div>
      
      <div id="${WIDGET_ID}-instructions">
        Click on any element to select it, or press <strong>Escape</strong> to cancel
      </div>
      
      <div id="${WIDGET_ID}-panel">
        <div id="${WIDGET_ID}-panel-header">
          <h3>Report annotation to Claude</h3>
          <div id="${WIDGET_ID}-panel-controls">
            <button id="${WIDGET_ID}-panel-minimize" title="Minimize">−</button>
            <button id="${WIDGET_ID}-panel-close" title="Close">×</button>
          </div>
        </div>
        <div id="${WIDGET_ID}-panel-body">
          <img id="${WIDGET_ID}-screenshot-preview" alt="Screenshot" />
          <textarea
            id="${WIDGET_ID}-description"
            placeholder="Describe what's wrong or what you'd like to change..."
          ></textarea>
          <div id="${WIDGET_ID}-element-info-wrapper">
            <button id="${WIDGET_ID}-element-info-toggle" type="button">
              <span class="toggle-icon">▶</span> Element Details
            </button>
            <div id="${WIDGET_ID}-element-info"></div>
          </div>
          <div id="${WIDGET_ID}-options">
            <label>
              <input type="checkbox" id="${WIDGET_ID}-include-screenshot" checked />
              Include screenshot (element area)
            </label>
            <label>
              <input type="checkbox" id="${WIDGET_ID}-include-logs" checked />
              <span id="${WIDGET_ID}-include-logs-text">Include console logs (${consoleLogs.length} captured)</span>
            </label>
            <label>
              <input type="checkbox" id="${WIDGET_ID}-include-styles" checked />
              Include computed styles
            </label>
          </div>
          <div id="${WIDGET_ID}-actions">
            <button id="${WIDGET_ID}-cancel-btn">Cancel</button>
            <button id="${WIDGET_ID}-send-btn">Add item<span class="shortcut-hint">${modifierSymbol}↵</span></button>
          </div>
        </div>
      </div>
      
      <div id="${WIDGET_ID}-success"></div>
      <div id="${WIDGET_ID}-error"></div>
      </div>

    `;

    // Move all children from container into shadow root
    while (container.firstChild) {
      shadowRoot.appendChild(container.firstChild);
    }

    document.body.appendChild(host);
    bindEvents();
  }

  // ============================================
  // Element Selection
  // ============================================

  function getElementSelector(el) {
    if (el.id) return `#${el.id}`;
    
    let selector = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      selector += '.' + el.className.trim().split(/\s+/).join('.');
    }
    
    // Add position if not unique
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        child => child.tagName === el.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    
    return selector;
  }

  function getTruncatedSelector(el, maxDepth = 2) {
    const parts = [];
    let current = el;
    let depth = 0;
    let hasMore = false;

    while (current && current !== document.documentElement && depth < maxDepth) {
      parts.unshift(getElementSelector(current));
      current = current.parentElement;
      depth++;
    }

    if (current && current !== document.documentElement) {
      hasMore = true;
    }

    return (hasMore ? '... > ' : '') + parts.join(' > ');
  }

  function getFullSelector(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.documentElement) {
      parts.unshift(getElementSelector(current));
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const styles = window.getComputedStyle(el);
    
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: el.className || null,
      selector: getElementSelector(el),
      fullSelector: getFullSelector(el),
      text: el.textContent?.slice(0, 200) || null,
      innerHTML: el.innerHTML?.slice(0, 500) || null,
      outerHTML: el.outerHTML?.slice(0, 1000) || null,
      attributes: Array.from(el.attributes || []).reduce((acc, attr) => {
        acc[attr.name] = attr.value;
        return acc;
      }, {}),
      boundingRect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
      computedStyles: {
        display: styles.display,
        position: styles.position,
        color: styles.color,
        backgroundColor: styles.backgroundColor,
        fontSize: styles.fontSize,
        fontWeight: styles.fontWeight,
        padding: styles.padding,
        margin: styles.margin,
        border: styles.border,
        opacity: styles.opacity,
        visibility: styles.visibility,
        zIndex: styles.zIndex,
      },
    };
  }

  // ============================================
  // Screenshot Capture
  // ============================================

  let html2canvasPromise = null;

  function loadHtml2Canvas() {
    if (typeof html2canvas !== 'undefined') return Promise.resolve();
    if (html2canvasPromise) return html2canvasPromise;

    // Derive HTTP URL from WS_URL (same host/port)
    let baseUrl;
    try {
      const wsUrl = new URL(WS_URL);
      baseUrl = `http://${wsUrl.host}`;
    } catch {
      baseUrl = `http://localhost:9877`;
    }

    const url = `${baseUrl}/html2canvas.min.js`;

    // Use fetch + new Function to avoid CSP script-src restrictions
    // (e.g. when loaded via browser extension on pages with strict CSP)
    html2canvasPromise = fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(scriptText => {
        new Function(scriptText)();
      })
      .catch(err => {
        html2canvasPromise = null;
        throw new Error('Failed to load html2canvas: ' + (err.message || err));
      });

    return html2canvasPromise;
  }

  async function captureScreenshot(targetElement) {
    try {
      await loadHtml2Canvas();
    } catch (err) {
      console.warn('[Claude Feedback] Could not load html2canvas:', err?.message || err);
      return null;
    }

    if (typeof html2canvas === 'undefined') return null;

    try {
      const widgetHost = document.getElementById(WIDGET_ID);
      const canvas = await html2canvas(document.body, {
        logging: false,
        useCORS: true,
        scale: 1,
        ignoreElements: (el) => el === widgetHost,
      });

      // If a target element is provided, crop to its bounding rect + padding
      if (targetElement) {
        const rect = targetElement.getBoundingClientRect();
        const padding = 50;

        const sx = Math.max(0, rect.left - padding);
        const sy = Math.max(0, rect.top - padding);
        const sw = Math.min(canvas.width - sx, rect.width + padding * 2);
        const sh = Math.min(canvas.height - sy, rect.height + padding * 2);

        const cropped = document.createElement('canvas');
        cropped.width = sw;
        cropped.height = sh;
        const ctx = cropped.getContext('2d');
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        return cropped.toDataURL('image/jpeg', 0.7);
      }

      return canvas.toDataURL('image/jpeg', 0.7);
    } catch (err) {
      console.warn('[Claude Feedback] html2canvas failed:', err?.message || err);
      return null;
    }
  }

  // ============================================
  // WebSocket Connection
  // ============================================

  function connectWebSocket() {
    try {
      ws = new WebSocket(WS_URL);
      
      ws.onopen = () => {
        isConnected = true;
        updateButtonState();
        console.log('[Claude Feedback] Connected to feedback server');
      };
      
      ws.onclose = () => {
        isConnected = false;
        updateButtonState();
        console.log('[Claude Feedback] Disconnected from feedback server');
        // Reconnect after delay
        _wsReconnectTimeout = setTimeout(connectWebSocket, 3000);
      };
      
      ws.onerror = (err) => {
        console.warn('[Claude Feedback] WebSocket error:', err);
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleServerMessage(message);
        } catch (err) {
          console.warn('[Claude Feedback] Error parsing message:', err);
        }
      };
    } catch (err) {
      console.warn('[Claude Feedback] Failed to connect:', err);
      _wsReconnectTimeout = setTimeout(connectWebSocket, 3000);
    }
  }

  // Helper to format relative time
  function formatRelativeTime(timestamp) {
    const now = new Date();
    const date = new Date(timestamp);
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    return date.toLocaleDateString();
  }

  function getAllPendingItems() {
    return isConnected ? pendingItems : localPendingItems;
  }

  // Update the button group visibility and queue list
  function updatePendingUI() {
    const mainButton = getEl(`${WIDGET_ID}-button`);
    const buttonGroup = getEl(`${WIDGET_ID}-button-group`);
    const pendingCount = getEl(`${WIDGET_ID}-pending-count`);
    const queueList = getEl(`${WIDGET_ID}-queue-list`);
    const queueEmpty = getEl(`${WIDGET_ID}-queue-empty`);
    const sendBtnGroup = getEl(`${WIDGET_ID}-send-btn-group`);
    const exportFooter = getEl(`${WIDGET_ID}-queue-footer`);

    const items = getAllPendingItems();
    const hasPending = items.length > 0;

    // Toggle between single button and button group
    if (mainButton) mainButton.style.display = hasPending ? 'none' : 'flex';
    if (buttonGroup) buttonGroup.classList.toggle('visible', hasPending);
    const prevCount = pendingCount ? parseInt(pendingCount.textContent, 10) || 0 : 0;
    if (pendingCount) pendingCount.textContent = items.length;

    // Hide Send button when offline, show export footer when items exist
    if (sendBtnGroup) sendBtnGroup.style.display = isConnected ? '' : 'none';
    if (exportFooter) exportFooter.style.display = hasPending ? 'flex' : 'none';

    // Subtle bump animation when count increases
    if (pendingCount && items.length > prevCount) {
      pendingCount.style.animation = 'none';
      // Force reflow to restart animation
      void pendingCount.offsetWidth;
      pendingCount.style.animation = 'countBump 0.3s ease';
    }

    // Close queue panel if no more items
    if (!hasPending) closeQueuePanel();

    if (queueList) {
      // Remove existing items (but keep the empty message element and footer)
      const existingItems = queueList.querySelectorAll(`.${WIDGET_ID}-queue-item`);
      existingItems.forEach(item => item.remove());

      if (items.length === 0) {
        if (queueEmpty) queueEmpty.style.display = 'block';
      } else {
        if (queueEmpty) queueEmpty.style.display = 'none';

        items.forEach(item => {
          const itemEl = document.createElement('div');
          itemEl.className = `${WIDGET_ID}-queue-item`;
          itemEl.dataset.id = item.id;

          const contentEl = document.createElement('div');
          contentEl.className = `${WIDGET_ID}-queue-item-content`;

          const selectorEl = document.createElement('div');
          selectorEl.className = `${WIDGET_ID}-queue-item-selector`;
          selectorEl.textContent = item.selector || item.element?.selector || 'Unknown element';
          contentEl.appendChild(selectorEl);

          if (item.description) {
            const descEl = document.createElement('div');
            descEl.className = `${WIDGET_ID}-queue-item-description`;
            descEl.textContent = item.description;
            contentEl.appendChild(descEl);
          }

          const timeEl = document.createElement('div');
          timeEl.className = `${WIDGET_ID}-queue-item-time`;
          timeEl.textContent = formatRelativeTime(item.timestamp);
          contentEl.appendChild(timeEl);

          itemEl.appendChild(contentEl);

          const deleteBtn = document.createElement('button');
          deleteBtn.className = `${WIDGET_ID}-queue-item-delete`;
          deleteBtn.title = 'Delete this feedback';
          deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deletePendingItem(item.id);
          });
          itemEl.appendChild(deleteBtn);

          queueList.appendChild(itemEl);
        });
      }
    }
  }

  // Toggle queue panel visibility
  function toggleQueuePanel() {
    const panel = getEl(`${WIDGET_ID}-queue-panel`);
    if (panel) {
      isPendingQueueOpen = !isPendingQueueOpen;
      panel.classList.toggle('active', isPendingQueueOpen);
    }
  }

  // Close queue panel
  function closeQueuePanel() {
    const panel = getEl(`${WIDGET_ID}-queue-panel`);
    if (panel) {
      isPendingQueueOpen = false;
      panel.classList.remove('active');
    }
  }

  // Delete a pending item
  function deletePendingItem(id) {
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'delete_feedback',
        id: id,
      }));
    } else {
      localPendingItems = localPendingItems.filter(item => item.id !== id);
      updatePendingUI();
    }
  }

  function handleServerMessage(message) {
    if (message.type === 'connected') {
      if (message.sessionWarning) {
        console.warn('[Claude Feedback]', message.sessionWarning);
      }
      if (message.duplicateWarning) {
        console.warn('[Claude Feedback]', message.duplicateWarning);
        showNotification(message.duplicateWarning);
      }
    } else if (message.type === 'pending_status') {
      // Update pending items from server
      pendingItems = message.items || [];
      updatePendingUI();
    } else if (message.type === 'feedback_deleted') {
      // Feedback was deleted - UI will update via pending_status broadcast
      if (message.success) {
        console.log('[Claude Feedback] Feedback deleted:', message.id);
      }
    } else if (message.type === 'request_annotation') {
      // Claude is asking for annotation
      showNotification(message.message || 'Claude is requesting your feedback');
      startAnnotationMode();
    } else if (message.type === 'request_multiple_annotations') {
      // Claude wants multiple annotations - just start annotation mode
      showNotification(message.message || 'Claude is requesting multiple annotations');
      startAnnotationMode();
    } else if (message.type === 'feedback_received') {
      showItemAdded();
    } else if (message.type === 'sent_to_claude') {
      showBatchSuccess(message.count);
    }
  }

  function updateButtonState() {
    const button = getEl(`${WIDGET_ID}-button`);
    const shortcutHint = getEl(`${WIDGET_ID}-button-shortcut`);
    if (button) {
      button.classList.toggle('disconnected', !isConnected);
    }
    if (shortcutHint) {
      shortcutHint.style.display = 'inline';
    }
  }

  // ============================================
  // Event Handlers
  // ============================================

  let hoveredElement = null;

  function bindEvents() {
    const button = getEl(`${WIDGET_ID}-button`);
    const overlay = getEl(`${WIDGET_ID}-overlay`);
    const highlight = getEl(`${WIDGET_ID}-highlight`);
    const tooltip = getEl(`${WIDGET_ID}-tooltip`);
    const panel = getEl(`${WIDGET_ID}-panel`);
    const panelHeader = getEl(`${WIDGET_ID}-panel-header`);
    const minimizeBtn = getEl(`${WIDGET_ID}-panel-minimize`);
    const closeBtn = getEl(`${WIDGET_ID}-panel-close`);
    const cancelBtn = getEl(`${WIDGET_ID}-cancel-btn`);
    const sendBtn = getEl(`${WIDGET_ID}-send-btn`);
    const elementInfoToggle = getEl(`${WIDGET_ID}-element-info-toggle`);
    const elementInfoWrapper = getEl(`${WIDGET_ID}-element-info-wrapper`);
    const queueCloseBtn = getEl(`${WIDGET_ID}-queue-close`);
    const addBtn = getEl(`${WIDGET_ID}-add-btn`);
    const pendingBtn = getEl(`${WIDGET_ID}-pending-btn`);
    const sendBtnGroup = getEl(`${WIDGET_ID}-send-btn-group`);

    // "+ Add" button — same as main button
    addBtn.addEventListener('click', () => {
      startAnnotationMode();
    });

    // "Pending" button — toggle queue panel
    pendingBtn.addEventListener('click', () => {
      if (pendingItems.length > 0) toggleQueuePanel();
    });

    // "Send" button — send to claude
    sendBtnGroup.addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN && pendingItems.length > 0) {
        ws.send(JSON.stringify({ type: 'send_to_claude' }));
      }
    });

    // Queue panel close button
    queueCloseBtn.addEventListener('click', closeQueuePanel);

    // Export Markdown button
    const exportMdBtn = getEl(`${WIDGET_ID}-export-md-btn`);
    exportMdBtn.addEventListener('click', () => {
      const items = getAllPendingItems();
      if (items.length === 0) return;
      const md = generateMarkdown(items);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadFile(md, `feedback-${timestamp}.md`, 'text/markdown');
    });

    // Export GitHub Issue button
    const exportGhBtn = getEl(`${WIDGET_ID}-export-gh-btn`);
    exportGhBtn.addEventListener('click', () => {
      const items = getAllPendingItems();
      if (items.length === 0) return;

      let repo = localStorage.getItem('claude-feedback-github-repo');
      if (!repo) {
        repo = prompt('Enter GitHub repository (owner/repo):');
        if (!repo || !repo.includes('/')) {
          showError('Invalid repository format. Use owner/repo.');
          return;
        }
        localStorage.setItem('claude-feedback-github-repo', repo);
      }

      const md = generateMarkdown(items);
      const title = `Browser Feedback: ${items.length} item${items.length !== 1 ? 's' : ''} from ${new URL(items[0]?.url || window.location.href).hostname}`;

      // Truncate body to stay within URL length limits (~6000 chars)
      const maxBodyLength = 6000;
      const body = md.length > maxBodyLength
        ? md.slice(0, maxBodyLength) + '\n\n... (truncated, export as Markdown for full report)'
        : md;

      const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      window.open(url, '_blank');
    });

    // Element info toggle
    elementInfoToggle.addEventListener('click', () => {
      elementInfoWrapper.classList.toggle('expanded');
    });

    // Main button click
    button.addEventListener('click', () => {
      startAnnotationMode();
    });

    // Minimize button
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('minimized');
      minimizeBtn.textContent = panel.classList.contains('minimized') ? '+' : '−';
    });

    // Make panel draggable
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    panelHeader.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      dragOffsetX = e.clientX - panel.offsetLeft;
      dragOffsetY = e.clientY - panel.offsetTop;
      panel.style.transition = 'none';
    });

    function onDocumentMousemove(e) {
      if (!isDragging) return;
      const x = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - panel.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - panel.offsetHeight));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    }
    _listeners.onDocumentMousemove = onDocumentMousemove;
    document.addEventListener('mousemove', onDocumentMousemove);

    function onDocumentMouseup() {
      isDragging = false;
      panel.style.transition = '';
    }
    _listeners.onDocumentMouseup = onDocumentMouseup;
    document.addEventListener('mouseup', onDocumentMouseup);

    // Keep panel in viewport on resize
    function onWindowResize() {
      if (!panel.classList.contains('active')) return;
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        panel.style.left = Math.max(0, window.innerWidth - panel.offsetWidth) + 'px';
        panel.style.right = 'auto';
      }
      if (rect.bottom > window.innerHeight) {
        panel.style.top = Math.max(0, window.innerHeight - panel.offsetHeight) + 'px';
      }
    }
    _listeners.onWindowResize = onWindowResize;
    window.addEventListener('resize', onWindowResize);

    // Overlay mouse events
    overlay.addEventListener('mousemove', (e) => {
      if (!isAnnotationMode) return;
      
      // Get element under cursor (temporarily hide overlay)
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'auto';
      
      if (el && !el.closest(`#${WIDGET_ID}`)) {
        hoveredElement = el;
        const rect = el.getBoundingClientRect();
        
        highlight.style.display = 'block';
        highlight.style.top = rect.top + 'px';
        highlight.style.left = rect.left + 'px';
        highlight.style.width = rect.width + 'px';
        highlight.style.height = rect.height + 'px';
        
        tooltip.style.display = 'block';
        tooltip.textContent = getTruncatedSelector(el);

        // Position tooltip above element, or below if it would go off-screen
        if (rect.top - 40 < 0) {
          tooltip.style.top = (rect.bottom + 8) + 'px';
        } else {
          tooltip.style.top = (rect.top - 40) + 'px';
        }

        // Clamp horizontal position to keep tooltip on screen
        const tooltipLeft = Math.max(4, Math.min(rect.left, window.innerWidth - 308));
        tooltip.style.left = tooltipLeft + 'px';
      }
    });

    overlay.addEventListener('click', (e) => {
      if (!isAnnotationMode || !hoveredElement) return;
      e.preventDefault();
      e.stopPropagation();
      
      selectedElement = hoveredElement;
      stopAnnotationMode();
      showPanel();
    });

    // Global keyboard shortcuts
    function onDocumentKeydown(e) {
      // Escape to cancel annotation mode or close panels
      if (e.key === 'Escape') {
        const panel = getEl(`${WIDGET_ID}-panel`);
        if (panel && panel.classList.contains('active')) {
          e.stopPropagation();
          hidePanel();
          return;
        }
        if (isPendingQueueOpen) {
          e.stopPropagation();
          closeQueuePanel();
          return;
        }
        if (isAnnotationMode) {
          e.stopPropagation();
          stopAnnotationMode();
          return;
        }
      }

      // Shift+C to start annotation mode
      if (e.key === 'C' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Don't trigger when the feedback panel is open
        const panel = getEl(`${WIDGET_ID}-panel`);
        if (panel && panel.classList.contains('active')) return;

        // Don't trigger when typing in input fields (including inside Shadow DOM)
        const active = document.activeElement;
        const deepActive = active?.shadowRoot?.activeElement || active;
        const isInputFocused = ['INPUT', 'TEXTAREA'].includes(deepActive.tagName)
          || deepActive.isContentEditable;

        if (!isInputFocused && !isAnnotationMode) {
          e.preventDefault();
          startAnnotationMode();
        }
      }
    }
    _listeners.onDocumentKeydown = onDocumentKeydown;
    document.addEventListener('keydown', onDocumentKeydown);

    // Prevent keyboard events from leaking to host page when widget is active
    function onShadowRootKeydown(e) {
      const panel = getEl(`${WIDGET_ID}-panel`);
      const panelIsOpen = panel && panel.classList.contains('active');
      if (panelIsOpen || isAnnotationMode || isPendingQueueOpen) {
        e.stopPropagation();
      }
    }
    _listeners.onShadowRootKeydown = onShadowRootKeydown;
    shadowRoot.addEventListener('keydown', onShadowRootKeydown);

    // Cmd/Ctrl+Enter to send feedback from description textarea
    const descriptionTextarea = getEl(`${WIDGET_ID}-description`);
    descriptionTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e[modifierKey]) {
        e.preventDefault();
        e.stopPropagation();
        addItem();
      }
    });

    // Panel buttons
    closeBtn.addEventListener('click', hidePanel);
    cancelBtn.addEventListener('click', hidePanel);
    sendBtn.addEventListener('click', addItem);
  }

  function startAnnotationMode() {
    isAnnotationMode = true;
    getEl(`${WIDGET_ID}-overlay`).classList.add('active');
    getEl(`${WIDGET_ID}-instructions`).classList.add('active');
  }

  function stopAnnotationMode() {
    isAnnotationMode = false;
    hoveredElement = null;
    getEl(`${WIDGET_ID}-overlay`).classList.remove('active');
    getEl(`${WIDGET_ID}-instructions`).classList.remove('active');
    getEl(`${WIDGET_ID}-highlight`).style.display = 'none';
    getEl(`${WIDGET_ID}-tooltip`).style.display = 'none';
  }

  async function showPanel() {
    const panel = getEl(`${WIDGET_ID}-panel`);
    const screenshotEl = getEl(`${WIDGET_ID}-screenshot-preview`);
    const elementInfoEl = getEl(`${WIDGET_ID}-element-info`);
    const elementInfoWrapper = getEl(`${WIDGET_ID}-element-info-wrapper`);
    const minimizeBtn = getEl(`${WIDGET_ID}-panel-minimize`);

    // Defensive check - ensure panel exists
    if (!panel) {
      console.error('[Claude Feedback] Panel element not found');
      return;
    }

    // Reset panel position and state
    panel.style.top = '20px';
    panel.style.right = '20px';
    panel.style.left = 'auto';
    panel.classList.remove('minimized');
    if (minimizeBtn) minimizeBtn.textContent = '−';

    // Reset element info to collapsed
    if (elementInfoWrapper) elementInfoWrapper.classList.remove('expanded');

    // Update logs count text (preserve checkbox state)
    const logsText = getEl(`${WIDGET_ID}-include-logs-text`);
    if (logsText) {
      logsText.textContent = `Include console logs (${consoleLogs.length} captured)`;
    }

    // Show element info
    if (selectedElement) {
      const info = getElementInfo(selectedElement);
      elementInfoEl.innerHTML = `
        <strong>Selected:</strong> &lt;${info.tagName}${info.id ? ` id="${info.id}"` : ''}${info.className ? ` class="${info.className}"` : ''}&gt;<br>
        <strong>Selector:</strong> ${info.selector}
      `;
    }

    // Show screenshot status instead of preview (screenshot is captured on submit)
    const includeScreenshotCheckbox = getEl(`${WIDGET_ID}-include-screenshot`);
    if (includeScreenshotCheckbox && includeScreenshotCheckbox.checked) {
      screenshotEl.alt = 'Screenshot will be captured when submitted';
      screenshotEl.removeAttribute('src');
      screenshotEl.style.display = 'none';
    } else {
      screenshotEl.style.display = 'none';
    }

    // Show confirmed-selection highlight on the selected element
    if (selectedElement) {
      const highlight = getEl(`${WIDGET_ID}-highlight`);
      const rect = selectedElement.getBoundingClientRect();
      highlight.style.top = `${rect.top}px`;
      highlight.style.left = `${rect.left}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      highlight.classList.add('selected');
      highlight.style.display = 'block';
    }

    panel.classList.add('active');
    getEl(`${WIDGET_ID}-description`).focus();
  }

  function hidePanel() {
    getEl(`${WIDGET_ID}-panel`).classList.remove('active');
    getEl(`${WIDGET_ID}-description`).value = '';
    selectedElement = null;
    const highlight = getEl(`${WIDGET_ID}-highlight`);
    highlight.style.display = 'none';
    highlight.classList.remove('selected');
  }

  async function addItem() {
    // Validate we have an element selected
    if (!selectedElement) {
      console.warn('[Claude Feedback] No element selected');
      return;
    }

    const description = getEl(`${WIDGET_ID}-description`)?.value || '';
    const includeLogs = getEl(`${WIDGET_ID}-include-logs`)?.checked ?? true;
    const includeStyles = getEl(`${WIDGET_ID}-include-styles`)?.checked ?? true;
    const includeScreenshot = getEl(`${WIDGET_ID}-include-screenshot`)?.checked ?? true;

    const elementInfo = getElementInfo(selectedElement);
    if (!includeStyles) {
      delete elementInfo.computedStyles;
    }

    const screenshot = includeScreenshot ? await captureScreenshot(selectedElement) : null;

    const feedback = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      timestamp: new Date().toISOString(),
      url: window.location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      userAgent: navigator.userAgent,
      element: elementInfo,
      description: description,
      screenshot: screenshot,
      consoleLogs: includeLogs ? consoleLogs.slice(-20) : [],
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      // Online: send via WebSocket
      try {
        ws.send(JSON.stringify({
          type: 'feedback',
          payload: feedback,
        }));
        hidePanel();
      } catch (err) {
        console.error('[Claude Feedback] Failed to add item:', err);
        showError('Failed to send. Saved locally.');
        localPendingItems.push(feedback);
        updatePendingUI();
        hidePanel();
      }
    } else {
      // Offline: store locally
      localPendingItems.push(feedback);
      updatePendingUI();
      hidePanel();
      showSuccess('Item saved locally (offline)');
    }
  }

  // ============================================
  // Export Helpers
  // ============================================

  function generateMarkdown(items) {
    const now = new Date().toISOString();
    const url = items[0]?.url || window.location.href;
    let md = `# Browser Feedback Report\n\n`;
    md += `- **URL:** ${url}\n`;
    md += `- **Date:** ${now}\n`;
    md += `- **User Agent:** ${navigator.userAgent}\n`;
    md += `- **Items:** ${items.length}\n\n`;
    md += `---\n\n`;

    items.forEach((item, i) => {
      md += `## Item ${i + 1}\n\n`;

      const selector = item.selector || item.element?.selector || 'Unknown';
      const fullSelector = item.element?.fullSelector || selector;
      md += `**Element:** \`${selector}\`\n\n`;
      md += `**Full path:** \`${fullSelector}\`\n\n`;

      if (item.description) {
        md += `**Description:** ${item.description}\n\n`;
      }

      if (item.element?.outerHTML) {
        md += `**HTML:**\n\`\`\`html\n${item.element.outerHTML}\n\`\`\`\n\n`;
      }

      if (item.element?.computedStyles) {
        const styles = item.element.computedStyles;
        const styleLines = Object.entries(styles)
          .filter(([, v]) => v)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        if (styleLines) {
          md += `**Computed Styles:**\n\`\`\`\n${styleLines}\n\`\`\`\n\n`;
        }
      }

      if (item.consoleLogs && item.consoleLogs.length > 0) {
        md += `**Console Logs (${item.consoleLogs.length}):**\n\`\`\`\n`;
        item.consoleLogs.forEach(log => {
          md += `[${log.type}] ${log.message}\n`;
        });
        md += `\`\`\`\n\n`;
      }

      if (item.screenshot) {
        md += `**Screenshot:** Captured (${Math.round(item.screenshot.length / 1024)}KB base64)\n\n`;
      }

      md += `---\n\n`;
    });

    return md;
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Append to document.body (not shadow root) for download to work
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function showSuccess(message) {
    const el = getEl(`${WIDGET_ID}-success`);
    if (el) {
      el.textContent = message;
      el.style.display = 'block';
      setTimeout(() => {
        el.style.display = 'none';
      }, 3000);
    }
  }

  function showItemAdded() {
    showSuccess('Item added');
  }

  function showBatchSuccess(count) {
    showSuccess(`${count} item${count !== 1 ? 's' : ''} sent to Claude!`);
  }

  function showError(message) {
    const el = getEl(`${WIDGET_ID}-error`);
    if (el) {
      el.textContent = '✗ ' + message;
      el.style.display = 'block';
      setTimeout(() => {
        el.style.display = 'none';
      }, 4000);
    } else {
      // Fallback to console if element doesn't exist
      console.error('[Claude Feedback]', message);
    }
  }

  function showNotification(message) {
    console.log('[Claude Feedback]', message);
    showSuccess(message);
  }

  // ============================================
  // Self-Healing: detect DOM removal and re-inject
  // ============================================

  function ensureWidgetInDOM() {
    if (!document.getElementById(WIDGET_ID)) {
      console.log('[Claude Feedback] Widget DOM removed, re-injecting');
      createWidget();
      updateButtonState();
      updatePendingUI();
    }
  }

  function startSelfHealing() {
    // MutationObserver: detect when widget container is removed from body
    _selfHealObserver = new MutationObserver((mutations) => {
      // Quick check: is the widget still in the DOM?
      if (document.getElementById(WIDGET_ID)) return;

      // Widget is gone — schedule re-injection on next microtask
      // (allows the framework to finish its DOM update)
      Promise.resolve().then(ensureWidgetInDOM);
    });

    _selfHealObserver.observe(document.body, { childList: true, subtree: true });

    // Fallback interval: handles edge cases the observer misses,
    // e.g. full document.body replacement where the observer itself is lost
    _selfHealInterval = setInterval(() => {
      ensureWidgetInDOM();
    }, 2000);
  }

  // ============================================
  // Destroy - clean teardown for extension toggle
  // ============================================

  function destroy() {
    // 1. Stop self-healing so it doesn't re-inject the widget
    if (_selfHealObserver) {
      _selfHealObserver.disconnect();
      _selfHealObserver = null;
    }
    if (_selfHealInterval) {
      clearInterval(_selfHealInterval);
      _selfHealInterval = null;
    }

    // 2. Close WebSocket (prevent reconnect by nulling onclose first)
    if (_wsReconnectTimeout) {
      clearTimeout(_wsReconnectTimeout);
      _wsReconnectTimeout = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      ws = null;
    }
    isConnected = false;

    // 3. Remove document/window event listeners
    if (_listeners.onDocumentMousemove) {
      document.removeEventListener('mousemove', _listeners.onDocumentMousemove);
    }
    if (_listeners.onDocumentMouseup) {
      document.removeEventListener('mouseup', _listeners.onDocumentMouseup);
    }
    if (_listeners.onDocumentKeydown) {
      document.removeEventListener('keydown', _listeners.onDocumentKeydown);
    }
    if (_listeners.onShadowRootKeydown && shadowRoot) {
      shadowRoot.removeEventListener('keydown', _listeners.onShadowRootKeydown);
    }
    if (_listeners.onWindowResize) {
      window.removeEventListener('resize', _listeners.onWindowResize);
    }
    window.removeEventListener('error', onWindowError);
    _listeners = {};

    // 4. Remove widget host element (removes shadow root and all contents)
    const host = document.getElementById(WIDGET_ID);
    if (host) host.remove();
    shadowRoot = null;

    // 5. Restore console methods
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;

    // 6. Reset state
    window.__CLAUDE_FEEDBACK_WIDGET__ = false;
    delete window.__claudeFeedbackDestroy;

    consoleLogs = [];
    networkErrors = [];
    pendingItems = [];
    localPendingItems = [];
    selectedElement = null;
    isAnnotationMode = false;
    isPendingQueueOpen = false;

    originalConsole.log('[Claude Feedback] Widget destroyed');
  }

  // Expose destroy for external callers (e.g., browser extension)
  window.__claudeFeedbackDestroy = destroy;

  // ============================================
  // Initialize
  // ============================================

  function init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }

    captureConsoleLogs();
    createWidget();
    connectWebSocket();
    startSelfHealing();

    console.log(`[Claude Feedback] Widget v${WIDGET_VERSION} initialized`);
  }

  init();
})();
