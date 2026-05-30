# Changelog

## 0.1.1

- Added `ollamaLifecycle.modelsDir` setting: sets `OLLAMA_MODELS` env var on server start, enabling model storage on external drives
- Improved error messages for ENOENT (binary not found) and EACCES (no execute permission on ExFAT volumes)
- Source code fully documented in English
- README rewritten with installation guide, model management instructions and recommended model table

## 0.1.0

- Initial release: lifecycle management for local Ollama server with status bar controls
