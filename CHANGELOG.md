# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.5] - 2026-04-21

### Fixed

- Fix plugin dependency resolution for ES modules — `NODE_PATH` is ignored by Node.js ESM, so the `SessionStart` hook now symlinks `node_modules` into the plugin root instead

## [0.6.4] - 2026-04-21

### Fixed

- Install plugin dependencies via `SessionStart` hook into the plugin data directory, and resolve `html2canvas` using `createRequire` so it works when `node_modules` lives outside the plugin root

## [0.6.3] - 2026-04-21

### Fixed

- Add `mcpServers` config to `plugin.json` so the plugin correctly registers as an MCP server — the `.mcp.json` removal in v0.6.2 accidentally broke MCP server discovery

## [0.6.2] - 2026-04-21

### Removed

- Remove `.mcp.json` dev override from the published package — the plugin now uses its default launch mechanism (npx) instead of a hardcoded `node src/server.js`

## [0.6.1] - 2026-04-21

### Fixed

- Handle EPERM error as port-in-use when binding HTTP server, allowing proxy mode to work on macOS

## [0.6.0] - 2026-04-20

### Added

- Session isolation for multi-project support — each Claude Code session gets a unique session ID, preventing feedback from one project appearing in another project's widget
- New `/sessions` HTTP endpoint listing all active sessions with project metadata
- Session registry with `/register-session` and `/unregister-session` endpoints for proxy instances
- Browser extension auto-matches tabs to sessions based on detected project URL; shows a session picker when multiple sessions are ambiguous
- Session ID included in widget URL, WebSocket connections, and all feedback messages for full isolation
- Test infrastructure with Vitest — unit tests for utils and integration tests for HTTP endpoints
- GitHub Actions CI workflow running tests on Node 22 LTS
- WebSocket session routing tests verifying correct session bucket assignment and duplicate-tab warnings
- Duplicate-tab warning — widget notifies when connecting to a session that already has clients
- Extension popup shows active session name with a "Change" button to switch sessions
- Extension popup only shows connection details when widget is enabled — clean two-state UX
- Extension badge shows "OFF" in gray when widget is inactive

### Changed

- Removed unused `sessionId` fields from widget WebSocket messages (session is derived from the WebSocket connection URL)
- Extracted `parseJsonBody()` helper to reduce code duplication in HTTP POST endpoints
- Added UUID format validation on `/register-session` and `/unregister-session` endpoints
- Extracted `isValidSessionId`, `getPendingSummary`, `detectProjectUrl`, and `formatFeedbackAsContent` into `src/utils.js` for testability

### Fixed

- WebSocket connections without a `?session=` param no longer silently land in a `'default'` bucket — they are placed in `'unmatched'` with a warning, preventing phantom "no clients connected" errors
- `get_connection_status` in proxy mode now returns session-scoped client count instead of misleading global total
- Extension popup now shows session-scoped client count instead of global count across all sessions
- Extension popup shows just "Connected" when no session is active (no misleading client counts)
- Duplicate-tab warning moved from widget toast to inline text in extension popup
- Demo page no longer embeds widget script — use the browser extension to inject the widget for testing
- Stale MCP processes no longer block port binding — on EADDRINUSE, the server now health-checks the existing process and retries up to 3 times before falling back to proxy mode

## [0.5.0] - 2026-04-13

### Added

- Blue highlight indicator on selected element while feedback panel is open, so users can see which element they picked

### Fixed

- Keyboard events (arrow keys, typing, etc.) no longer leak to the host page when the feedback panel, annotation mode, or queue panel is active
- Shift+C keyboard shortcut no longer fires while typing in the feedback textarea (Shadow DOM focus detection)
- html2canvas loading in browser extension context - uses fetch instead of script injection to avoid CSP restrictions

- CSS isolation wrapper (`.cf-root`) inside Shadow DOM - uses `all: initial` to fully break CSS inheritance from host page, preventing dark-themed sites from affecting widget appearance
- Shadow DOM isolation for widget - host page CSS no longer leaks into the widget UI
- Tooltip selector truncation - long CSS selectors in hover tooltip are now truncated to 2 levels with `... >` prefix
- Improved tooltip positioning - tooltip moves below element when it would go above the viewport, and is clamped horizontally
- Full DOM path selector (`fullSelector`) included in feedback element metadata for AI agents
- Offline annotation support - widget now works without a server connection, storing feedback locally
- Export to Markdown - download all pending feedback as a structured `.md` file from the queue panel
- Export to GitHub Issue - open a pre-filled GitHub issue with feedback content (URL-based, no token needed)
- GitHub repository config stored in `localStorage` for quick re-use
- Claude Code plugin wrapper (`.claude-plugin/plugin.json` + `.mcp.json`) for direct installation via `claude plugin add`
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

[0.6.5]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.6.0...v0.6.1
[0.5.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.4.4...v0.5.0
[0.4.1]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/releases/tag/v0.3.0
[0.2.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/releases/tag/v0.2.0
[0.1.0]: https://github.com/itk-dev/mcp-claude-code-browser-feedback/releases/tag/v0.1.0
