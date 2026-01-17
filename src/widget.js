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

  // Prevent double initialization
  if (window.__CLAUDE_FEEDBACK_WIDGET__) {
    console.log('[Claude Feedback] Widget already initialized');
    return;
  }
  window.__CLAUDE_FEEDBACK_WIDGET__ = true;

  // Configuration
  const WS_URL = '__WEBSOCKET_URL__'; // Injected by server
  const WIDGET_ID = 'claude-feedback-widget';
  
  // State
  let ws = null;
  let isConnected = false;
  let isAnnotationMode = false;
  let isMultiFeedbackMode = false;
  let multiFeedbackCount = 0;
  let selectedElement = null;
  let consoleLogs = [];
  let networkErrors = [];

  // Platform detection for keyboard shortcuts
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modifierKey = isMac ? 'metaKey' : 'ctrlKey';
  const modifierSymbol = isMac ? '⌘' : 'Ctrl+';

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
  window.addEventListener('error', (event) => {
    consoleLogs.push({
      type: 'error',
      timestamp: new Date().toISOString(),
      message: `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
      stack: event.error?.stack,
    });
  });

  // ============================================
  // Styles
  // ============================================

  const styles = `
    #${WIDGET_ID} * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    #${WIDGET_ID}-button {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
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
      word-break: break-all;
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

    #${WIDGET_ID}-multi-bar {
      position: fixed;
      bottom: 80px;
      right: 20px;
      z-index: 2147483647;
      background: #1f2937;
      color: white;
      padding: 12px 16px;
      border-radius: 12px;
      display: none;
      align-items: center;
      gap: 12px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    #${WIDGET_ID}-multi-bar.active {
      display: flex;
    }

    #${WIDGET_ID}-multi-bar .count {
      background: #da7756;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }

    #${WIDGET_ID}-multi-bar .message {
      font-size: 13px;
      max-width: 200px;
    }

    #${WIDGET_ID}-done-btn {
      background: #22c55e;
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    #${WIDGET_ID}-done-btn:hover {
      background: #16a34a;
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
  `;

  // ============================================
  // HTML Structure
  // ============================================

  function createWidget() {
    // Inject styles
    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);

    // Create container
    const container = document.createElement('div');
    container.id = WIDGET_ID;
    container.innerHTML = `
      <button id="${WIDGET_ID}-button" class="disconnected">
        <svg class="claude-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H4.104v-.08l2.878-1.17-.107-.312h-.063L3.87 12.802v-.064l6.048-3.318V9.3L4.14 6.622l.064-.064 4.848 1.336.063-.063-.08-.392L4.66 3.893 8.34 5.58l.312-.072V5.34L6.35 2.766l2.374 1.68.08-.064-.032-.44L6.83.782 9.3 3.67l.12-.048.064-3.59h.064l.663 3.222.168.056L12.12.614v.064l-.92 3.406.072.128h.08L14.12.766v.08l-1.92 3.83.064.104 3.63-2.63-.064.08-2.35 3.734.04.12.128.024 3.934-1.4-.08.08-3.07 2.63v.08l.112.063 3.83-.92-.064.08-3.35 1.6v.04l.12.128 3.566.128-.08.064-3.606.695-.064.136.032.048 3.83 1.4-.08.048-3.83-.015-.128.104-.008.072 3.35 2.446-.08.032-3.59-1.344-.12.064-.04.104 2.342 3.35-.08.016-2.998-2.566-.088.056-.128.168.87 3.95h-.08l-1.664-3.35-.112-.04-.08.04-.6 4.12h-.064l.12-3.862-.12-.136-.088.008-1.92 3.398-.048-.064.84-3.83-.072-.12-.136-.024-2.566 2.998-.032-.08 1.824-3.59-.056-.128-.104-.024-3.19 1.824.048-.08 2.566-2.87-.048-.127-.12-.016-3.67.463z"/>
        </svg>
        <span>Add annotation</span>
        <span class="shortcut-hint" id="${WIDGET_ID}-button-shortcut" style="display: none;">Shift+C</span>
      </button>
      
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
              <input type="checkbox" id="${WIDGET_ID}-include-logs" checked />
              Include console logs (${consoleLogs.length} captured)
            </label>
            <label>
              <input type="checkbox" id="${WIDGET_ID}-include-styles" checked />
              Include computed styles
            </label>
          </div>
          <div id="${WIDGET_ID}-actions">
            <button id="${WIDGET_ID}-cancel-btn">Cancel</button>
            <button id="${WIDGET_ID}-send-btn">Send to Claude<span class="shortcut-hint">${modifierSymbol}↵</span></button>
          </div>
        </div>
      </div>
      
      <div id="${WIDGET_ID}-success">✓ Feedback sent to Claude!</div>

      <div id="${WIDGET_ID}-multi-bar">
        <span class="count" id="${WIDGET_ID}-multi-count">0</span>
        <span class="message" id="${WIDGET_ID}-multi-message">Submit feedback items</span>
        <button id="${WIDGET_ID}-done-btn">Done</button>
      </div>
    `;

    document.body.appendChild(container);
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

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const styles = window.getComputedStyle(el);
    
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: el.className || null,
      selector: getElementSelector(el),
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

  async function captureScreenshot() {
    // Use html2canvas if available, otherwise use a simple approach
    if (typeof html2canvas !== 'undefined') {
      try {
        const canvas = await html2canvas(document.body, {
          logging: false,
          useCORS: true,
          scale: 0.5, // Reduce size
        });
        return canvas.toDataURL('image/jpeg', 0.7);
      } catch (err) {
        console.warn('[Claude Feedback] html2canvas failed:', err);
      }
    }
    
    // Fallback: capture viewport dimensions and state
    return null;
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
        setTimeout(connectWebSocket, 3000);
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
      setTimeout(connectWebSocket, 3000);
    }
  }

  function handleServerMessage(message) {
    if (message.type === 'request_annotation') {
      // Claude is asking for annotation
      showNotification(message.message || 'Claude is requesting your feedback');
      startAnnotationMode();
    } else if (message.type === 'request_multiple_annotations') {
      // Claude wants multiple annotations
      startMultiFeedbackMode(message.message);
    } else if (message.type === 'feedback_received') {
      showSuccess();
      if (isMultiFeedbackMode) {
        multiFeedbackCount++;
        updateMultiBar();
      }
    }
  }

  function updateButtonState() {
    const button = document.getElementById(`${WIDGET_ID}-button`);
    const shortcutHint = document.getElementById(`${WIDGET_ID}-button-shortcut`);
    if (button) {
      button.classList.toggle('disconnected', !isConnected);
    }
    if (shortcutHint) {
      shortcutHint.style.display = isConnected ? 'inline' : 'none';
    }
  }

  // ============================================
  // Event Handlers
  // ============================================

  let hoveredElement = null;

  function bindEvents() {
    const button = document.getElementById(`${WIDGET_ID}-button`);
    const overlay = document.getElementById(`${WIDGET_ID}-overlay`);
    const highlight = document.getElementById(`${WIDGET_ID}-highlight`);
    const tooltip = document.getElementById(`${WIDGET_ID}-tooltip`);
    const panel = document.getElementById(`${WIDGET_ID}-panel`);
    const panelHeader = document.getElementById(`${WIDGET_ID}-panel-header`);
    const minimizeBtn = document.getElementById(`${WIDGET_ID}-panel-minimize`);
    const closeBtn = document.getElementById(`${WIDGET_ID}-panel-close`);
    const cancelBtn = document.getElementById(`${WIDGET_ID}-cancel-btn`);
    const sendBtn = document.getElementById(`${WIDGET_ID}-send-btn`);
    const doneBtn = document.getElementById(`${WIDGET_ID}-done-btn`);
    const elementInfoToggle = document.getElementById(`${WIDGET_ID}-element-info-toggle`);
    const elementInfoWrapper = document.getElementById(`${WIDGET_ID}-element-info-wrapper`);

    // Element info toggle
    elementInfoToggle.addEventListener('click', () => {
      elementInfoWrapper.classList.toggle('expanded');
    });

    // Main button click
    button.addEventListener('click', () => {
      if (!isConnected) {
        alert('Not connected to Claude Code feedback server. Make sure the MCP server is running.');
        return;
      }
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

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - panel.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - panel.offsetHeight));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      panel.style.transition = '';
    });

    // Keep panel in viewport on resize
    window.addEventListener('resize', () => {
      if (!panel.classList.contains('active')) return;
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        panel.style.left = Math.max(0, window.innerWidth - panel.offsetWidth) + 'px';
        panel.style.right = 'auto';
      }
      if (rect.bottom > window.innerHeight) {
        panel.style.top = Math.max(0, window.innerHeight - panel.offsetHeight) + 'px';
      }
    });

    // Overlay mouse events
    overlay.addEventListener('mousemove', (e) => {
      if (!isAnnotationMode) return;
      
      // Get element under cursor (temporarily hide overlay)
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'auto';
      
      if (el && el.id !== WIDGET_ID && !el.closest(`#${WIDGET_ID}`)) {
        hoveredElement = el;
        const rect = el.getBoundingClientRect();
        
        highlight.style.display = 'block';
        highlight.style.top = rect.top + 'px';
        highlight.style.left = rect.left + 'px';
        highlight.style.width = rect.width + 'px';
        highlight.style.height = rect.height + 'px';
        
        tooltip.style.display = 'block';
        tooltip.style.top = (rect.top - 40) + 'px';
        tooltip.style.left = rect.left + 'px';
        tooltip.textContent = getElementSelector(el);
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
    document.addEventListener('keydown', (e) => {
      // Escape to cancel annotation mode or close panel
      if (e.key === 'Escape') {
        const panel = document.getElementById(`${WIDGET_ID}-panel`);
        if (panel && panel.classList.contains('active')) {
          hidePanel();
          return;
        }
        if (isAnnotationMode) {
          stopAnnotationMode();
          return;
        }
      }

      // Shift+C to start annotation mode
      if (e.key === 'C' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Don't trigger when typing in input fields
        const isInputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
          || document.activeElement.isContentEditable;

        if (!isInputFocused && isConnected && !isAnnotationMode) {
          e.preventDefault();
          startAnnotationMode();
        }
      }
    });

    // Cmd/Ctrl+Enter to send feedback from description textarea
    const descriptionTextarea = document.getElementById(`${WIDGET_ID}-description`);
    descriptionTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e[modifierKey]) {
        e.preventDefault();
        sendFeedback();
      }
    });

    // Panel buttons
    closeBtn.addEventListener('click', hidePanel);
    cancelBtn.addEventListener('click', hidePanel);
    sendBtn.addEventListener('click', sendFeedback);

    // Done button for multi-feedback mode
    doneBtn.addEventListener('click', finishMultiFeedback);
  }

  function startAnnotationMode() {
    isAnnotationMode = true;
    document.getElementById(`${WIDGET_ID}-overlay`).classList.add('active');
    document.getElementById(`${WIDGET_ID}-instructions`).classList.add('active');
  }

  function stopAnnotationMode() {
    isAnnotationMode = false;
    hoveredElement = null;
    document.getElementById(`${WIDGET_ID}-overlay`).classList.remove('active');
    document.getElementById(`${WIDGET_ID}-instructions`).classList.remove('active');
    document.getElementById(`${WIDGET_ID}-highlight`).style.display = 'none';
    document.getElementById(`${WIDGET_ID}-tooltip`).style.display = 'none';
  }

  function startMultiFeedbackMode(message) {
    isMultiFeedbackMode = true;
    multiFeedbackCount = 0;
    document.getElementById(`${WIDGET_ID}-multi-message`).textContent = message || 'Submit all feedback, then click Done';
    updateMultiBar();
    document.getElementById(`${WIDGET_ID}-multi-bar`).classList.add('active');
    // Start annotation mode to begin selecting elements
    startAnnotationMode();
  }

  function updateMultiBar() {
    document.getElementById(`${WIDGET_ID}-multi-count`).textContent = multiFeedbackCount;
  }

  function finishMultiFeedback() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Send done signal to server
    ws.send(JSON.stringify({
      type: 'feedback_batch_complete',
      count: multiFeedbackCount,
    }));

    // Reset state
    isMultiFeedbackMode = false;
    multiFeedbackCount = 0;
    document.getElementById(`${WIDGET_ID}-multi-bar`).classList.remove('active');
    stopAnnotationMode();
  }

  async function showPanel() {
    const panel = document.getElementById(`${WIDGET_ID}-panel`);
    const screenshotEl = document.getElementById(`${WIDGET_ID}-screenshot-preview`);
    const elementInfoEl = document.getElementById(`${WIDGET_ID}-element-info`);
    const elementInfoWrapper = document.getElementById(`${WIDGET_ID}-element-info-wrapper`);
    const logsCheckbox = document.getElementById(`${WIDGET_ID}-include-logs`);
    const minimizeBtn = document.getElementById(`${WIDGET_ID}-panel-minimize`);

    // Reset panel position and state
    panel.style.top = '20px';
    panel.style.right = '20px';
    panel.style.left = 'auto';
    panel.classList.remove('minimized');
    minimizeBtn.textContent = '−';

    // Reset element info to collapsed
    elementInfoWrapper.classList.remove('expanded');

    // Update logs count
    logsCheckbox.parentElement.innerHTML = `
      <input type="checkbox" id="${WIDGET_ID}-include-logs" checked />
      Include console logs (${consoleLogs.length} captured)
    `;

    // Show element info
    if (selectedElement) {
      const info = getElementInfo(selectedElement);
      elementInfoEl.innerHTML = `
        <strong>Selected:</strong> &lt;${info.tagName}${info.id ? ` id="${info.id}"` : ''}${info.className ? ` class="${info.className}"` : ''}&gt;<br>
        <strong>Selector:</strong> ${info.selector}
      `;
    }
    
    // Capture screenshot
    const screenshot = await captureScreenshot();
    if (screenshot) {
      screenshotEl.src = screenshot;
      screenshotEl.style.display = 'block';
    } else {
      screenshotEl.style.display = 'none';
    }
    
    panel.classList.add('active');
    document.getElementById(`${WIDGET_ID}-description`).focus();
  }

  function hidePanel() {
    document.getElementById(`${WIDGET_ID}-panel`).classList.remove('active');
    document.getElementById(`${WIDGET_ID}-description`).value = '';
    selectedElement = null;
  }

  async function sendFeedback() {
    if (!selectedElement || !ws || ws.readyState !== WebSocket.OPEN) return;
    
    const description = document.getElementById(`${WIDGET_ID}-description`).value;
    const includeLogs = document.getElementById(`${WIDGET_ID}-include-logs`).checked;
    const includeStyles = document.getElementById(`${WIDGET_ID}-include-styles`).checked;
    
    const elementInfo = getElementInfo(selectedElement);
    if (!includeStyles) {
      delete elementInfo.computedStyles;
    }
    
    const screenshot = await captureScreenshot();
    
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
    
    ws.send(JSON.stringify({
      type: 'feedback',
      payload: feedback,
    }));

    hidePanel();

    // In multi-feedback mode, restart annotation mode for next item
    if (isMultiFeedbackMode) {
      setTimeout(() => startAnnotationMode(), 300);
    }
  }

  function showSuccess() {
    const el = document.getElementById(`${WIDGET_ID}-success`);
    el.style.display = 'block';
    setTimeout(() => {
      el.style.display = 'none';
    }, 3000);
  }

  function showNotification(message) {
    // Could enhance this with a toast notification
    console.log('[Claude Feedback]', message);
  }

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
    
    console.log('[Claude Feedback] Widget initialized');
  }

  init();
})();
