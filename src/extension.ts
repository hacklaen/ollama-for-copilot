/**
 * extension.ts — Ollama for Copilot
 *
 * This extension manages the lifecycle of a local Ollama server process so that
 * VS Code users do not have to start or stop it manually. Key design decisions:
 *
 *  1. PROCESS OWNERSHIP: The extension distinguishes between a server it started
 *     itself ("owned") and one that was already running when VS Code opened
 *     ("external"). Only the owned process is stopped on exit (respecting
 *     stopOnExit). This prevents accidentally killing a server started by the
 *     user for other purposes.
 *
 *  2. STATE MACHINE: A discriminated union (ServerState) models all possible
 *     states. Every transition goes through setState() which simultaneously
 *     updates the log and the status bar, keeping UI and logic in sync.
 *
 *  3. BUSY GUARD: A simple boolean flag prevents concurrent start/stop
 *     operations that could race against each other (e.g. the user clicking
 *     restart while a stop is in progress).
 *
 *  4. NO OWN LANGUAGE MODEL PROVIDER: This extension deliberately does NOT
 *     register a vscode.lm provider. VS Code 1.100+ ships a built-in Ollama
 *     provider that handles model discovery and proxying to the REST API. This
 *     extension's only job is to keep the server process alive.
 */

import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';

/**
 * All possible states of the managed Ollama server.
 *
 * Using a discriminated union means TypeScript can enforce exhaustive handling
 * in switch/case blocks and prevents invalid state combinations (e.g. having
 * both an error message and running at the same time).
 */
type ServerState =
    | { kind: 'unknown' }           // Initial state before the first probe
    | { kind: 'stopped' }           // No server reachable, no owned process
    | { kind: 'owned-running' }     // Server reachable, this extension started it
    | { kind: 'external-running' }  // Server reachable, started by something else
    | { kind: 'starting' }          // spawn() called, waiting for HTTP readiness
    | { kind: 'stopping' }          // SIGTERM sent, waiting for process exit
    | { kind: 'error'; message: string }; // Unrecoverable error (bad binary, port conflict …)

// Module-level singletons — intentionally not class-based to keep the code flat
// and easy to follow for contributors unfamiliar with VS Code extension patterns.
let output: vscode.LogOutputChannel;    // Structured log visible under Output > Ollama for Copilot
let statusBar: vscode.StatusBarItem;    // Item on the left side of the VS Code status bar
let ownedProcess: ChildProcess | undefined; // The child process we spawned, if any
let state: ServerState = { kind: 'unknown' };
let busy = false; // Prevents concurrent start/stop calls (see BUSY GUARD above)
/**
 * A synchronous 'exit' handler registered on the Node.js process.
 * VS Code does not guarantee that deactivate() is awaited when the window is
 * force-closed, so we register this as a belt-and-suspenders measure to avoid
 * leaving orphaned ollama processes behind.
 */
let exitHandler: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Provider Setup
// ---------------------------------------------------------------------------

/**
 * Opens the VS Code UI for managing language model providers so the user can
 * add the Ollama provider and see their local models in the chat picker.
 *
 * WHY THE FALLBACK CHAIN:
 * VS Code and GitHub Copilot have renamed / reorganised this command across
 * several releases (1.100 → 1.104+). There is no single stable command ID.
 * We try the known candidates newest-first and fall back to a manual instruction
 * with a Command Palette shortcut if none of them is registered.
 */
async function openProviderSetup() {
    // Open the Chat view first. Some command IDs silently do nothing unless a
    // chat widget is already visible and focused.
    try {
        await vscode.commands.executeCommand('workbench.action.chat.open');
    } catch (e) {
        output.debug(`Opening chat view failed: ${(e as Error).message}`);
    }

    // Candidates ordered newest → oldest. We check whether each command is
    // actually registered before calling it to avoid noisy error messages in
    // the VS Code developer console.
    // NOTE: 'github.copilot.chat.manageLMProviders' intentionally excluded —
    // in some Copilot builds it opens the Settings UI instead of the model
    // picker, which confuses users.
    const candidates = [
        'workbench.action.chat.manageLanguageModels', // VS Code 1.104+
        'workbench.action.chat.manageModelProviders', // VS Code 1.100–1.103
        'github.copilot.chat.byok.manageModels',      // Copilot pre-built-in era
    ];
    const allCommands = new Set(await vscode.commands.getCommands(true));
    for (const cmd of candidates) {
        if (!allCommands.has(cmd)) {
            output.debug(`Command not registered: ${cmd}`);
            continue;
        }
        try {
            output.info(`Opening Language Models editor via "${cmd}"`);
            await vscode.commands.executeCommand(cmd);
            return; // Success — stop trying further candidates
        } catch (e) {
            output.warn(`Command "${cmd}" failed: ${(e as Error).message}`);
        }
    }

    // Nothing worked — show a helpful message with actionable buttons.
    output.warn('No known Language Models command available — showing manual instructions.');
    const sel = await vscode.window.showInformationMessage(
        'The "Manage Language Models" dialog could not be opened automatically. ' +
        'Open the Command Palette and run "Chat: Manage Language Models", ' +
        'then choose "Add Models" and select the Ollama provider.',
        'Open Command Palette',
        'Open Docs'
    );
    if (sel === 'Open Command Palette') {
        await vscode.commands.executeCommand(
            'workbench.action.quickOpen',
            '>Chat: Manage Language Models'
        );
    } else if (sel === 'Open Docs') {
        vscode.env.openExternal(
            vscode.Uri.parse('https://code.visualstudio.com/docs/copilot/customization/language-models')
        );
    }
}

