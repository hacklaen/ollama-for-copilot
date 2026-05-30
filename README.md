# Ollama for Copilot

**Ollama on demand – local, private, fully integrated into GitHub Copilot.**

Ollama for Copilot is the first VS Code extension that runs Ollama *only when VS Code needs it*: the local AI server starts automatically when VS Code opens and shuts down cleanly when VS Code closes. No manual starting, no background resource consumption when you are not coding.

Thanks to VS Code's native BYOM (Bring Your Own Model) support introduced in version 1.100+, your local models appear directly in the Copilot chat model picker — right alongside Claude, GPT-4o and Gemini, completely offline and without any API key.

## Highlights

- **On-demand lifecycle** — Ollama runs only while VS Code is open; no background processes after closing
- **Full Copilot integration** — local models appear in the chat model picker (Ask & Agent mode) just like built-in models
- **BYOM without the cloud** — no API keys, no telemetry, all data stays on your machine
- **Flexible model path** — models can be stored on an external drive or any custom directory via `OLLAMA_MODELS`
- **Statusbar control** — start, stop, restart and status at a single click

---

## Prerequisites

### Install Ollama

**macOS**
```bash
# Homebrew (recommended)
brew install ollama

# Or download directly:
# https://ollama.com/download/mac  →  open the .dmg and drag Ollama to Applications
```

**Windows**
```
https://ollama.com/download/windows  →  download and run OllamaSetup.exe
```
After installation, `ollama` must be available in your PATH (the Windows installer handles this automatically). Verify:
```bash
ollama --version
```

### VS Code version
Requires **VS Code 1.104** or later (May 2025). The built-in Ollama provider that enables BYOM is available from this version onwards.

---

## Quick Start

1. Install the extension (VSIX or from the Marketplace)
2. Open VS Code → Ollama starts automatically (status bar shows `⊙ Ollama`)
3. Pull one or more models (see below)
4. Open the Command Palette → **Chat: Manage Language Models** → the Ollama provider appears automatically
5. Select a local model in the chat picker and start coding

---

## Managing Models

Models must report the `tools` capability to be selectable in the VS Code chat picker. Pure completion models (without `tools`) are invisible in the picker and can only be used via `ollama run <model>` in the terminal.

### Download a model

```bash
ollama pull qwen2.5-coder:7b
```

### Delete a model

```bash
ollama rm qwen2.5-coder:7b
```

### List installed models

```bash
ollama list
```

### Recommended coding models (as of May 2026)

| Model | Size | Capabilities | Strengths |
|---|---|---|---|
| `qwen2.5-coder:7b` | 4.7 GB | completion, **tools**, insert | Best 7B coding model, agent-ready |
| `qwen3:8b` | 5.2 GB | completion, **tools**, thinking | Strong all-rounder + reasoning, agent-ready |
| `llama3.1:8b` | 4.9 GB | completion, **tools** | Solid general-purpose alternative |
| `qwen2.5-coder:32b` | 19 GB | completion, **tools**, insert | Best local coding quality (high RAM) |
| `deepseek-coder-v2:16b` | 8.9 GB | completion, **tools** | Strong code reasoning |
| `qwen2.5:3b` | 1.9 GB | completion, **tools** | Very fast, low hardware requirements |

> **Note:** Models without the `tools` capability (e.g. `deepseek-coder:6.7b`, `nomic-embed-text`) are not selectable in the Copilot chat picker. They can still be used via `ollama run <model>` in the terminal.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `ollamaLifecycle.ollamaPath` | `ollama` | Full path to the ollama binary if it is not in your PATH |
| `ollamaLifecycle.host` | `127.0.0.1` | Host used for the reachability probe |
| `ollamaLifecycle.port` | `11434` | Port of the Ollama server |
| `ollamaLifecycle.autoStart` | `true` | Automatically start Ollama when VS Code opens |
| `ollamaLifecycle.stopOnExit` | `true` | Stop the server when VS Code closes (only if this extension started it) |
| `ollamaLifecycle.modelsDir` | *(empty)* | Path to the model directory — sets `OLLAMA_MODELS` on start. Empty = Ollama default (`~/.ollama/models`). Useful for external drives, e.g. `/Volumes/Ext/ollama` |
| `ollamaLifecycle.suppressSetupHint` | `false` | Suppress the one-time provider setup hint |

### Storing models on an external drive

```jsonc
// settings.json
{
  "ollamaLifecycle.modelsDir": "/Volumes/Ext/ollama"    // macOS
  // "ollamaLifecycle.modelsDir": "D:\\ollama\\models"  // Windows
}
```

Ollama will store all model blobs and manifests in this directory. Models already downloaded to the default path are not moved automatically.

> **Note for external volumes:** The `ollama` binary itself must reside on a local filesystem (ExFAT/FAT32 volumes do not support the executable permission bit on macOS). Only the model files can live on the external drive.

---

## Status Bar

The icon on the left side of the status bar shows the current state:

| Icon | Meaning |
|---|---|
| `⟳ Ollama` (spinning) | Server is starting or stopping |
| `⊙ Ollama` | Server running (started by this extension) |
| `⊡ Ollama` | Server running (started externally) |
| `■ Ollama` | Server stopped — click to start |
| `⚠ Ollama` | Error — hover for details |

Clicking the icon opens a quick-pick menu with Start, Stop, Restart, Status and Provider Setup.

---

## Build

```bash
npm install
npm run compile
```

Open the folder with `F5` in the Extension Development Host, or build a VSIX:

```bash
npm run package   # produces ollama-lifecycle-x.x.x.vsix
```
