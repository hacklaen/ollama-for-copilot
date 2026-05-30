# Copilot Instructions

## Language
All text must be written in **English** — without exception:
- Source code comments
- Commit messages
- README, CHANGELOG, and all other documentation
- Variable names, function names, and type names (no abbreviations from other languages)
- VS Code UI strings (command titles, setting descriptions, status bar labels, notification messages)

## Project Overview
**Ollama for Copilot** is a VS Code extension (TypeScript) that manages the Ollama server lifecycle so that local LLM models are available as GitHub Copilot chat participants via the VS Code BYOM (Bring Your Own Model) feature.

- Publisher: `hacklaen`
- Extension ID: `hacklaen.ollama-for-copilot`
- Min VS Code version: `^1.104.0`
- Entry point: `src/extension.ts` → compiled to `out/extension.js`

## Code Conventions
- TypeScript strict mode (`"strict": true` in `tsconfig.json`)
- No implicit `any` — always annotate callback parameters explicitly
- Use discriminated union `ServerState` for all server state tracking; never use ad-hoc string flags
- `cfg()` must be called fresh each time a setting is needed (VS Code settings can change at runtime)
- All async operations that modify server state must check and set `busy` to prevent races
- Error messages shown to the user must include an actionable suggestion where possible

## Extension Behaviour
- The extension activates on `onStartupFinished`; it must never block VS Code startup
- `stopServer()` is called in `deactivate()` — keep it side-effect-free and synchronous-safe
- The `modelsDir` setting maps to the `OLLAMA_MODELS` environment variable passed to the spawned process

## Build & Release
- Build: `npm run compile`
- Package: `npm run package` → produces `ollama-for-copilot-<version>.vsix`
- Version bumps go in `package.json`, `README.md` (badge), and `CHANGELOG.md` simultaneously
- Commit message format: `v<version> — <short description>` (e.g. `v1.0.0 — first stable release`)
