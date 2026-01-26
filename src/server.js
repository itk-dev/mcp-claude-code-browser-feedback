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
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.FEEDBACK_PORT || "9877");

// Store for received feedback
let pendingFeedback = [];
let feedbackResolvers = []; // Promises waiting for feedback
let connectedClients = new Set();
let isHttpServerOwner = false; // Track if this instance owns the HTTP server

// Helper to generate pending feedback summary (without full payloads)
function getPendingSummary() {
  return {
    count: pendingFeedback.length,
    items: pendingFeedback.map(f => ({
      id: f.id,
      timestamp: f.timestamp || f.receivedAt,
      description: f.description ? f.description.slice(0, 100) : '',
      selector: f.element?.selector || '',
    })),
  };
}

// Broadcast pending status to all connected clients
function broadcastPendingStatus() {
  const status = getPendingSummary();
  const message = JSON.stringify({ type: 'pending_status', ...status });
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Helper to fetch status from the running HTTP server
async function fetchServerStatus() {
  try {
    const response = await fetch(`http://localhost:${PORT}/status`);
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    // Server not running or not reachable
  }
  return null;
}

// Helper to fetch feedback from the running HTTP server
async function fetchPendingFeedback(clear = true) {
  try {
    const response = await fetch(`http://localhost:${PORT}/feedback?clear=${clear}`);
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
    const result = await fetchPendingFeedback(true);
    if (result && result.feedback && result.feedback.length > 0) {
      return result.feedback[0];
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  throw new Error("Timeout waiting for browser feedback");
}

// Helper to broadcast message via the running HTTP server
async function broadcastViaHttp(message) {
  try {
    const response = await fetch(`http://localhost:${PORT}/broadcast`, {
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
    const response = await fetch(`http://localhost:${PORT}/pending-summary`);
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
    const response = await fetch(`http://localhost:${PORT}/feedback/${id}`, {
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
    fs.readFile(widgetPath, "utf8", (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading widget");
        return;
      }
      // Inject the WebSocket URL into the widget
      const injectedContent = content.replace(
        "__WEBSOCKET_URL__",
        `ws://localhost:${PORT}/ws`
      );
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(injectedContent);
    });
    return;
  }

  if (urlObj.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "running",
        connectedClients: connectedClients.size,
        pendingFeedback: pendingFeedback.length,
      })
    );
    return;
  }

  // GET /feedback - retrieve pending feedback (used by secondary MCP instances)
  if (urlObj.pathname === "/feedback" && req.method === "GET") {
    const shouldClear = urlObj.searchParams.get("clear") !== "false";
    const feedback = [...pendingFeedback];
    if (shouldClear) {
      pendingFeedback = [];
      broadcastPendingStatus();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ feedback }));
    return;
  }

  // GET /pending-summary - get summary of pending feedback without full payloads
  if (urlObj.pathname === "/pending-summary" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getPendingSummary()));
    return;
  }

  // DELETE /feedback/:id - remove a specific pending feedback item
  const deleteMatch = urlObj.pathname.match(/^\/feedback\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const idToDelete = deleteMatch[1];
    const initialLength = pendingFeedback.length;
    pendingFeedback = pendingFeedback.filter(f => f.id !== idToDelete);
    const deleted = pendingFeedback.length < initialLength;

    if (deleted) {
      broadcastPendingStatus();
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
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const message = JSON.parse(body);
        const data = JSON.stringify(message);
        let sentCount = 0;
        for (const client of connectedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data);
            sentCount++;
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, clientCount: sentCount }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
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

wss.on("connection", (ws) => {
  connectedClients.add(ws);
  console.error(`[browser-feedback-mcp] Client connected. Total: ${connectedClients.size}`);

  // Send connection confirmation
  ws.send(JSON.stringify({ type: "connected", message: "Connected to Claude Code feedback server" }));

  // Send current pending status to newly connected client
  const status = getPendingSummary();
  ws.send(JSON.stringify({ type: 'pending_status', ...status }));

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "feedback") {
        console.error(`[browser-feedback-mcp] Received feedback from browser`);

        const feedback = {
          ...message.payload,
          receivedAt: new Date().toISOString(),
        };

        pendingFeedback.push(feedback);

        // Resolve any waiting promises
        while (feedbackResolvers.length > 0) {
          const resolver = feedbackResolvers.shift();
          resolver(feedback);
        }

        // Acknowledge receipt
        ws.send(JSON.stringify({ type: "feedback_received", id: feedback.id }));

        // Broadcast updated pending status to all clients
        broadcastPendingStatus();
      }

      if (message.type === "delete_feedback") {
        const idToDelete = message.id;
        const initialLength = pendingFeedback.length;
        pendingFeedback = pendingFeedback.filter(f => f.id !== idToDelete);
        const deleted = pendingFeedback.length < initialLength;

        if (deleted) {
          console.error(`[browser-feedback-mcp] Deleted feedback: ${idToDelete}`);
          // Broadcast updated pending status to all clients
          broadcastPendingStatus();
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
    console.error(`[browser-feedback-mcp] Client disconnected. Total: ${connectedClients.size}`);
  });
});