// ---------------------------------------------------------------------------
// Configuration helper
// ---------------------------------------------------------------------------

/**
 * Reads the current extension settings and returns them as a typed object.
 *
 * Called fresh on every use rather than cached, so changes to settings.json
 * take effect immediately without requiring an extension restart.
 */
function cfg() {
    const c = vscode.workspace.getConfiguration('ollamaLifecycle');
    return {
        ollamaPath:         c.get<string>('ollamaPath', 'ollama'),
        port:               c.get<number>('port', 11434),
        host:               c.get<string>('host', '127.0.0.1'),
        autoStart:          c.get<boolean>('autoStart', true),
        stopOnExit:         c.get<boolean>('stopOnExit', true),
        suppressSetupHint:  c.get<boolean>('suppressSetupHint', false),
        /**
         * When non-empty this path is passed as the OLLAMA_MODELS environment
         * variable to `ollama serve`. This lets users keep large model blobs on
         * an external drive without changing their system-wide environment.
         */
        modelsDir:          c.get<string>('modelsDir', ''),
    };
}

// ---------------------------------------------------------------------------
// HTTP probes
// ---------------------------------------------------------------------------

/**
 * Performs a lightweight HTTP GET to /api/version to check whether the Ollama
 * server is reachable. Uses Node's built-in `http` module (no external deps).
 *
 * @param timeoutMs  Maximum wait time in milliseconds. Keep this short (250 ms)
 *                   when called in a polling loop during startup.
 */
function probeVersion(timeoutMs = 250): Promise<{ ok: boolean; body?: string; error?: string }> {
    const { host, port } = cfg();
    return new Promise((resolve) => {
        const req = http.get(
            { host, port, path: '/api/version', timeout: timeoutMs },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () =>
                    resolve({ ok: res.statusCode === 200, body })
                );
            }
        );
        // 'timeout' event fires after the socket idle timeout — destroy to
        // prevent the socket from hanging open.
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, error: 'timeout' });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
}

/**
 * Fetches the full /api/tags response (JSON list of installed models).
 * Used only for the "Show models" status bar menu action — not on the hot path.
 */
function fetchTags(): Promise<string> {    const { host, port } = cfg();
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host, port, path: '/api/tags', timeout: 2000 },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve(body));
            }
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.on('error', reject);
    });
}

/**
 * Checks whether the configured TCP port is currently bound by *any* process
 * (not necessarily Ollama). Used in two situations:
 *
 *  1. Pre-flight check in startServer(): if the port is in use before we even
 *     spawn, the child would exit immediately with "address already in use".
 *     We detect this upfront and skip the spawn entirely.
 *
 *  2. Post-exit diagnosis: if ollama exits quickly and its stderr is ambiguous,
 *     a positive isPortInUse() confirms a port conflict as the root cause.
 *
 * The method works by attempting to create a TCP server and bind it to the
 * same host:port. If that fails with EADDRINUSE, something else holds the
 * port. We close the temporary server immediately on success so no real port
 * is occupied.
 *
 * NOTE: There is an inherent race between this check and the spawn — another
 * process could grab the port in the milliseconds between our check and spawn.
 * That race is handled in the early-exit recovery path (see startServer).
 */
function isPortInUse(): Promise<boolean> {
    const { host, port } = cfg();
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', (err: NodeJS.ErrnoException) => {
            resolve(err.code === 'EADDRINUSE');
        });
        tester.once('listening', () => {
            tester.close(() => resolve(false));
        });
        tester.listen(port, host);
    });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Updates the status bar to reflect the current state.
 * Uses codicons ($(icon-id) syntax) for the leading icon.
 *
 * The warning background color is applied for the 'error' state so the status
 * bar item draws the user's attention without a modal dialog.
 */
function updateStatusBar() {
    let icon = '$(question)';
    let tooltip = 'Ollama for Copilot';
    let warning = false;
    switch (state.kind) {
        case 'owned-running':
            icon = '$(vm-running)';
            tooltip = 'Ollama running (started by this extension)';
            break;
        case 'external-running':
            icon = '$(vm-connect)';
            tooltip = 'Ollama running (externally started)';
            break;
        case 'stopped':
            icon = '$(debug-stop)';
            tooltip = 'Ollama stopped — click to start';
            break;
        case 'starting':
            icon = '$(sync~spin)';
            tooltip = 'Starting Ollama …';
            break;
        case 'stopping':
            icon = '$(sync~spin)';
            tooltip = 'Stopping Ollama …';
            break;
        case 'error':
            icon = '$(warning)';
            tooltip = state.message;
            warning = true;
            break;
        case 'unknown':
            icon = '$(sync~spin)';
            tooltip = 'Checking Ollama status …';
            break;
    }
    statusBar.text = `${icon} Ollama`;
    statusBar.tooltip = tooltip;
    // ThemeColor keeps the warning color in sync with the user's color theme.
    statusBar.backgroundColor = warning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
}

