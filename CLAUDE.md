# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser Feedback MCP is a Model Context Protocol server that enables visual browser feedback collection directly into Claude Code. Users can point at elements in their browser and send annotated feedback (screenshots, element info, console logs) that Claude can act on.

## Commands

```bash
npm install    # Install dependencies
npm start      # Run the MCP server (node src/server.js)
```

## Architecture

This is a plain JavaScript (ES modules) project with no TypeScript or build step.

**Two main files:**

- `src/server.js` - MCP server combining:
  - HTTP server (serves widget.js, handles /status endpoint)
  - WebSocket server (real-time browser ↔ server communication)
  - MCP server (stdio transport for Claude Code integration)

- `src/widget.js` - Browser-side widget that:
  - Injects UI for element selection and feedback submission
  - Captures console logs, screenshots (via html2canvas if available), and element metadata
  - Communicates with server via WebSocket
  - `__WEBSOCKET_URL__` placeholder is replaced at serve-time with actual WebSocket URL

**Data flow:**
1. Widget injected into user's web app (via `install_widget` tool or manual script tag)
2. User selects element and submits feedback
3. Widget sends feedback via WebSocket to server
4. Server stores feedback and resolves any pending `wait_for_browser_feedback` promises
5. Claude receives structured feedback (element info, screenshot, console logs, description)

## MCP Tools

| Tool | Purpose |
|------|---------|
| `install_widget` | Auto-inject widget script into HTML file. Supports `allowed_hostnames` parameter for custom dev domains (e.g., `*.local.itkdev.dk`) |
| `uninstall_widget` | Remove widget script from HTML file |
| `wait_for_browser_feedback` | Block until user submits feedback (default 5min timeout) |
| `get_pending_feedback` | Get already-submitted feedback without blocking |
| `get_connection_status` | Check WebSocket client connections |
| `request_annotation` | Broadcast prompt to connected browsers asking user to annotate |
| `get_widget_snippet` | Get manual installation script tag |
| `open_in_browser` | Open project URL in default browser (auto-detects from .env, docker-compose.yml, etc.) |

### install_widget Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file_path` | string | auto-detect | Path to HTML file to inject widget into |
| `project_dir` | string | cwd | Project directory to search for HTML files |
| `dev_only` | boolean | true | Only load widget on allowed hostnames |
| `allowed_hostnames` | array | see below | List of hostnames/patterns allowed when `dev_only` is true |

**Default `allowed_hostnames` patterns:**
- `localhost`, `127.0.0.1` - Standard localhost
- `*.local` - macOS .local domains
- `*.local.*` - Custom local subdomains (e.g., `app.local.example.dk`)
- `*.test`, `*.dev` - Common dev TLDs
- `*.ddev.site` - DDEV local development

**Pattern syntax:** Use `*` as wildcard to match any characters except dots. Examples:
- `myapp.local.itkdev.dk` - Exact match
- `*.local.itkdev.dk` - Matches any subdomain of local.itkdev.dk
- `*.local.*` - Matches any domain with .local. in it

## Configuration

Environment variable `FEEDBACK_PORT` (default: 9877) controls the HTTP/WebSocket server port.
