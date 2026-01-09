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
git clone https://github.com/yepzdk/mcp-claude-code-browser-feedback.git
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

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `install_widget` | Auto-inject the widget script into your app's HTML |
| `uninstall_widget` | Remove the widget when done |
| `wait_for_browser_feedback` | Block until user submits single feedback |
| `wait_for_multiple_feedback` | Wait for multiple feedback items (user clicks Done when finished) |
| `get_pending_feedback` | Get any feedback that's been submitted |
| `get_connection_status` | Check if browser clients are connected |
| `request_annotation` | Prompt the user to annotate something specific |
| `get_widget_snippet` | Get the script tag for manual installation |

### install_widget Options

```javascript
{
  // Optional: specific file path (auto-detects if not provided)
  "file_path": "public/index.html",

  // Optional: project directory to search
  "project_dir": "/path/to/project",

  // Optional: only load on localhost (default: true)
  "dev_only": true
}
```

**Auto-detection** searches these common locations:
- `index.html`
- `public/index.html`
- `src/index.html`
- `app/index.html`
- `dist/index.html`
- `build/index.html`

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
- **Screenshot capture** - Automatic viewport capture (enhanced with html2canvas if available)
- **Console log capture** - Includes recent console messages
- **Multi-feedback mode** - Submit multiple annotations before sending to Claude

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FEEDBACK_PORT` | `9877` | Port for HTTP/WebSocket server |

## Advanced: Screenshot Capture

For better screenshot quality, include html2canvas in your app:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<script src="http://localhost:9877/widget.js"></script>
```

The widget will automatically use html2canvas if available.

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

- The server only listens on `localhost` by default
- The widget only connects to `localhost`
- No data is sent to external servers
- All communication stays on your machine

## License

MIT