/**
 * Single entry point for all state transitions.
 * Centralising this ensures the log and status bar are always updated together.
 */
function setState(next: ServerState) {
    state = next;
    output.info(`State → ${next.kind}${next.kind === 'error' ? `: ${next.message}` : ''}`);
    updateStatusBar();
}

/**
 * Polls /api/version until the server responds with 200 or the timeout expires.
 *
 * Called after spawn() because `ollama serve` takes a moment to bind its port.
 * We poll rather than use a fixed sleep so startup feels snappy on fast machines.
 *
 * @param maxMs      Total budget in milliseconds (default 10 s).
 * @param intervalMs Pause between probes (default 250 ms).
 * @returns true if the server became reachable within the budget.
 */
async function waitUntilReady(
    maxMs = 10_000,
    intervalMs = 250,
    shouldAbort?: () => boolean,
): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        if (shouldAbort?.()) return false;
        const r = await probeVersion();
        if (r.ok) return true;
        await new Promise((res) => setTimeout(res, intervalMs));
    }
    return false;
}

/**
 * Returns the first non-empty line of a multi-line string (trimmed).
 * Used to extract the key failure reason from Ollama's multi-line stderr so
 * that the notification toast stays concise. The full stderr is always written
 * to the Output channel via output.error() before this is called.
 */
function firstLine(s: string): string {
    for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t) return t;
    }
    return s.trim();
}

/**
 * Shows a macOS-specific notification explaining how to grant Full Disk
 * Access to VS Code in System Preferences, and opens the relevant pane
 * directly when the user clicks the action button.
 *
 * BACKGROUND — macOS Transparency, Consent and Control (TCC):
 * Since macOS Catalina (10.15), every app that reads files outside of its
 * sandbox must hold an explicit TCC grant for the relevant category:
 *  - "Removable Volumes"  — USB sticks, external SSDs mounted via Finder
 *  - "Full Disk Access"   — supersedes all other storage grants
 *
 * VS Code holds this grant after the user approves it once, but macOS
 * silently REVOKES the grant when:
 *  - VS Code is updated (new binary, new code signature)
 *  - VS Code is moved to a different path (e.g. reinstalled)
 *  - The user reinstalls or re-downloads the VSIX
 *  - A major macOS update changes TCC policy
 *
 * This function is a no-op on non-macOS platforms (Windows / Linux have no
 * equivalent TCC mechanism and produce plain EACCES errors instead).
 *
 * @param pathHint  Human-readable path to include in the notification text
 *                  so the user knows which directory triggered the error.
 */
function showMacTccHint(pathHint: string) {
    if (process.platform !== 'darwin') return;
    const msg =
        `macOS denied access to "${pathHint}". This is a TCC permission issue — ` +
        `VS Code needs Full Disk Access (or Removable Volumes access) to read ` +
        `files on external drives. macOS sometimes revokes this after an update.`;
    output.error(msg);
    vscode.window
        .showErrorMessage(
            msg,
            'Open Privacy Settings',
            'Show Logs'
        )
        .then((sel) => {
            if (sel === 'Open Privacy Settings') {
                vscode.env.openExternal(
                    vscode.Uri.parse(
                        'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
                    )
                );
            } else if (sel === 'Show Logs') {
                output.show(true);
            }
        });
}

/**
 * Synchronously checks whether the configured modelsDir path is readable by
 * the current process. Returns a human-readable problem string on failure, or
 * undefined if the path is accessible.
 *
 * WHY SYNC:
 * This runs in startServer() which is already async and awaited by the caller.
 * Using accessSync avoids creating an additional promise chain while keeping
 * the code easy to reason about. The call completes in microseconds for any
 * local or remote filesystem that is currently accessible.
 *
 * WHY R_OK | X_OK:
 * Ollama's first action on startup is to enumerate the blobs sub-directory.
 * R_OK (read) allows open(), X_OK (execute/search) allows readdir() on a
 * directory. W_OK is intentionally omitted — write access is only required
 * when pulling new models, not on startup; deferring that error keeps the
 * check focused on boot-time failures.
 *
 * RETURN VALUES:
 *  - undefined          → path is accessible, proceed with spawn
 *  - 'EPERM'            → sentinel: caller must call showMacTccHint()
 *  - any other string   → human-readable error message for the notification
 */
