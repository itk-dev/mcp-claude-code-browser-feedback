# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-09

### Added

- Initial release of Browser Feedback MCP for Claude Code
- MCP server with stdio transport for Claude Code integration
- HTTP server serving the widget script
- WebSocket server for real-time browser communication
- Browser widget with element selection and feedback submission
- Screenshot capture (enhanced with html2canvas if available)
- Console log capture (logs, warnings, errors)
- Element metadata extraction (tag, classes, ID, text content, computed styles)

#### MCP Tools

- `install_widget` - Auto-inject widget into HTML files with auto-detection of common paths
- `uninstall_widget` - Remove widget from HTML files
- `wait_for_browser_feedback` - Block until user submits single feedback
- `wait_for_multiple_feedback` - Collect multiple annotations before sending to Claude
- `get_pending_feedback` - Get already-submitted feedback without blocking
- `get_connection_status` - Check WebSocket client connections
- `request_annotation` - Broadcast prompt to connected browsers
- `get_widget_snippet` - Get manual installation script tag

#### Widget Features

- Draggable dialog panel
- Minimizable panel with +/- toggle
- Collapsible element details (collapsed by default)
- Multi-feedback mode with counter and Done button
- Window resize handling to keep panel in viewport
- Claude orange theme (#da7756)
- Connection status indicator
- Hover highlighting during element selection

### Security

- Server only listens on localhost
- Widget only connects to localhost
- No external data transmission

[0.1.0]: https://github.com/yepzdk/mcp-claude-code-browser-feedback/releases/tag/v0.1.0
