#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.FEEDBACK_PORT || "9877");
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

// Session identity for this MCP server process
const SESSION_ID = crypto.randomUUID();
const PROJECT_DIR = process.cwd();

// Session registry (owner server only): sessionId -> metadata
const sessionRegistry = new Map();

// Session-partitioned feedback storage
const pendingFeedbackBySession = new Map();   // sessionId -> feedback[]
const readyFeedbackBySession = new Map();     // sessionId -> feedback[]
const feedbackResolversBySession = new Map(); // sessionId -> resolver[]
const connectedClientsBySession = new Map();  // sessionId -> Set<WebSocket>
let connectedClients = new Set();             // All clients (for total count in /status)
let isHttpServerOwner = false; // Track if this instance owns the HTTP server

// Session-partitioned data accessors
function getSessionPending(sid) {
  if (!pendingFeedbackBySession.has(sid)) pendingFeedbackBySession.set(sid, []);
  return pendingFeedbackBySession.get(sid);
}
function setSessionPending(sid, arr) {
  pendingFeedbackBySession.set(sid, arr);
}
function getSessionReady(sid) {
  if (!readyFeedbackBySession.has(sid)) readyFeedbackBySession.set(sid, []);
  return readyFeedbackBySession.get(sid);
}
function setSessionReady(sid, arr) {
  readyFeedbackBySession.set(sid, arr);
}
function getSessionResolvers(sid) {
  if (!feedbackResolversBySession.has(sid)) feedbackResolversBySession.set(sid, []);
  return feedbackResolversBySession.get(sid);
}
function getSessionClients(sid) {
  if (!connectedClientsBySession.has(sid)) connectedClientsBySession.set(sid, new Set());
  return connectedClientsBySession.get(sid);
}

// UUID format validation for session IDs
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidSessionId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

// Helper to parse JSON body from an HTTP request
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (err) { reject(err); }
    });
  });
}

// Helper to generate pending feedback summary (without full payloads)
function getPendingSummary(sessionId) {
  const pending = sessionId ? getSessionPending(sessionId) : [];
  return {
    count: pending.length,
    items: pending.map(f => ({
      id: f.id,
      timestamp: f.timestamp || f.receivedAt,
      description: f.description ? f.description.slice(0, 100) : '',
      selector: f.element?.selector || '',
    })),
  };
}