// Broadcast to all connected clients
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of connectedClients) {
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
      if (devOnly) {
        // Convert glob patterns to regex patterns for browser-side matching
        const patternChecks = allowedHostnames.map(pattern => {
          // Escape special regex chars except *
          const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
          // Convert * to regex pattern (match any chars including dots for multi-segment matches)
          const regexPattern = escaped.replace(/\*/g, '.*');
          return `/${'^' + regexPattern + '$'}/i.test(h)`;
        });

        scriptTag = `
<!-- Claude Code Browser Feedback Widget (dev only) -->
<script>
  (function() {
    var h = location.hostname;
    var isDevHost = ${patternChecks.join(' || ')};
    if (isDevHost) {
      var s = document.createElement('script');
      s.src = 'http://localhost:${PORT}/widget.js';
      s.id = 'claude-feedback-widget-script';
      document.body.appendChild(s);
    }
  })();
</script>`;
      } else {
        scriptTag = `
<!-- Claude Code Browser Feedback Widget -->
<script src="http://localhost:${PORT}/widget.js" id="claude-feedback-widget-script"></script>`;
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

      const hostnameInfo = devOnly
        ? `Development only (allowed hostnames: ${allowedHostnames.join(', ')})`
        : 'Always loaded';

      return {
        content: [{
          type: "text",
          text: `✅ Widget installed successfully!

**File:** ${filePath}
**Mode:** ${hostnameInfo}

The floating "Add annotation" button will appear when you load the page.

Next steps:
1. Refresh your browser to load the widget
2. Use \`wait_for_browser_feedback\` to receive feedback from the browser`,
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
      const snippet = `<script src="http://localhost:${PORT}/widget.js"></script>`;
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
            content: [
              {
                type: "text",
                text: JSON.stringify(feedback, null, 2),
              },
            ],
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

      // Check if there's already pending feedback
      if (pendingFeedback.length > 0) {
        const feedback = pendingFeedback.shift();
        broadcastPendingStatus();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(feedback, null, 2),
            },
          ],
        };
      }

      // Wait for new feedback
      const feedback = await Promise.race([
        new Promise((resolve) => {
          feedbackResolvers.push(resolve);
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Timeout waiting for browser feedback")),
            timeoutSeconds * 1000
          )
        ),
      ]);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(feedback, null, 2),
          },
        ],
      };
    }

    case "get_pending_feedback": {
      const shouldClear = args?.clear !== false;

      // If we don't own the HTTP server, fetch via HTTP
      if (!isHttpServerOwner) {
        const result = await fetchPendingFeedback(shouldClear);
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
            content: [
              {
                type: "text",
                text: JSON.stringify(result.feedback, null, 2),
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

      const feedback = [...pendingFeedback];
      if (shouldClear) {
        pendingFeedback = [];
        if (feedback.length > 0) {
          broadcastPendingStatus();
        }
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
        content: [
          {
            type: "text",
            text: JSON.stringify(feedback, null, 2),
          },
        ],
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

      const summary = getPendingSummary();
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

      const initialLength = pendingFeedback.length;
      pendingFeedback = pendingFeedback.filter(f => f.id !== id);
      const deleted = pendingFeedback.length < initialLength;

      if (deleted) {
        broadcastPendingStatus();
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
        const status = await fetchServerStatus();
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
        await fetchPendingFeedback(true);
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
          const result = await fetchPendingFeedback(true);
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
          content: [
            {
              type: "text",
              text: `Received ${allFeedback.length} feedback item(s):\n\n${JSON.stringify(allFeedback, null, 2)}`,
            },
          ],
        };
      }

      if (connectedClients.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No browser clients connected. Make sure the widget script is loaded in your app.",
            },
          ],
        };
      }

      // Clear any existing pending feedback
      pendingFeedback = [];

      // Send request to browser to enter multi-feedback mode
      broadcast({
        type: "request_multiple_annotations",
        message: message,
      });

      // Wait for "done" signal from browser
      const allFeedback = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timeout waiting for feedback"));
        }, timeoutSeconds * 1000);

        // Listen for done signal
        const doneHandler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "feedback_batch_complete") {
              clearTimeout(timeout);
              resolve([...pendingFeedback]);
              pendingFeedback = [];
            }
          } catch (e) {
            // Ignore parse errors
          }
        };

        // Add listener to all clients
        for (const client of connectedClients) {
          client.on("message", doneHandler);
        }
      });

      if (allFeedback.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "User clicked Done but no feedback was submitted.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Received ${allFeedback.length} feedback item(s):\n\n${JSON.stringify(allFeedback, null, 2)}`,
          },
        ],
      };
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
                    widgetUrl: `http://localhost:${PORT}/widget.js`,
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                connected: connectedClients.size > 0,
                clientCount: connectedClients.size,
                serverUrl: `http://localhost:${PORT}`,
                widgetUrl: `http://localhost:${PORT}/widget.js`,
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

      if (connectedClients.size === 0) {
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
      });

      return {
        content: [
          {
            type: "text",
            text: `Annotation request sent to ${connectedClients.size} connected browser(s). The user will see a prompt asking them to annotate.`,
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
                  url = strategy.transform(match);
                  detectedFrom = strategy.file;
                  break;
                }
              }
              if (url) break;
            } catch (err) {
              // Continue to next strategy
            }
          }
        }

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
    // Not the HTTP server owner, just exit
    process.exit(0);
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

async function main() {
  // Start MCP server first (this is the critical part for Claude Code)
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("[browser-feedback-mcp] MCP server connected via stdio");

  // Start HTTP/WebSocket server (may fail if port is in use, but MCP will still work)
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[browser-feedback-mcp] Port ${PORT} is already in use by another instance.`);
      console.error(`[browser-feedback-mcp] MCP tools will proxy requests to the running server.`);
      // isHttpServerOwner remains false, tools will use HTTP proxy
    } else {
      console.error(`[browser-feedback-mcp] HTTP server error:`, err);
    }
  });

  httpServer.listen(PORT, () => {
    isHttpServerOwner = true;
    console.error(`[browser-feedback-mcp] HTTP/WebSocket server running on http://localhost:${PORT}`);
    console.error(`[browser-feedback-mcp] Widget available at http://localhost:${PORT}/widget.js`);
  });
}

main().catch((error) => {
  console.error("[browser-feedback-mcp] Fatal error:", error);
  process.exit(1);
});
