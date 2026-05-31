# Changelog

## 1.1.0 — 2026-05-31

### Improved startup diagnostics and error recovery

- **Pre-flight check for `modelsDir`**: the extension now verifies that the configured `OLLAMA_MODELS` path is accessible *before* spawning Ollama. An unreadable path (missing directory, wrong permissions) now produces an immediate, actionable error instead of a silent 10-second timeout.
- **macOS TCC detection**: when VS Code lacks Full Disk Access for an external volume, the extension shows a notification with an **Open Privacy Settings** button that navigates directly to the relevant System Preferences pane. macOS silently revokes this grant after VS Code updates or reinstalls — a common source of unexpected failures.
- **Improved detection of already-running Ollama**: the pre-spawn probe now retries three times (with a 1 s timeout each) to reliably catch Ollama running as a system daemon or started in another VS Code window.
- **Pre-spawn port conflict check**: if the configured port is already bound by a non-Ollama process, the extension now detects this before spawning and shows a targeted message instead of letting Ollama exit with a cryptic code 1.
- **Race-condition recovery**: if two VS Code windows open simultaneously, the second window's spawn attempt may fail immediately with a port conflict. The extension re-probes after an early exit; if Ollama is now reachable, the state transitions to `external-running` instead of showing a spurious error.
- **Stderr surfaced on failure**: Ollama's stderr output is buffered and promoted to ERROR level in the Output channel when the process exits unexpectedly. The first stderr line is also included in the status bar tooltip and the notification toast.
- **Port-conflict pattern matching**: stderr patterns (`address already in use`, `bind: address`) are matched independently of the exit code, so port conflicts are correctly diagnosed even when Ollama exits with an unusual code.


- First stable public release
- Renamed to **Ollama for Copilot**
- Publisher ID: `hacklaen`
- Added `icon`, `galleryBanner`, `repository` fields for VS Code Marketplace
- Full source code documentation in English

## 0.1.1

- Added `ollamaLifecycle.modelsDir` setting: sets `OLLAMA_MODELS` env var on server start, enabling model storage on external drives
- Improved error messages for ENOENT (binary not found) and EACCES (no execute permission on ExFAT volumes)
- Source code fully documented in English
- README rewritten with installation guide, model management instructions and recommended model table

## 0.1.0

- Initial release: lifecycle management for local Ollama server with status bar controls