function checkModelsDirAccess(modelsDir: string): string | undefined {
    if (!modelsDir) return undefined;
    try {
        // R_OK is enough for the readdir Ollama does on startup; lack of W_OK
        // would only fail later when pulling a model, which is fine to defer.
        fs.accessSync(modelsDir, fs.constants.R_OK | fs.constants.X_OK);
        return undefined;
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            return `OLLAMA_MODELS path does not exist: ${modelsDir}`;
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            // Return a sentinel instead of a full message: the caller knows
            // to invoke showMacTccHint() which produces a platform-aware,
            // actionable notification with a direct link to System Preferences.
            return `EPERM`;
        }
        return `Cannot access OLLAMA_MODELS (${err.code ?? 'unknown'}): ${modelsDir}`;
    }
}

// ---------------------------------------------------------------------------
// Server control
// ---------------------------------------------------------------------------

/**
 * Starts `ollama serve` as a child process.
 *
 * Guards:
 * - Returns immediately if `busy` is true (another operation is in progress).
 * - Returns immediately if `ownedProcess` already exists (avoid double-spawn).
 * - Returns immediately if the server is already reachable (marks as external).
 *
 * Error handling covers two common failure modes in addition to the generic case:
 * - ENOENT: binary not found → user prompt to install Ollama.
 * - EACCES: no execute permission → common when ollamaPath points to an ExFAT
 *   volume which doesn't support the executable bit on macOS.
 */
