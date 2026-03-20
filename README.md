# Browser Feedback MCP for Claude Code

A Model Context Protocol (MCP) server that enables visual browser feedback collection directly into Claude Code. Users can point at elements in their browser and send annotated feedback that Claude can act on immediately.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Web App (localhost:3000)                                  │
│                                                                 │
│  [Widget auto-injected by Claude]                               │
│                                                                 │
│                                        ┌──────────────────┐     │
│       Your App UI                      │ Add annotation   │     │
│                                        └──────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                             │
                        WebSocket
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  browser-feedback-mcp server (localhost:9877)                   │
└─────────────────────────────────────────────────────────────────┘
                             │
                        MCP Protocol
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code                                                    │
│                                                                 │
│  "Let me annotate" → installs widget → waits → receives feedback│
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### 1. Install the MCP Server

```bash
# Clone the repository
git clone https://github.com/itk-dev/mcp-claude-code-browser-feedback.git
cd mcp-claude-code-browser-feedback

# Install dependencies
npm install
```

### 2. Add to Claude Code

```bash
claude mcp add --scope user browser-feedback node /path/to/mcp-claude-code-browser-feedback/src/server.js
```

Or add manually to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "browser-feedback": {
      "command": "node",
      "args": ["/path/to/mcp-claude-code-browser-feedback/src/server.js"],
      "env": {
        "FEEDBACK_PORT": "9877"
      }
    }
  }
}
```

## Usage

### Basic Workflow

Tell Claude you want to show it something in the browser:

```
You: There's a bug with the checkout button, let me show you

Claude: I'll install the feedback widget and wait for your annotation.

        [Calls: install_widget]
        ✅ Widget installed in public/index.html

        [Calls: wait_for_browser_feedback]
        Please refresh your browser. You'll see an "Add annotation" button.
        Click it, then click on the problematic element.

--- You use the browser widget to select the button ---

Claude: I received your feedback! I can see:

        📸 Screenshot captured
        🎯 Element: <button class="checkout-btn" disabled>
        📝 Your description: "Button stays disabled even with items in cart"
        🔴 Console Error: "TypeError: Cannot read property 'items' of null"

        Let me look at the checkout code and fix this...
```

### Multiple Annotations

You can submit multiple feedback items at once:

```
You: I have several issues to show you

Claude: [Calls: wait_for_multiple_feedback]
        Submit all your annotations, then click "Done" when finished.

--- You submit 3 feedback items, then click Done ---

Claude: I received 3 feedback items. Let me address each one...
```

### Offline Export

The widget works without a server connection. When offline, feedback is stored locally and can be exported:

- **Export Markdown** - Click "Pending" to open the queue, then "Export Markdown" to download a `.md` file
- **Create GitHub Issue** - Click "Create GitHub Issue" to open a pre-filled issue in your browser (you'll be prompted for the repository on first use, stored in localStorage)

## Browser Extension

Instead of modifying project HTML files, you can use the browser extension to toggle the widget on any tab.

### Installation

#### Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer Mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository

#### Firefox

1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `extension/manifest.json` from this repository

Or ask Claude to run the `setup_extension` tool, which opens the folder and shows instructions.

### Usage

1. Click the extension icon in your browser toolbar
2. Toggle the widget ON for the current tab
3. The feedback widget appears without any file changes
4. Toggle OFF to cleanly remove the widget

The extension connects to the MCP server at `http://localhost:9877` by default. You can change the server URL in the extension popup.

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `install_widget` | Auto-inject the widget script into your app's HTML |
| `uninstall_widget` | Remove the widget when done |
| `wait_for_browser_feedback` | Block until user submits single feedback |
| `wait_for_multiple_feedback` | Wait for multiple feedback items (user clicks Done when finished) |
| `get_pending_feedback` | Get any feedback that's been submitted |
| `preview_pending_feedback` | Preview pending feedback summaries without consuming them |
| `delete_pending_feedback` | Delete a specific pending feedback item by ID |
| `get_connection_status` | Check if browser clients are connected |
| `request_annotation` | Prompt the user to annotate something specific |
| `get_widget_snippet` | Get the script tag for manual installation |
| `open_in_browser` | Open project URL in default browser (auto-detects from config files) |
| `setup_extension` | Help install the browser extension (opens folder + instructions) |

### install_widget Options

```javascript
{
  // Optional: specific file path (auto-detects if not provided)
  "file_path": "public/index.html",

  // Optional: project directory to search
  "project_dir": "/path/to/project",

  // Optional: only load on allowed hostnames (default: true)
  "dev_only": true,

  // Optional: hostnames/patterns allowed when dev_only is true
  // Supports '*' wildcard (e.g., '*.local.itkdev.dk')
  // Defaults to: localhost, 127.0.0.1, *.local, *.local.*, *.test, *.dev, *.ddev.site
  "allowed_hostnames": ["localhost", "*.local.itkdev.dk"]
}
```

**Auto-detection** searches these common locations:
- `index.html`
- `public/index.html`
- `src/index.html`
- `app/index.html`
- `dist/index.html`
- `build/index.html`
- `www/index.html`
- `static/index.html`

### Manual Installation (Alternative)

If you prefer manual control, add this script tag to your HTML:

```html
<script src="http://localhost:9877/widget.js"></script>
```

Or for development-only loading:

```html
<script>
  if (location.hostname === 'localhost') {
    const s = document.createElement('script');
    s.src = 'http://localhost:9877/widget.js';
    document.body.appendChild(s);
  }
</script>
```

## Widget Features

- **Draggable dialog** - Move the feedback panel anywhere on screen
- **Minimizable** - Collapse the panel to just the header bar
- **Collapsible element details** - Technical info hidden by default
- **Screenshot capture** - Automatic viewport capture using html2canvas (bundled)
- **Console log capture** - Includes recent console messages
- **Multi-feedback mode** - Submit multiple annotations before sending to Claude
- **Shadow DOM isolation** - Widget styles are isolated from host page CSS
- **Offline mode** - Annotate elements even without a server connection; feedback is stored locally
- **Export to Markdown** - Download pending feedback as a structured Markdown file
- **Export to GitHub Issue** - Open a pre-filled GitHub issue directly from the widget

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FEEDBACK_PORT` | `9877` | Port for HTTP/WebSocket server |

## Screenshot Capture

The widget automatically captures viewport screenshots using html2canvas, which is bundled with the MCP server and loaded on demand. No extra setup is needed.

## Troubleshooting

### Widget shows "disconnected" (gray button)

- Make sure the MCP server is running (check with `/mcp` in Claude Code)
- Check that the port (9877) is not in use by another process
- Try restarting Claude Code

### Port already in use

The server handles this gracefully - the MCP tools will still work, but you'll need to free the port for the browser widget:

```bash
# Find and kill the process using port 9877
lsof -i :9877
kill <PID>
```

Or use a different port:

```bash
FEEDBACK_PORT=9878 node src/server.js
```

### No feedback received

- Check browser console for WebSocket errors
- Ensure the widget script loaded correctly
- Verify the MCP server logs for connection info

## Security Notes

- The widget only connects to `localhost`
- No data is sent to external servers
- All communication stays on your machine
- **Note:** The HTTP/WebSocket server listens on all interfaces (`0.0.0.0`) by default. If you need to restrict this, use a firewall or bind to a specific interface via a reverse proxy.

## License

MIT