// Broadcast pending status to session-specific connected clients
function broadcastPendingStatus(sessionId) {
  const status = getPendingSummary(sessionId);
  const message = JSON.stringify({ type: 'pending_status', ...status });
  for (const client of getSessionClients(sessionId)) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Helper to fetch status from the running HTTP server
async function fetchServerStatus(sessionId) {
  try {
    const url = sessionId
      ? `http://localhost:${PORT}/status?session=${sessionId}`
      : `http://localhost:${PORT}/status`;
    const response = await fetch(url);
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    // Server not running or not reachable
  }
  return null;
}

// Helper to fetch ready feedback from the running HTTP server
async function fetchReadyFeedback(clear = true) {
  try {
    const response = await fetch(`http://localhost:${PORT}/feedback?clear=${clear}&session=${SESSION_ID}`);
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    // Server not running or not reachable
  }
  return null;
}

// Helper to poll for feedback from the running HTTP server
async function pollForFeedback(timeoutSeconds) {
  const pollInterval = 500; // ms
  const maxAttempts = (timeoutSeconds * 1000) / pollInterval;

  for (let i = 0; i < maxAttempts; i++) {
    const result = await fetchReadyFeedback(true);
    if (result && result.feedback && result.feedback.length > 0) {
      if (result.feedback.length === 1) return result.feedback[0];
      return result.feedback;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  throw new Error("Timeout waiting for browser feedback");
}

// Helper to broadcast message via the running HTTP server
async function broadcastViaHttp(message) {
  try {
    const response = await fetch(`http://localhost:${PORT}/broadcast?session=${SESSION_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    // Server not running or not reachable
  }
  return null;
}

// Helper to fetch pending summary from the running HTTP server
async function fetchPendingSummary() {
  try {
    const response = await fetch(`http://localhost:${PORT}/pending-summary?session=${SESSION_ID}`);
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    // Server not running or not reachable
  }
  return null;
}

// Helper to delete feedback via the running HTTP server
async function deleteFeedbackViaHttp(id) {
  try {
    const response = await fetch(`http://localhost:${PORT}/feedback/${id}?session=${SESSION_ID}`, {
      method: 'DELETE',
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    // Server not running or not reachable
  }
  return null;
}

// Helper to register this session with the owner server
async function registerSessionViaHttp() {
  const detected = detectProjectUrl(PROJECT_DIR);
  try {
    await fetch(`http://localhost:${PORT}/register-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        projectDir: PROJECT_DIR,
        projectUrl: detected.url,
        detectedFrom: detected.detectedFrom,
      }),
    });
  } catch (err) {
    // Server not reachable, session won't appear in registry
  }
}

// Helper to unregister this session from the owner server
async function unregisterSessionViaHttp() {
  try {
    await fetch(`http://localhost:${PORT}/unregister-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
  } catch (err) {
    // Ignore errors during shutdown
  }
}

// Helper to detect project URL from configuration files
function detectProjectUrl(projectDir) {
  // Detection strategies in order of priority
  const detectionStrategies = [
    // .env file patterns
    {
      file: '.env',
      patterns: [
        /^(?:APP_URL|BASE_URL|SITE_URL|PROJECT_URL|HOSTNAME)=["']?([^"'\s]+)["']?/m,
        /^(?:VIRTUAL_HOST|COMPOSE_DOMAIN)=["']?([^"'\s]+)["']?/m,
      ],
      transform: (match) => {
        const value = match[1];
        // Add protocol if missing
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    // .env.local file patterns
    {
      file: '.env.local',
      patterns: [
        /^(?:APP_URL|BASE_URL|SITE_URL|PROJECT_URL|HOSTNAME)=["']?([^"'\s]+)["']?/m,
        /^(?:VIRTUAL_HOST|COMPOSE_DOMAIN)=["']?([^"'\s]+)["']?/m,
      ],
      transform: (match) => {
        const value = match[1];
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    // docker-compose.yml patterns
    {
      file: 'docker-compose.yml',
      patterns: [
        /VIRTUAL_HOST[=:]\s*["']?([^"'\s]+)["']?/,
        /traefik\.http\.routers\.[^.]+\.rule[=:]\s*["']?Host\(`([^`]+)`\)["']?/,
      ],
      transform: (match) => {
        const value = match[1];
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    // docker-compose.override.yml patterns
    {
      file: 'docker-compose.override.yml',
      patterns: [
        /VIRTUAL_HOST[=:]\s*["']?([^"'\s]+)["']?/,
        /traefik\.http\.routers\.[^.]+\.rule[=:]\s*["']?Host\(`([^`]+)`\)["']?/,
      ],
      transform: (match) => {
        const value = match[1];
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    // package.json homepage or proxy
    {
      file: 'package.json',
      patterns: [
        /"homepage"\s*:\s*"([^"]+)"/,
        /"proxy"\s*:\s*"([^"]+)"/,
      ],
      transform: (match) => match[1],
    },
  ];

  for (const strategy of detectionStrategies) {
    const filePath = path.join(projectDir, strategy.file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const pattern of strategy.patterns) {
          const match = content.match(pattern);
          if (match) {
            return {
              url: strategy.transform(match),
              detectedFrom: strategy.file,
            };
          }
        }
      } catch (err) {
        // Continue to next strategy
      }
    }
  }

  return { url: null, detectedFrom: null };
}

// Helper to format feedback items as MCP content blocks with ImageContent for screenshots
function formatFeedbackAsContent(items) {
  if (!Array.isArray(items)) items = [items];

  const content = [];
  for (const item of items) {
    // Separate screenshot from the rest of the data
    const { screenshot, ...rest } = item;

    content.push({
      type: "text",
      text: JSON.stringify(rest, null, 2),
    });

    if (screenshot && typeof screenshot === 'string') {
      // Parse data URL: "data:image/jpeg;base64,..."
      const match = screenshot.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        content.push({
          type: "image",
          data: match[2],
          mimeType: match[1],
        });
      }
    }
  }

  if (items.length > 1) {
    content.unshift({
      type: "text",
      text: `Received ${items.length} feedback item(s):`,
    });
  }

  return content;
}

// ============================================
// HTTP Server - serves widget.js
// ============================================

const httpServer = http.createServer((req, res) => {
  // CORS headers for cross-origin requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Parse URL for query parameters
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  if (urlObj.pathname === "/widget.js") {
    const widgetPath = path.join(__dirname, "widget.js");
    const sessionParam = urlObj.searchParams.get('session') || '';
    fs.readFile(widgetPath, "utf8", (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading widget");
        return;
      }
      // Inject runtime values into the widget (including session ID for isolation)
      const wsUrl = sessionParam
        ? `ws://localhost:${PORT}/ws?session=${sessionParam}`
        : `ws://localhost:${PORT}/ws`;
      const injectedContent = content
        .replace("__WEBSOCKET_URL__", wsUrl)
        .replace("__WIDGET_VERSION__", PKG_VERSION);
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(injectedContent);
    });
    return;
  }

  if (urlObj.pathname === "/html2canvas.min.js") {
    const html2canvasPath = path.join(__dirname, "..", "node_modules", "html2canvas", "dist", "html2canvas.min.js");
    fs.readFile(html2canvasPath, "utf8", (err, content) => {
      if (err) {
        res.writeHead(404);
        res.end("html2canvas not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(content);
    });
    return;
  }

  if (urlObj.pathname === "/demo/index.html" || urlObj.pathname === "/demo/") {
    const demoPath = path.join(__dirname, "..", "demo", "index.html");
    fs.readFile(demoPath, "utf8", (err, content) => {
      if (err) {
        res.writeHead(404);
        res.end("Demo page not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
    });
    return;
  }

  if (urlObj.pathname === "/status") {
    const sessionId = urlObj.searchParams.get('session');
    const response = {
      status: "running",
      port: PORT,
      connectedClients: sessionId ? getSessionClients(sessionId).size : connectedClients.size,
      pendingFeedback: sessionId ? getSessionPending(sessionId).length : 0,
      sessions: sessionRegistry.size,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // GET /feedback - retrieve ready feedback (used by secondary MCP instances)
  if (urlObj.pathname === "/feedback" && req.method === "GET") {
    const shouldClear = urlObj.searchParams.get("clear") !== "false";
    const sessionId = urlObj.searchParams.get("session") || "default";
    const sessionReady = getSessionReady(sessionId);
    const feedback = [...sessionReady];
    if (shouldClear) {
      setSessionReady(sessionId, []);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ feedback }));
    return;
  }

  // GET /pending-summary - get summary of pending feedback without full payloads
  if (urlObj.pathname === "/pending-summary" && req.method === "GET") {
    const sessionId = urlObj.searchParams.get("session") || "default";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getPendingSummary(sessionId)));
    return;
  }

  // DELETE /feedback/:id - remove a specific pending feedback item
  const deleteMatch = urlObj.pathname.match(/^\/feedback\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const idToDelete = deleteMatch[1];
    const sessionId = urlObj.searchParams.get("session") || "default";
    const pending = getSessionPending(sessionId);
    const initialLength = pending.length;
    setSessionPending(sessionId, pending.filter(f => f.id !== idToDelete));
    const deleted = getSessionPending(sessionId).length < initialLength;

    if (deleted) {
      broadcastPendingStatus(sessionId);
    }

    res.writeHead(deleted ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: deleted,
      message: deleted ? 'Feedback deleted' : 'Feedback not found'
    }));
    return;
  }

  // POST /broadcast - broadcast message to connected clients (used by secondary MCP instances)
  if (urlObj.pathname === "/broadcast" && req.method === "POST") {
    const sessionId = urlObj.searchParams.get("session") || "default";
    parseJsonBody(req).then((message) => {
      const data = JSON.stringify(message);
      let sentCount = 0;
      for (const client of getSessionClients(sessionId)) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
          sentCount++;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, clientCount: sentCount }));
    }).catch(() => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    });
    return;
  }

  // GET /sessions - list all registered sessions
  if (urlObj.pathname === "/sessions" && req.method === "GET") {
    const sessions = Array.from(sessionRegistry.values());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // POST /register-session - register a proxy session
  if (urlObj.pathname === "/register-session" && req.method === "POST") {
    parseJsonBody(req).then((data) => {
      if (!isValidSessionId(data.sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid session ID format" }));
        return;
      }
      sessionRegistry.set(data.sessionId, {
        sessionId: data.sessionId,
        projectDir: data.projectDir,
        projectUrl: data.projectUrl || null,
        detectedFrom: data.detectedFrom || null,
        registeredAt: new Date().toISOString(),
      });
      console.error(`[browser-feedback-mcp] Session registered: ${data.sessionId} (${data.projectDir})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    }).catch(() => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    });
    return;
  }

  // POST /unregister-session - unregister a session on shutdown
  if (urlObj.pathname === "/unregister-session" && req.method === "POST") {
    parseJsonBody(req).then((data) => {
      if (!isValidSessionId(data.sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid session ID format" }));
        return;
      }
      sessionRegistry.delete(data.sessionId);
      // Clean up session data
      pendingFeedbackBySession.delete(data.sessionId);
      readyFeedbackBySession.delete(data.sessionId);
      feedbackResolversBySession.delete(data.sessionId);
      connectedClientsBySession.delete(data.sessionId);
      console.error(`[browser-feedback-mcp] Session unregistered: ${data.sessionId}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    }).catch(() => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ============================================
// WebSocket Server - real-time communication
// ============================================

const wss = new WebSocketServer({ server: httpServer, path: "/ws", clientTracking: true });

// Handle WebSocket server errors
wss.on("error", (err) => {
  console.error("[browser-feedback-mcp] WebSocket server error:", err.message);
});

wss.on("connection", (ws, req) => {
  // Extract session ID from WebSocket URL query params
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const sessionId = reqUrl.searchParams.get('session') || 'default';
  ws._sessionId = sessionId;

  connectedClients.add(ws);
  getSessionClients(sessionId).add(ws);
  console.error(`[browser-feedback-mcp] Client connected (session: ${sessionId}). Total: ${connectedClients.size}`);

  // Send connection confirmation
  ws.send(JSON.stringify({ type: "connected", message: "Connected to Claude Code feedback server", sessionId }));

  // Send current pending status for this session to newly connected client
  const status = getPendingSummary(sessionId);
  ws.send(JSON.stringify({ type: 'pending_status', ...status }));

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      const sid = ws._sessionId;

      if (message.type === "feedback") {
        console.error(`[browser-feedback-mcp] Received feedback from browser (session: ${sid})`);

        const feedback = {
          ...message.payload,
          receivedAt: new Date().toISOString(),
        };

        getSessionPending(sid).push(feedback);

        // Acknowledge receipt
        ws.send(JSON.stringify({ type: "feedback_received", id: feedback.id }));

        // Broadcast updated pending status to this session's clients
        broadcastPendingStatus(sid);
      }

      if (message.type === "send_to_claude") {
        const pending = getSessionPending(sid);
        const ready = getSessionReady(sid);
        // Move all pending items to ready
        ready.push(...pending);
        setSessionPending(sid, []);
        broadcastPendingStatus(sid);

        const count = ready.length;

        // Resolve any waiting promises for this session with the batch
        const resolvers = getSessionResolvers(sid);
        if (resolvers.length > 0) {
          while (resolvers.length > 0) {
            const resolver = resolvers.shift();
            resolver([...ready]);
          }
          // Clear after resolvers consumed, so get_pending_feedback won't double-deliver
          setSessionReady(sid, []);
        }

        // Acknowledge to browser
        ws.send(JSON.stringify({
          type: "sent_to_claude",
          count: count,
        }));
      }

      if (message.type === "delete_feedback") {
        const idToDelete = message.id;
        const pending = getSessionPending(sid);
        const initialLength = pending.length;
        setSessionPending(sid, pending.filter(f => f.id !== idToDelete));
        const deleted = getSessionPending(sid).length < initialLength;

        if (deleted) {
          console.error(`[browser-feedback-mcp] Deleted feedback: ${idToDelete} (session: ${sid})`);
          // Broadcast updated pending status to this session's clients
          broadcastPendingStatus(sid);
        }

        ws.send(JSON.stringify({
          type: "feedback_deleted",
          id: idToDelete,
          success: deleted,
        }));
      }
    } catch (err) {
      console.error("[browser-feedback-mcp] Error parsing message:", err);
    }
  });

  ws.on("close", () => {
    connectedClients.delete(ws);
    getSessionClients(ws._sessionId).delete(ws);
    console.error(`[browser-feedback-mcp] Client disconnected (session: ${ws._sessionId}). Total: ${connectedClients.size}`);
  });
});

// Broadcast to session-specific connected clients
function broadcast(message, sessionId) {
  const data = JSON.stringify(message);
  const clients = sessionId ? getSessionClients(sessionId) : connectedClients;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ============================================
// MCP Server - interface for Claude Code
// ============================================

const mcpServer = new Server(
  {
    name: "browser-feedback-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "install_widget",
        description:
          "Automatically install the feedback widget into a web application by injecting the script tag into an HTML file. Supports auto-detection of common entry points (index.html, etc.) or a specific file path.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the HTML file to inject the widget into. If not provided, will attempt to auto-detect common entry points in the current directory.",
            },
            project_dir: {
              type: "string",
              description: "Project directory to search for HTML files. Defaults to current working directory.",
            },
            dev_only: {
              type: "boolean",
              description: "If true, wraps the script in a hostname check so it only loads in development. Defaults to true.",
              default: true,
            },
            allowed_hostnames: {
              type: "array",
              items: { type: "string" },
              description: "List of hostnames or patterns allowed when dev_only is true. Supports exact matches (e.g., 'localhost') and wildcard patterns where '*' matches any characters including dots (e.g., '*.local.itkdev.dk' matches 'app.local.itkdev.dk', '*.local.*' matches 'app.local.example.dk'). Defaults to common local dev patterns: localhost, 127.0.0.1, *.local, *.local.*, *.test, *.dev, *.ddev.site",
            },
          },
          required: [],
        },
      },
      {
        name: "uninstall_widget",
        description:
          "Remove the feedback widget from a web application by removing the injected script tag.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the HTML file to remove the widget from. If not provided, will search for files containing the widget script.",
            },
            project_dir: {
              type: "string",
              description: "Project directory to search. Defaults to current working directory.",
            },
          },
          required: [],
        },
      },
      {
        name: "get_widget_snippet",
        description:
          "Get the HTML snippet to add to a web app for browser feedback collection. Use install_widget instead for automatic installation.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "wait_for_browser_feedback",
        description:
          "Wait for feedback from the browser widget. Blocks until user submits feedback. Returns screenshot, element info, console logs, and description. IMPORTANT: After receiving feedback, DO NOT call this tool again. Instead, analyze the feedback and take action (fix bugs, make changes, etc.). Only call this tool again if the user explicitly asks for more feedback or you need to verify your fix worked.",
        inputSchema: {
          type: "object",
          properties: {
            timeout_seconds: {
              type: "number",
              description: "Maximum time to wait for feedback (default: 300 seconds / 5 minutes)",
              default: 300,
            },
          },
          required: [],
        },
      },
      {
        name: "get_pending_feedback",
        description:
          "Get all pending feedback that has been submitted. Use this to collect multiple annotations at once - user can submit several feedback items, then you call this to get them all. Returns an array of feedback items. After receiving, analyze ALL items and take action on each.",
        inputSchema: {
          type: "object",
          properties: {
            clear: {
              type: "boolean",
              description: "Whether to clear the pending feedback after retrieving (default: true)",
              default: true,
            },
          },
          required: [],
        },
      },
      {
        name: "preview_pending_feedback",
        description:
          "Preview all pending feedback without consuming it. Use this to see what feedback has been submitted without clearing the queue. Returns summaries of pending items (id, timestamp, description, selector). The browser widget also shows this information.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "delete_pending_feedback",
        description:
          "Delete a specific pending feedback item by ID. Use this when a user wants to remove feedback they submitted by mistake or that is no longer relevant.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The ID of the feedback item to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "wait_for_multiple_feedback",
        description:
          "Wait for the user to submit multiple feedback items. Shows a prompt in the browser telling user to submit all their annotations, then click 'Done'. Returns array of all feedback. Use this when user wants to report multiple issues at once.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to show user (default: 'Submit all your feedback, then click Done when finished')",
            },
            timeout_seconds: {
              type: "number",
              description: "Maximum time to wait (default: 300 seconds / 5 minutes)",
              default: 300,
            },
          },
          required: [],
        },
      },
      {
        name: "get_connection_status",
        description:
          "Check if any browser clients are connected to the feedback server.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "request_annotation",
        description:
          "Send a prompt to connected browsers asking user to annotate something specific. After calling this, use wait_for_browser_feedback ONCE to receive the response. Do not loop - act on the feedback received.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to show to the user explaining what to annotate",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "open_in_browser",
        description:
          "Open the project in the default browser. Automatically detects the project URL from common configuration files (.env, docker-compose.yml, etc.) or accepts an explicit URL. Can also just return the detected URL without opening.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Explicit URL to open. If not provided, will attempt to detect from project configuration.",
            },
            project_dir: {
              type: "string",
              description: "Project directory to search for configuration files. Defaults to current working directory.",
            },
            open: {
              type: "boolean",
              description: "If true, open the URL in the default browser. Defaults to false (just returns the URL).",
              default: false,
            },
          },
          required: [],
        },
      },
      {
        name: "setup_extension",
        description:
          "Help the user install the browser extension for widget injection without modifying project files. Opens the extension directory and provides step-by-step instructions for Chrome and Firefox.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "install_widget": {
      const devOnly = args?.dev_only !== false; // Default true
      const projectDir = args?.project_dir || process.cwd();
      let filePath = args?.file_path;

      // Default hostname patterns for local development
      const defaultHostnamePatterns = [
        'localhost',
        '127.0.0.1',
        '*.local',
        '*.local.*',
        '*.test',
        '*.dev',
        '*.ddev.site',
      ];
      const allowedHostnames = args?.allowed_hostnames || defaultHostnamePatterns;

      // Auto-detect HTML file if not specified
      if (!filePath) {
        const candidates = [
          'index.html',
          'public/index.html',
          'src/index.html',
          'app/index.html',
          'dist/index.html',
          'build/index.html',
          'www/index.html',
          'static/index.html',
        ];

        for (const candidate of candidates) {
          const fullPath = path.join(projectDir, candidate);
          if (fs.existsSync(fullPath)) {
            filePath = fullPath;
            break;
          }
        }

        if (!filePath) {
          return {
            content: [{
              type: "text",
              text: `Could not auto-detect HTML file in ${projectDir}. Searched for:\n${candidates.map(c => `  - ${c}`).join('\n')}\n\nPlease specify the file_path explicitly.`,
            }],
          };
        }
      }

      // Make path absolute if relative
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(projectDir, filePath);
      }

      // Check file exists
      if (!fs.existsSync(filePath)) {
        return {
          content: [{
            type: "text",
            text: `File not found: ${filePath}`,
          }],
        };
      }

      // Read current content
      let content = fs.readFileSync(filePath, 'utf8');

      // Check if already installed
      if (content.includes('localhost:' + PORT + '/widget.js') || content.includes('claude-feedback-widget')) {
        return {
          content: [{
            type: "text",
            text: `Widget already installed in ${filePath}`,
          }],
        };
      }

      // Generate script tag
      let scriptTag;
      let hostnameInfo;
      let detected = { url: null, detectedFrom: null };

      if (devOnly) {
        // Try to detect project URL for precise hostname matching
        detected = detectProjectUrl(projectDir);
        let hostnameCheck;

        if (detected.url) {
          // Use exact hostname match from detected URL
          const detectedHostname = new URL(detected.url).hostname;
          hostnameCheck = `h === '${detectedHostname}'`;
          hostnameInfo = `Development only (hostname: ${detectedHostname}, detected from ${detected.detectedFrom})`;
        } else {
          // Fall back to regex pattern matching
          const patternChecks = allowedHostnames.map(pattern => {
            // Escape special regex chars except *
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            // Convert * to regex pattern (match any chars including dots for multi-segment matches)
            const regexPattern = escaped.replace(/\*/g, '.*');
            return `/${'^' + regexPattern + '$'}/i.test(h)`;
          });
          hostnameCheck = patternChecks.join(' || ');
          hostnameInfo = `Development only (allowed hostnames: ${allowedHostnames.join(', ')})`;
        }

        scriptTag = `
<!-- Claude Code Browser Feedback Widget (dev only) -->
<script>
  (function() {
    var h = location.hostname;
    var isDevHost = ${hostnameCheck};
    if (isDevHost) {
      var s = document.createElement('script');
      s.src = 'http://localhost:${PORT}/widget.js?session=${SESSION_ID}';
      s.id = 'claude-feedback-widget-script';
      document.body.appendChild(s);
    }
  })();
</script>`;
      } else {
        hostnameInfo = 'Always loaded';
        scriptTag = `
<!-- Claude Code Browser Feedback Widget -->
<script src="http://localhost:${PORT}/widget.js?session=${SESSION_ID}" id="claude-feedback-widget-script"></script>`;
      }

      // Find injection point (before </body> or </html>)
      let injected = false;
      
      if (content.includes('</body>')) {
        content = content.replace('</body>', scriptTag + '\n</body>');
        injected = true;
      } else if (content.includes('</html>')) {
        content = content.replace('</html>', scriptTag + '\n</html>');
        injected = true;
      } else {
        // Append to end
        content += scriptTag;
        injected = true;
      }

      // Write back
      fs.writeFileSync(filePath, content, 'utf8');

      // Include URL info if detected (and not already in hostnameInfo)
      const urlInfo = detected.url
        ? `\n**URL:** [${detected.url}](${detected.url})`
        : '';

      return {
        content: [{
          type: "text",
          text: `✅ Widget installed successfully!

**File:** ${filePath}
**Mode:** ${hostnameInfo}${urlInfo}

The floating "Add annotation" button will appear when you load the page.

Next steps:
1. Refresh your browser to load the widget
2. Use \`wait_for_browser_feedback\` to receive feedback from the browser

**Tip:** You can also use the browser extension to toggle the widget without modifying files. Run \`setup_extension\` for instructions.`,
        }],
      };
    }

    case "uninstall_widget": {
      const projectDir = args?.project_dir || process.cwd();
      let filePath = args?.file_path;
      
      // If no file specified, search for files containing the widget
      if (!filePath) {
        const candidates = [
          'index.html',
          'public/index.html', 
          'src/index.html',
          'app/index.html',
          'dist/index.html',
          'build/index.html',
          'www/index.html',
          'static/index.html',
        ];

        for (const candidate of candidates) {
          const fullPath = path.join(projectDir, candidate);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('claude-feedback-widget') || content.includes('localhost:' + PORT + '/widget.js')) {
              filePath = fullPath;
              break;
            }
          }
        }

        if (!filePath) {
          return {
            content: [{
              type: "text",
              text: `Could not find any HTML file with the widget installed in ${projectDir}.`,
            }],
          };
        }
      }

      // Make path absolute if relative
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(projectDir, filePath);
      }

      // Check file exists
      if (!fs.existsSync(filePath)) {
        return {
          content: [{
            type: "text",
            text: `File not found: ${filePath}`,
          }],
        };
      }

      // Read content
      let content = fs.readFileSync(filePath, 'utf8');

      // Check if widget is installed
      if (!content.includes('claude-feedback-widget') && !content.includes('localhost:' + PORT + '/widget.js')) {
        return {
          content: [{
            type: "text",
            text: `Widget not found in ${filePath}`,
          }],
        };
      }

      // Remove the widget script block (handles both dev-only and always-on versions)
      // Pattern 1: Dev-only version with surrounding comment
      content = content.replace(
        /\n?<!-- Claude Code Browser Feedback Widget[^>]*-->[\s\S]*?claude-feedback-widget[\s\S]*?<\/script>/g,
        ''
      );
      
      // Pattern 2: Simple script tag
      content = content.replace(
        /\n?<script[^>]*src="http:\/\/localhost:\d+\/widget\.js"[^>]*><\/script>/g,
        ''
      );

      // Pattern 3: Script tag with id
      content = content.replace(
        /\n?<script[^>]*id="claude-feedback-widget-script"[^>]*>[\s\S]*?<\/script>/g,
        ''
      );

      // Clean up any leftover empty lines
      content = content.replace(/\n{3,}/g, '\n\n');

      // Write back
      fs.writeFileSync(filePath, content, 'utf8');

      return {
        content: [{
          type: "text",
          text: `✅ Widget uninstalled successfully from ${filePath}`,
        }],
      };
    }

    case "get_widget_snippet": {
      const snippet = `<script src="http://localhost:${PORT}/widget.js?session=${SESSION_ID}"></script>`;
      const instructions = `
Add this script tag to your web application's HTML (typically before </body>):

${snippet}

Once added, a small "Add annotation" button will appear in the bottom-right corner of your app.

Users can:
1. Click the button to activate annotation mode
2. Click on any element to select it
3. Add a description of the issue
4. Optionally include console logs
5. Send the feedback directly to Claude Code

The widget only loads in development (localhost) by default.

**Tip:** You can also use the browser extension to toggle the widget without modifying files. Run \`setup_extension\` for instructions.
      `.trim();

      return {
        content: [
          {
            type: "text",
            text: instructions,
          },
        ],
      };
    }

    case "wait_for_browser_feedback": {
      const timeoutSeconds = args?.timeout_seconds || 300;

      // If we don't own the HTTP server, poll via HTTP
      if (!isHttpServerOwner) {
        try {
          const feedback = await pollForFeedback(timeoutSeconds);
          return {
            content: formatFeedbackAsContent(feedback),
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: err.message,
              },
            ],
          };
        }
      }

      // Check if there's already ready feedback (user clicked "Send to Claude")
      const ready = getSessionReady(SESSION_ID);
      if (ready.length > 0) {
        const items = [...ready];
        setSessionReady(SESSION_ID, []);
        return {
          content: formatFeedbackAsContent(items),
        };
      }

      // Wait for user to click "Send to Claude"
      const feedback = await Promise.race([
        new Promise((resolve) => {
          getSessionResolvers(SESSION_ID).push(resolve);
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Timeout waiting for browser feedback")),
            timeoutSeconds * 1000
          )
        ),
      ]);

      // feedback is now an array (from send_to_claude handler)
      return {
        content: formatFeedbackAsContent(feedback),
      };
    }

    case "get_pending_feedback": {
      const shouldClear = args?.clear !== false;

      // If we don't own the HTTP server, fetch via HTTP
      if (!isHttpServerOwner) {
        const result = await fetchReadyFeedback(shouldClear);
        if (result && result.feedback) {
          if (result.feedback.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No pending feedback.",
                },
              ],
            };
          }
          return {
            content: formatFeedbackAsContent(result.feedback),
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Could not fetch feedback. Is the feedback server running?",
              },
            ],
          };
        }
      }

      const sessionReady = getSessionReady(SESSION_ID);
      const feedback = [...sessionReady];
      if (shouldClear) {
        setSessionReady(SESSION_ID, []);
      }

      if (feedback.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No pending feedback.",
            },
          ],
        };
      }

      return {
        content: formatFeedbackAsContent(feedback),
      };
    }

    case "preview_pending_feedback": {
      // If we don't own the HTTP server, fetch via HTTP
      if (!isHttpServerOwner) {
        const result = await fetchPendingSummary();
        if (result) {
          if (result.count === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No pending feedback.",
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Could not fetch feedback. Is the feedback server running?",
              },
            ],
          };
        }
      }

      const summary = getPendingSummary(SESSION_ID);
      if (summary.count === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No pending feedback.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }

    case "delete_pending_feedback": {
      const id = args?.id;
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id is required",
            },
          ],
        };
      }

      // If we don't own the HTTP server, delete via HTTP
      if (!isHttpServerOwner) {
        const result = await deleteFeedbackViaHttp(id);
        if (result) {
          return {
            content: [
              {
                type: "text",
                text: result.success
                  ? `Feedback ${id} deleted successfully.`
                  : `Feedback ${id} not found.`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Could not delete feedback. Is the feedback server running?",
              },
            ],
          };
        }
      }

      const pending = getSessionPending(SESSION_ID);
      const initialLength = pending.length;
      setSessionPending(SESSION_ID, pending.filter(f => f.id !== id));
      const deleted = getSessionPending(SESSION_ID).length < initialLength;

      if (deleted) {
        broadcastPendingStatus(SESSION_ID);
      }

      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Feedback ${id} deleted successfully.`
              : `Feedback ${id} not found.`,
          },
        ],
      };
    }

    case "wait_for_multiple_feedback": {
      const timeoutSeconds = args?.timeout_seconds || 300;
      const message = args?.message || "Submit all your feedback, then click 'Done' when finished.";

      // If we don't own the HTTP server, use a simpler polling approach
      if (!isHttpServerOwner) {
        // Check connection status first
        const status = await fetchServerStatus(SESSION_ID);
        if (!status || status.connectedClients === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No browser clients connected. Make sure the widget script is loaded in your app.",
              },
            ],
          };
        }

        // Clear any existing feedback and broadcast request
        await fetchReadyFeedback(true);
        await broadcastViaHttp({
          type: "request_multiple_annotations",
          message: message,
        });

        // Poll for feedback - collect until timeout or no new feedback for 5 seconds
        const allFeedback = [];
        const startTime = Date.now();
        let lastFeedbackTime = startTime;
        const idleTimeout = 5000; // 5 seconds of no new feedback = done

        while (Date.now() - startTime < timeoutSeconds * 1000) {
          const result = await fetchReadyFeedback(true);
          if (result && result.feedback && result.feedback.length > 0) {
            allFeedback.push(...result.feedback);
            lastFeedbackTime = Date.now();
          } else if (allFeedback.length > 0 && Date.now() - lastFeedbackTime > idleTimeout) {
            // Got some feedback and no new feedback for a while - assume done
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (allFeedback.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No feedback was submitted within the timeout period.",
              },
            ],
          };
        }

        return {
          content: formatFeedbackAsContent(allFeedback),
        };
      }

      const sessionClients = getSessionClients(SESSION_ID);
      if (sessionClients.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No browser clients connected. Make sure the widget script is loaded in your app.",
            },
          ],
        };
      }

      // Clear stale queues for this session
      setSessionReady(SESSION_ID, []);
      setSessionPending(SESSION_ID, []);
      broadcastPendingStatus(SESSION_ID);

      // Send request to browser to enter multi-feedback mode
      broadcast({
        type: "request_multiple_annotations",
        message: message,
      }, SESSION_ID);

      // Check if ready feedback already has items (early return)
      const readyNow = getSessionReady(SESSION_ID);
      if (readyNow.length > 0) {
        const items = [...readyNow];
        setSessionReady(SESSION_ID, []);
        return {
          content: formatFeedbackAsContent(items),
        };
      }

      // Wait for user to press "Send to Claude" via feedbackResolvers
      try {
        const allFeedback = await Promise.race([
          new Promise((resolve) => {
            getSessionResolvers(SESSION_ID).push(resolve);
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Timeout waiting for feedback")),
              timeoutSeconds * 1000
            )
          ),
        ]);

        if (allFeedback.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "User clicked Send but no feedback was submitted.",
              },
            ],
          };
        }

        return {
          content: formatFeedbackAsContent(allFeedback),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err.message,
            },
          ],
        };
      }
    }

    case "get_connection_status": {
      // If we don't own the HTTP server, fetch status from the running server
      if (!isHttpServerOwner) {
        const status = await fetchServerStatus();
        if (status) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    connected: status.connectedClients > 0,
                    clientCount: status.connectedClients,
                    serverUrl: `http://localhost:${PORT}`,
                    widgetUrl: `http://localhost:${PORT}/widget.js?session=${SESSION_ID}`,
                    sessionId: SESSION_ID,
                    note: "Status fetched from running server (this MCP instance is proxying)",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    connected: false,
                    clientCount: 0,
                    serverUrl: `http://localhost:${PORT}`,
                    widgetUrl: `http://localhost:${PORT}/widget.js`,
                    error: "Could not connect to feedback server. Is it running?",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      const sessionClientCount = getSessionClients(SESSION_ID).size;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                connected: sessionClientCount > 0,
                clientCount: sessionClientCount,
                serverUrl: `http://localhost:${PORT}`,
                widgetUrl: `http://localhost:${PORT}/widget.js?session=${SESSION_ID}`,
                sessionId: SESSION_ID,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "request_annotation": {
      const message = args?.message || "Please annotate the issue you'd like to report.";

      // If we don't own the HTTP server, broadcast via HTTP
      if (!isHttpServerOwner) {
        const result = await broadcastViaHttp({
          type: "request_annotation",
          message: message,
        });
        if (result && result.success) {
          return {
            content: [
              {
                type: "text",
                text: result.clientCount > 0
                  ? `Annotation request sent to ${result.clientCount} connected browser(s). The user will see a prompt asking them to annotate.`
                  : "No browser clients connected. Make sure the widget script is loaded in your app.",
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Could not send annotation request. Is the feedback server running?",
              },
            ],
          };
        }
      }

      const sessionClientCount = getSessionClients(SESSION_ID).size;
      if (sessionClientCount === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No browser clients connected. Make sure the widget script is loaded in your app.",
            },
          ],
        };
      }

      broadcast({
        type: "request_annotation",
        message: message,
      }, SESSION_ID);

      return {
        content: [
          {
            type: "text",
            text: `Annotation request sent to ${sessionClientCount} connected browser(s). The user will see a prompt asking them to annotate.`,
          },
        ],
      };
    }

    case "open_in_browser": {
      const projectDir = args?.project_dir || process.cwd();
      const shouldOpen = args?.open === true;
      let url = args?.url;
      let detectedFrom = null;

      // If no URL provided, try to detect from config files
      if (!url) {
        const detected = detectProjectUrl(projectDir);
        url = detected.url;
        detectedFrom = detected.detectedFrom;

        if (!url) {
          return {
            content: [{
              type: "text",
              text: `Could not detect project URL in ${projectDir}.\n\nSearched in:\n- .env (APP_URL, BASE_URL, SITE_URL, VIRTUAL_HOST, etc.)\n- .env.local\n- docker-compose.yml (VIRTUAL_HOST, traefik labels)\n- docker-compose.override.yml\n- package.json (homepage, proxy)\n\nPlease provide an explicit URL using the 'url' parameter.`,
            }],
          };
        }
      }

      // If not opening, just return the URL
      if (!shouldOpen) {
        return {
          content: [{
            type: "text",
            text: detectedFrom
              ? `Detected URL: ${url}\nSource: ${detectedFrom}`
              : `URL: ${url}`,
          }],
        };
      }

      // Open in browser based on platform using execFile (safer than exec)
      const platform = process.platform;
      let command;
      let commandArgs;

      if (platform === 'darwin') {
        command = 'open';
        commandArgs = [url];
      } else if (platform === 'win32') {
        command = 'cmd';
        commandArgs = ['/c', 'start', '', url];
      } else {
        // Linux and others
        command = 'xdg-open';
        commandArgs = [url];
      }

      return new Promise((resolve) => {
        execFile(command, commandArgs, (error) => {
          if (error) {
            resolve({
              content: [{
                type: "text",
                text: `Failed to open browser: ${error.message}\n\nURL: ${url}\n\nYou can open it manually.`,
              }],
            });
          } else {
            resolve({
              content: [{
                type: "text",
                text: detectedFrom
                  ? `Opened ${url} in your default browser.\n\nDetected from: ${detectedFrom}`
                  : `Opened ${url} in your default browser.`,
              }],
            });
          }
        });
      });
    }

    case "setup_extension": {
      const extensionDir = path.join(__dirname, '..', 'extension');

      // Check extension directory exists
      if (!fs.existsSync(extensionDir)) {
        return {
          content: [{
            type: "text",
            text: `Extension directory not found at ${extensionDir}. Make sure you have the full package installed.`,
          }],
        };
      }

      // Open the extension directory in the file manager
      const platform = process.platform;
      let openCommand;
      let openArgs;

      if (platform === 'darwin') {
        openCommand = 'open';
        openArgs = [extensionDir];
      } else if (platform === 'win32') {
        openCommand = 'explorer';
        openArgs = [extensionDir];
      } else {
        openCommand = 'xdg-open';
        openArgs = [extensionDir];
      }

      return new Promise((resolve) => {
        execFile(openCommand, openArgs, (error) => {
          const instructions = `## Browser Extension Setup

The extension directory has been opened in your file manager.

### Chrome
1. Navigate to \`chrome://extensions\`
2. Enable **Developer Mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the opened folder: \`${extensionDir}\`

### Firefox
1. Navigate to \`about:debugging#/runtime/this-firefox\`
2. Click **Load Temporary Add-on...**
3. Select \`manifest.json\` from: \`${extensionDir}\`

### Usage
Once installed, click the extension icon in your browser toolbar to toggle the feedback widget on any tab. No need to modify project HTML files.

The extension connects to the MCP server at \`http://localhost:${PORT}\`. You can change this in the extension popup settings.`;

          if (error) {
            resolve({
              content: [{
                type: "text",
                text: `Could not open file manager: ${error.message}\n\n${instructions}`,
              }],
            });
          } else {
            resolve({
              content: [{
                type: "text",
                text: instructions,
              }],
            });
          }
        });
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ============================================
// Graceful shutdown handling
// ============================================

let isShuttingDown = false;

function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.error(`[browser-feedback-mcp] Shutting down: ${reason}`);

  // Only close HTTP server if we own it
  if (isHttpServerOwner) {
    // Remove own session from registry
    sessionRegistry.delete(SESSION_ID);

    // Close all WebSocket connections
    for (const client of connectedClients) {
      try {
        client.close();
      } catch (err) {
        // Ignore errors during shutdown
      }
    }

    // Close the WebSocket server
    wss.close(() => {
      console.error('[browser-feedback-mcp] WebSocket server closed');
    });

    // Close the HTTP server
    httpServer.close(() => {
      console.error('[browser-feedback-mcp] HTTP server closed');
      process.exit(0);
    });

    // Force exit after timeout if graceful shutdown fails
    setTimeout(() => {
      console.error('[browser-feedback-mcp] Forcing exit after timeout');
      process.exit(0);
    }, 2000);
  } else {
    // Unregister from owner server before exit
    unregisterSessionViaHttp().finally(() => {
      process.exit(0);
    });
    // Force exit after timeout
    setTimeout(() => process.exit(0), 2000);
  }
}

// Listen for stdin close (MCP client disconnected)
process.stdin.on('end', () => shutdown('stdin ended'));
process.stdin.on('close', () => shutdown('stdin closed'));

// Handle signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================
// Start servers
// ============================================

// Try to bind the HTTP server with health-check-and-retry for stale processes.
// When EADDRINUSE occurs, we check if the existing server is healthy (GET /status).
// If healthy, we accept proxy mode. If not (zombie process), we wait and retry.
async function tryListenWithRetry(maxRetries = 3, retryDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          httpServer.removeListener('error', onError);
          reject(err);
        };
        httpServer.on('error', onError);
        httpServer.listen(PORT, () => {
          httpServer.removeListener('error', onError);
          resolve();
        });
      });
      // Successfully bound the port
      isHttpServerOwner = true;
      console.error(`[browser-feedback-mcp] HTTP/WebSocket server running on http://localhost:${PORT}`);
      console.error(`[browser-feedback-mcp] Widget available at http://localhost:${PORT}/widget.js`);
      return;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') {
        console.error(`[browser-feedback-mcp] HTTP server error:`, err);
        return; // Non-retryable error, fall back to proxy mode
      }

      // Port in use — check if the existing server is actually healthy
      const status = await fetchServerStatus();
      if (status) {
        console.error(`[browser-feedback-mcp] Port ${PORT} is in use by a healthy server.`);
        console.error(`[browser-feedback-mcp] MCP tools will proxy requests to the running server.`);
        return; // Healthy server exists, use proxy mode
      }

      // Server on the port is unresponsive (zombie/stale process)
      if (attempt <= maxRetries) {
        console.error(`[browser-feedback-mcp] Port ${PORT} is held by an unresponsive process. Retrying in ${retryDelay}ms... (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        console.error(`[browser-feedback-mcp] Port ${PORT} still unavailable after ${maxRetries} retries. Running in proxy mode.`);
      }
    }
  }
}

async function main() {
  // Start MCP server first (this is the critical part for Claude Code)
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("[browser-feedback-mcp] MCP server connected via stdio");

  // Start HTTP/WebSocket server (may fail if port is in use, but MCP will still work)
  await tryListenWithRetry();

  // Register this session
  const detected = detectProjectUrl(PROJECT_DIR);
  if (isHttpServerOwner) {
    // Owner registers directly
    sessionRegistry.set(SESSION_ID, {
      sessionId: SESSION_ID,
      projectDir: PROJECT_DIR,
      projectUrl: detected.url,
      detectedFrom: detected.detectedFrom,
      registeredAt: new Date().toISOString(),
    });
    console.error(`[browser-feedback-mcp] Session: ${SESSION_ID}`);
  } else {
    // Proxy registers via HTTP
    await registerSessionViaHttp();
    console.error(`[browser-feedback-mcp] Session registered: ${SESSION_ID}`);
  }
}

main().catch((error) => {
  console.error("[browser-feedback-mcp] Fatal error:", error);
  process.exit(1);
});