async function startServer(): Promise<void> {
    if (busy) return;
    if (ownedProcess) {
        output.info('Start skipped: owned process already exists.');
        return;
    }

    // ── Pre-flight 1: detect already-running Ollama ──────────────────────
    //
    // Common scenarios where Ollama is already up before we try to spawn:
    //  a) The ollama.com installer registers a LaunchAgent (macOS) or a
    //     Windows Service that starts automatically at login.
    //  b) The user ran `ollama serve` in a terminal before opening VS Code.
    //  c) Another VS Code window has its own extension host that started
    //     Ollama moments earlier (both windows activate on startup).
    //
    // We probe three times with a 1 s HTTP timeout and 200 ms gaps to
    // tolerate a daemon that is still in the middle of its own startup
    // (e.g. scenario a after a fresh login).
    for (let attempt = 0; attempt < 3; attempt++) {
        const probe = await probeVersion(1000);
        if (probe.ok) {
            output.info('Detected an already running Ollama server — not starting our own.');
            setState({ kind: 'external-running' });
            return;
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 200));
    }

    // ── Pre-flight 2: detect port occupied by a non-Ollama process ────────
    //
    // If /api/version did not respond but the TCP port is still bound, a
    // different process (e.g. a web server, a second VS Code window that is
    // still in the middle of spawning, or a leftover zombie process) holds
    // the port. Spawning in this case is pointless — ollama would exit with
    // "address already in use" (code 1) within milliseconds. We detect this
    // upfront and show a targeted, actionable message instead.
    if (await isPortInUse()) {
        const { host, port } = cfg();
        const msg =
            `Port ${host}:${port} is already in use by another process, ` +
            `but it does not respond to /api/version. ` +
            `Change "Ollama for Copilot: Port" or stop the conflicting process.`;
        output.error(msg);
        vscode.window
            .showErrorMessage(msg, 'Open Settings')
            .then((sel) => {
                if (sel === 'Open Settings') {
                    vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'ollamaLifecycle.port'
                    );
                }
            });
        setState({ kind: 'error', message: `Port ${port} in use` });
        return;
    }

    busy = true;
    setState({ kind: 'starting' });
    const { ollamaPath, modelsDir } = cfg();

    // ── Pre-flight 3: verify modelsDir is readable ───────────────────────
    //
    // When ollamaLifecycle.modelsDir is set, the path is passed as
    // OLLAMA_MODELS to the child process. Ollama's very first action is to
    // open that directory; if it cannot, it exits with code 1 and a single
    // stderr line — but only AFTER we have already waited up to 250 ms per
    // poll cycle × N iterations. By checking accessibility beforehand we:
    //  - avoid the 10 s wait-until-ready timeout
    //  - distinguish the root cause (missing dir vs. TCC permission vs.
    //    genuine port conflict) and show the correct recovery action
    //
    // The most common trigger on macOS: the user previously granted VS Code
    // Full Disk Access, then VS Code was updated or reinstalled and macOS
    // silently revoked the TCC grant.
    if (modelsDir) {
        const problem = checkModelsDirAccess(modelsDir);
        if (problem === 'EPERM') {
            showMacTccHint(modelsDir);
            setState({ kind: 'error', message: `No permission to read ${modelsDir}` });
            busy = false;
            return;
        }
        if (problem) {
            output.error(problem);
            vscode.window
                .showErrorMessage(problem, 'Open Settings')
                .then((sel) => {
                    if (sel === 'Open Settings') {
                        vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'ollamaLifecycle.modelsDir'
                        );
                    }
                });
            setState({ kind: 'error', message: problem });
            busy = false;
            return;
        }
    }

    // Build the environment for the child process. We inherit the parent
    // environment and optionally override OLLAMA_MODELS so the user can keep
    // model blobs on a separate drive without touching their shell profile.
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (modelsDir) {
        spawnEnv['OLLAMA_MODELS'] = modelsDir;
        output.info(`OLLAMA_MODELS=${modelsDir}`);
    }

    try {
        let spawnFailed = false;
        // Buffer recent stderr so we can surface it to the user if the process
        // exits with a non-zero code (e.g. port in use, bad OLLAMA_MODELS path).
        let stderrBuffer = '';
        let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

        const child = spawn(ollamaPath, ['serve'], {
            stdio: ['ignore', 'pipe', 'pipe'], // stdin closed; stdout/stderr piped for logging
            detached: false,  // Keep the child attached so it is killed with VS Code on a crash
            env: spawnEnv,
        });

        // ── Spawn-level errors ────────────────────────────────────────────
        // The 'error' event fires synchronously before any 'exit' event when
        // spawn itself fails (binary not found, permission denied, etc.).
        // These are OS-level errors, distinct from Ollama reporting an error
        // at runtime (which surfaces via exit code + stderr instead).
        child.on('error', (err: NodeJS.ErrnoException) => {
            spawnFailed = true;
            ownedProcess = undefined;
            if (err.code === 'ENOENT') {
                // Binary not in PATH and ollamaPath setting is wrong or default.
                output.error(`ollama not found: ${ollamaPath}`);
                vscode.window
                    .showWarningMessage(
                        'Ollama binary not found. Please install Ollama or correct the path in the extension settings.',
                        'Install Ollama'
                    )
                    .then((sel) => {
                        if (sel === 'Install Ollama') {
                            vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
                        }
                    });
                setState({ kind: 'error', message: 'ollama not found' });
            } else if (err.code === 'EACCES') {
                // The binary exists but the OS refuses to execute it. This happens
                // when ollamaPath points to a file on an ExFAT/FAT32 volume (macOS)
                // or when the file simply lacks the +x bit.
                output.error(`No execute permission for: ${ollamaPath}`);
                vscode.window
                    .showWarningMessage(
                        `Ollama cannot be started: no execute permission on "${ollamaPath}".\n` +
                        'External volumes (ExFAT/FAT32) do not support the executable bit on macOS. ' +
                        'Copy the ollama binary to a local path (e.g. /usr/local/bin/ollama) ' +
                        'and update the "Ollama for Copilot: Ollama Path" setting.',
                        'Open Settings'
                    )
                    .then((sel) => {
                        if (sel === 'Open Settings') {
                            vscode.commands.executeCommand(
                                'workbench.action.openSettings',
                                'ollamaLifecycle.ollamaPath'
                            );
                        }
                    });
                setState({ kind: 'error', message: `No execute permission: ${ollamaPath}` });
            } else {
                output.error(`Spawn error: ${err.stack ?? err.message}`);
                setState({ kind: 'error', message: err.message });
            }
        });

        // ── Stdout / stderr forwarding ────────────────────────────────────
        // Both streams are forwarded to the Output channel at DEBUG level.
        // DEBUG is hidden by default in the LogOutputChannel view, so the
        // normal running noise (model loads, request logs) stays out of the
        // user's way. If something goes wrong we promote the buffered stderr
        // to ERROR level in the exit handler below.
        child.stdout?.on('data', (d) => output.debug(`[ollama] ${String(d).trimEnd()}`));
        child.stderr?.on('data', (d) => {
            const text = String(d);
            // Ring-buffer: keep the last ~4 KB of stderr. Ollama can be
            // verbose (GPU detection, model loading), but the fatal message
            // that explains an unexpected exit always appears last. 4 KB is
            // enough for dozens of lines while keeping memory use negligible.
            stderrBuffer = (stderrBuffer + text).slice(-4096);
            output.debug(`[ollama] ${text.trimEnd()}`);
        });

        // ── Exit handler ──────────────────────────────────────────────────
        // Covers two distinct cases:
        //
        //  A) Deliberate stop (state.kind === 'stopping'):
        //     Triggered by the user or deactivate(). We do NOT set earlyExit
        //     here; stopServer() handles the state transition itself.
        //
        //  B) Unexpected exit (anything else):
        //     Ollama died while we thought it should be running. We capture
        //     the exit details in `earlyExit` so that the post-spawn logic
        //     below can perform recovery (re-probe, diagnose root cause,
        //     surface the right notification) instead of misidentifying a
        //     race-condition as a hard failure.
        child.on('exit', (code, signal) => {
            output.info(`Ollama process exited (code=${code}, signal=${signal})`);
            if (ownedProcess === child) {
                ownedProcess = undefined;
                // Don't overwrite a deliberate 'stopping' transition.
                if (state.kind !== 'stopping') {
                    earlyExit = { code, signal };
                    // Promote stderr to ERROR level now that we know something
                    // went wrong. ERROR entries are always visible in the
                    // Output channel regardless of the log-level filter.
                    const tail = stderrBuffer.trim();
                    if (tail) {
                        output.error(`Ollama stderr:\n${tail}`);
                    }
                    if (code !== 0) {
                        setState({
                            kind: 'error',
                            message: `Ollama exited with code ${code}${tail ? `: ${firstLine(tail)}` : ''}`,
                        });
                    } else {
                        // Clean exit (code 0) is unusual but possible, e.g.
                        // if the user ran `ollama stop` from outside VS Code.
                        setState({ kind: 'stopped' });
                    }
                }
            }
        });

        ownedProcess = child;

        // ── Readiness poll ────────────────────────────────────────────────
        // Poll /api/version until the server responds with 200, exits
        // unexpectedly (shouldAbort fires), or we exhaust the 10 s budget.
        // Aborting immediately on early exit avoids burning the full 10 s
        // before showing the user an error notification.
        const ready = await waitUntilReady(10_000, 250, () => earlyExit !== undefined);

        if (spawnFailed) {
            // The 'error' event handler already set the error state, logged
            // the cause, and showed the appropriate notification. Nothing to do.
        } else if (earlyExit) {
            // The 'exit' handler set the error state and wrote stderr to the
            // Output channel. Now we need to decide which notification to show.
            const tail = stderrBuffer.trim();

            // ── Race-condition recovery ───────────────────────────────────
            // Window of vulnerability: our pre-flight probes ran clean, then
            // between probe and spawn another process grabbed the port (most
            // likely: a second VS Code window's extension host running in
            // parallel). Ollama then exited immediately with a port-conflict
            // error. We re-probe once with a longer timeout; if the port now
            // serves /api/version, we adopt that instance as external-running
            // instead of surfacing a spurious error to the user.
            const recheck = await probeVersion(1500);
            if (recheck.ok) {
                output.info('Ollama is reachable after exit — treating as external instance.');
                setState({ kind: 'external-running' });
                return;
            }

            // Detect Ollama's own permission errors (TCC denying access to an
            // external volume even though our pre-flight passed, e.g. because
            // a subdirectory of modelsDir is restricted).
            if (/operation not permitted|permission denied/i.test(tail)) {
                showMacTccHint(modelsDir || '(default models path)');
            } else if (
                /address already in use|bind: address|listen tcp/i.test(tail) ||
                (await isPortInUse())
            ) {
                const { port } = cfg();
                vscode.window
                    .showErrorMessage(
                        `Ollama failed to start: port ${port} is already in use ` +
                        `(another Ollama instance, daemon, or VS Code window). ` +
                        `Stop the other process or change the port in settings.`,
                        'Open Settings',
                        'Show Logs'
                    )
                    .then((sel) => {
                        if (sel === 'Open Settings') {
                            vscode.commands.executeCommand(
                                'workbench.action.openSettings',
                                'ollamaLifecycle.port'
                            );
                        } else if (sel === 'Show Logs') {
                            output.show(true);
                        }
                    });
            } else {
                const hint = tail
                    ? firstLine(tail)
                    : `Exit code ${earlyExit.code}.`;
                vscode.window
                    .showErrorMessage(
                        `Ollama failed to start: ${hint}`,
                        'Show Logs',
                        'Open Settings'
                    )
                    .then((sel) => {
                        if (sel === 'Show Logs') {
                            output.show(true);
                        } else if (sel === 'Open Settings') {
                            vscode.commands.executeCommand(
                                'workbench.action.openSettings',
                                'ollamaLifecycle'
                            );
                        }
                    });
            }
        } else if (!ready) {
            // waitUntilReady returned false but the process may still be alive
            // and just very slow. Do one final probe with a longer timeout.
            const followup = await probeVersion();
            if (followup.ok) {
                setState({ kind: 'owned-running' });
            } else {
                setState({
                    kind: 'error',
                    message: 'Ollama did not start within 10 s (port conflict?)',
                });
                output.error(`Probe error after start: ${followup.error ?? 'unknown'}`);
            }
        } else {
            setState({ kind: 'owned-running' });
        }
    } finally {
        busy = false;
    }
}

