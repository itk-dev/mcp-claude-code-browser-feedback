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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.FEEDBACK_PORT || "9877");

// Store for received feedback
let pendingFeedback = [];
let feedbackResolvers = []; // Promises waiting for feedback
let connectedClients = new Set();

// ============================================
// HTTP Server - serves widget.js
// ============================================

const httpServer = http.createServer((req, res) => {
  // CORS headers for cross-origin requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === "/widget.js") {
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

  if (req.url === "/status") {
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
              description: "List of hostnames or patterns allowed when dev_only is true. Supports exact matches (e.g., 'localhost') and wildcard patterns (e.g., '*.local.itkdev.dk', '*.local.*'). Defaults to common local dev patterns: localhost, 127.0.0.1, *.local, *.local.*, *.test, *.dev, *.ddev.site",
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
          // Convert * to regex pattern (match any chars except dots for single *, any chars for **)
          const regexPattern = escaped.replace(/\\\*/g, '[^.]*');
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

The floating "🎯 Report Issue" button will appear when you load the page.

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

Once added, a small "🎯 Report Issue" button will appear in the bottom-right corner of your app.

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
      
      // Check if there's already pending feedback
      if (pendingFeedback.length > 0) {
        const feedback = pendingFeedback.shift();
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
      const feedback = [...pendingFeedback];
      if (shouldClear) {
        pendingFeedback = [];
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

    case "wait_for_multiple_feedback": {
      const timeoutSeconds = args?.timeout_seconds || 300;
      const message = args?.message || "Submit all your feedback, then click 'Done' when finished.";

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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

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
      console.error(`[browser-feedback-mcp] Warning: Port ${PORT} is already in use.`);
      console.error(`[browser-feedback-mcp] Another instance may be running, or use FEEDBACK_PORT env var to change port.`);
      console.error(`[browser-feedback-mcp] MCP server is still running, but browser widget won't be available on this port.`);
    } else {
      console.error(`[browser-feedback-mcp] HTTP server error:`, err);
    }
  });

  httpServer.listen(PORT, () => {
    console.error(`[browser-feedback-mcp] HTTP/WebSocket server running on http://localhost:${PORT}`);
    console.error(`[browser-feedback-mcp] Widget available at http://localhost:${PORT}/widget.js`);
  });
}

main().catch((error) => {
  console.error("[browser-feedback-mcp] Fatal error:", error);
  process.exit(1);
});
