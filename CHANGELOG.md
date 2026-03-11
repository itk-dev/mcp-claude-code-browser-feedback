# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Browser extension (Chrome MV3 + Firefox MV3) for widget injection without modifying project files
  - Toggle widget on/off per tab via extension popup
  - Connection status indicator showing server reachability
  - Configurable server URL (default: `http://localhost:9877`)
  - Badge indicator ("ON" in green) on active tabs
  - Auto-reinjects widget on page navigation when active
- `setup_extension` MCP tool to help install the browser extension (opens folder + instructions)
- `destroy()` method on widget (`window.__claudeFeedbackDestroy()`) for clean teardown
  - Disconnects WebSocket, stops self-healing, removes DOM elements, restores console
- `port` field in `/status` JSON response
- Extension tip in `install_widget` and `get_widget_snippet` tool responses

## [0.4.1] - 2026-01-24

### Fixed

- Fix orphaned MCP server processes remaining in background after Claude Desktop/Code exits
- Server now gracefully shuts down when stdin closes (MCP client disconnect) or receives SIGTERM/SIGINT

## [0.4.0] - 2026-01-24

### Added

- View pending annotations from browser widget
  - Pending count badge on main button (red circle showing number of items)
  - Collapsible queue panel showing pending items with selector, description preview, and relative timestamp
  - Delete individual pending items directly from widget
  - Real-time updates via WebSocket when feedback is added/removed/cleared
- `preview_pending_feedback` MCP tool to view pending feedback without clearing the queue
- `delete_pending_feedback` MCP tool to remove specific feedback items by ID
- `GET /pending-summary` HTTP endpoint for lightweight status polling
- `DELETE /feedback/:id` HTTP endpoint to remove specific items

## [0.3.1] - 2026-01-24

### Fixed

- Fix hostname wildcard pattern conversion to valid regex (e.g., `*.local.*` now correctly matches `app.local.itkdev.dk`)
- Fix multi-instance connection issues when multiple Claude Code sessions are running - MCP tools now proxy requests via HTTP to the running server instance

### Added

- Add CLAUDE.md with project documentation

## [0.3.0] - 2026-01-24

### Added

- `open_in_browser` tool to open project URL in default browser with auto-detection from config files (.env, docker-compose.yml, etc.)
- `allowed_hostnames` parameter for `install_widget` to support custom development domains (e.g., `*.local.itkdev.dk`)

### Fixed

- Fix widget to support multiple feedback submissions in a single session

## [0.2.0] - 2026-01-17

### Added

- Keyboard shortcuts for faster workflow
  - `Cmd/Ctrl+Enter` to send feedback from description textarea
  - `Shift+C` global shortcut to open annotation mode (when not in input fields)
- Visual shortcut hints on buttons (platform-aware: shows ⌘↵ on Mac, Ctrl+↵ on Windows/Linux)
- Shortcut hint on main button only shows when connected to server

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

[0.4.1]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/releases/tag/v0.3.0
[0.2.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/releases/tag/v0.2.0
[0.1.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/releases/tag/v0.1.0