/**
 * Stops the owned Ollama process gracefully.
 *
 * Strategy:
 * 1. Send SIGTERM — allows Ollama to flush in-flight requests and close
 *    its port cleanly.
 * 2. After 3 s with no exit, send SIGKILL to ensure the process dies.
 * 3. After 6 s total, resolve anyway (SIGKILL should have worked by then;
 *    if not, the OS will clean up when VS Code itself exits).
 *
 * If there is no owned process, we re-probe to sync the displayed state
 * (the server might have been stopped externally since the last state update).
 */
async function stopServer(): Promise<void> {
    if (busy) return;
    if (!ownedProcess) {
        output.info('Stop skipped: no owned process.');
        await refreshState(); // Sync UI with reality
        return;
    }
    busy = true;
    setState({ kind: 'stopping' });
    const child = ownedProcess;
    try {
        await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };

            child.once('exit', finish);

            // Attempt graceful shutdown first.
            try {
                child.kill('SIGTERM');
            } catch (e) {
                output.error(`SIGTERM error: ${(e as Error).message}`);
            }

            // Escalate to SIGKILL if SIGTERM is ignored after 3 s.
            setTimeout(() => {
                if (!done && !child.killed) {
                    output.warn('SIGTERM unanswered — sending SIGKILL.');
                    try {
                        child.kill('SIGKILL');
                    } catch (e) {
                        output.error(`SIGKILL error: ${(e as Error).message}`);
                    }
                }
            }, 3000);

            // Hard deadline — resolve regardless after 6 s so we don't block
            // VS Code's shutdown sequence indefinitely.
            setTimeout(finish, 6000);
        });
        ownedProcess = undefined;
        setState({ kind: 'stopped' });
    } finally {
        busy = false;
    }
}

/**
 * Probes the server and updates the state to match reality.
 * Used after operations where we may have lost track of the actual state
 * (e.g. stopServer() called with no owned process, or after a crash).
 */
async function refreshState(): Promise<void> {
    const probe = await probeVersion();
    if (probe.ok) {
        // If ownedProcess is set the server is ours; otherwise it's external.
        setState(ownedProcess ? { kind: 'owned-running' } : { kind: 'external-running' });
    } else {
        if (ownedProcess) {
            // We have a child process reference but it's not responding yet —
            // treat as "still starting" rather than "stopped".
            setState({ kind: 'starting' });
        } else {
            setState({ kind: 'stopped' });
        }
    }
}

// ---------------------------------------------------------------------------
// First-run setup hint
// ---------------------------------------------------------------------------

/**
 * Shows a one-time notification guiding the user to set up the Ollama provider
 * in VS Code's language model settings.
 *
 * Skipped when:
 * - suppressSetupHint is true (user opted out permanently via settings).
 * - globalState 'setupCompleted' is true (set when we detect ≥1 Ollama model
 *   is already configured — the user has been through the setup before).
 *
 * The 'Do not ask again' button writes suppressSetupHint = true to global
 * settings so the hint doesn't resurface after a VS Code restart.
 */
async function maybeShowSetupHint(context: vscode.ExtensionContext) {
    const { suppressSetupHint } = cfg();
    if (suppressSetupHint) return;
    if (context.globalState.get<boolean>('setupCompleted')) return;

    try {
        // vscode.lm.selectChatModels is available in VS Code 1.90+.
        // If it returns models for the 'ollama' vendor, the provider is already
        // configured and we don't need to show the hint.
        const models = await vscode.lm.selectChatModels({ vendor: 'ollama' });
        if (models.length > 0) {
            await context.globalState.update('setupCompleted', true);
            return;
        }
    } catch (e) {
        // API may not exist in older VS Code versions — safe to ignore.
        output.debug(`selectChatModels error: ${(e as Error).message}`);
    }

    const choice = await vscode.window.showInformationMessage(
        'Ollama is running. Set up the Ollama provider in VS Code to see your models in the chat picker.',
        'Set up provider',
        'Do not ask again',
        'Later'
    );
    if (choice === 'Set up provider') {
        await openProviderSetup();
    } else if (choice === 'Do not ask again') {
        await vscode.workspace
            .getConfiguration('ollamaLifecycle')
            .update('suppressSetupHint', true, vscode.ConfigurationTarget.Global);
    }
}

// ---------------------------------------------------------------------------
// Status bar quick-pick menu
// ---------------------------------------------------------------------------

/**
 * Shows a context-sensitive QuickPick menu when the user clicks the status bar item.
 *
 * Menu items are built dynamically based on the current state so that, for
 * example, "Stop server" only appears when the server is owned and running.
 * This avoids confusing the user with actions that would be no-ops.
 */
async function showStatusBarMenu(context: vscode.ExtensionContext) {
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = [];
    const reachable =
        state.kind === 'owned-running' || state.kind === 'external-running';

    if (state.kind === 'stopped' || state.kind === 'error') {
        items.push({ id: 'start', label: '$(play) Start server' });
    }
    if (state.kind === 'owned-running') {
        items.push({ id: 'stop',    label: '$(debug-stop) Stop server' });
        items.push({ id: 'restart', label: '$(refresh) Restart server' });
    }
    items.push({ id: 'status', label: '$(info) Show status' });
    if (reachable) {
        items.push({ id: 'models', label: '$(list-unordered) Show installed models' });
    }
    items.push({
        id: 'provider',
        label: '$(gear) Set up Ollama provider in VS Code',
    });
    items.push({
        id: 'toggleAuto',
        label: `$(sync) Toggle auto-start (currently: ${cfg().autoStart ? 'on' : 'off'})`,
    });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Ollama — status: ${state.kind}`,
    });
    if (!pick) return;

    switch (pick.id) {
        case 'start':   await startServer();  break;
        case 'stop':    await stopServer();   break;
        case 'restart':
            await stopServer();
            await startServer();
            break;
        case 'status':  await showStatus();   break;
        case 'models':  await showModels();   break;
        case 'provider': await openProviderSetup(); break;
        case 'toggleAuto': {
            const current = cfg().autoStart;
            await vscode.workspace
                .getConfiguration('ollamaLifecycle')
                .update('autoStart', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Auto-start is now ${!current ? 'enabled' : 'disabled'}.`
            );
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

/**
 * Prints a status summary to the Output channel and brings it into focus.
 * Called from the "Show status" menu item — useful for bug reports.
 */
async function showStatus() {
    const c = cfg();
    const probe = await probeVersion(1000);
    output.show(true);
    output.info('--- Status ---');
    output.info(`State: ${state.kind}`);
    output.info(`Owned process: ${ownedProcess ? `PID ${ownedProcess.pid}` : 'none'}`);
    output.info(`Host:Port: ${c.host}:${c.port}`);
    output.info(`Auto-start: ${c.autoStart}, Stop-on-exit: ${c.stopOnExit}`);
    output.info(`Probe /api/version: ok=${probe.ok}${probe.body ? ` body=${probe.body.trim()}` : ''}${probe.error ? ` err=${probe.error}` : ''}`);
}

/**
 * Fetches and dumps the raw /api/tags JSON to the Output channel.
 * Lets the user verify which models Ollama has loaded without leaving VS Code.
 */
async function showModels() {
    try {
        const body = await fetchTags();
        output.show(true);
        output.info('--- /api/tags ---');
        output.info(body);
    } catch (e) {
        output.error(`Failed to fetch models: ${(e as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// Extension entry points
// ---------------------------------------------------------------------------

/**
 * Called by VS Code when the extension activates (activationEvent: onStartupFinished).
 *
 * onStartupFinished means we activate after the workbench has rendered, so the
 * status bar item appears immediately without delaying the editor startup.
 *
 * Startup sequence:
 * 1. Create Output channel and status bar item.
 * 2. Register all commands.
 * 3. Register the synchronous process.exit handler (orphan prevention).
 * 4. Probe the server:
 *    - Already running → mark as external.
 *    - Not running + autoStart → start it.
 *    - Not running, no autoStart → mark as stopped.
 * 5. If the server is reachable, maybe show the first-run setup hint.
 */
export async function activate(context: vscode.ExtensionContext) {
    // LogOutputChannel (VS Code 1.74+) gives us log-level filtering for free.
    output = vscode.window.createOutputChannel('Ollama for Copilot', { log: true });
    context.subscriptions.push(output);

    // Alignment.Left keeps the icon in the "process info" area (left side),
    // away from the language/encoding indicators on the right.
    statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100 // Higher priority = further left among left-aligned items
    );
    statusBar.command = 'ollamaLifecycle.showStatusBarMenu';
    statusBar.text = '$(sync~spin) Ollama';
    statusBar.show();
    context.subscriptions.push(statusBar);

    // Register all commands contributed in package.json. Disposables are
    // added to context.subscriptions so VS Code cleans them up on deactivation.
    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaLifecycle.start', () => startServer()),
        vscode.commands.registerCommand('ollamaLifecycle.stop',  () => stopServer()),
        vscode.commands.registerCommand('ollamaLifecycle.restart', async () => {
            await stopServer();
            await startServer();
        }),
        vscode.commands.registerCommand('ollamaLifecycle.toggleAutoStart', async () => {
            const current = cfg().autoStart;
            await vscode.workspace
                .getConfiguration('ollamaLifecycle')
                .update('autoStart', !current, vscode.ConfigurationTarget.Global);
        }),
        vscode.commands.registerCommand('ollamaLifecycle.showStatus',        () => showStatus()),
        vscode.commands.registerCommand('ollamaLifecycle.openProviderSetup', () => openProviderSetup()),
        vscode.commands.registerCommand('ollamaLifecycle.showStatusBarMenu', () => showStatusBarMenu(context))
    );

    // Belt-and-suspenders: synchronous exit handler to kill the owned process
    // if VS Code crashes or is killed via SIGKILL (where deactivate() won't run).
    exitHandler = () => {
        if (ownedProcess && !ownedProcess.killed) {
            try {
                ownedProcess.kill('SIGTERM');
            } catch {
                /* ignore — process may already be gone */
            }
        }
    };
    process.on('exit', exitHandler);

    // Initial state probe and optional auto-start.
    const probe = await probeVersion();
    if (probe.ok) {
        setState({ kind: 'external-running' });
    } else if (cfg().autoStart) {
        await startServer();
    } else {
        setState({ kind: 'stopped' });
    }

    // Show the provider setup hint only if the server is reachable.
    // Fire-and-forget: we must not await here or we'd block the activate()
    // return value, which VS Code waits for before considering the extension ready.
    if (state.kind === 'owned-running' || state.kind === 'external-running') {
        void maybeShowSetupHint(context);
    }
}

/**
 * Called by VS Code when the extension deactivates (window close, reload, disable).
 *
 * We remove the synchronous process.exit handler (no longer needed once
 * deactivate() runs cleanly) and stop the owned server if stopOnExit is true.
 *
 * NOTE: deactivate() is async but VS Code 1.x does not await it on a normal
 * window close — it gives extensions ~500 ms. stopServer() usually completes
 * well within that window on macOS/Linux. On Windows, where process killing is
 * slower, the exitHandler fallback (registered above) acts as insurance.
 */
export async function deactivate() {
    if (exitHandler) {
        try {
            process.removeListener('exit', exitHandler);
        } catch {
            /* ignore */
        }
    }
    if (ownedProcess && cfg().stopOnExit) {
        await stopServer();
    }
}

