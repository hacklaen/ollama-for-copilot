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
function fetchTags(): Promise<string> {
    const { host, port } = cfg();
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
async function waitUntilReady(maxMs = 10_000, intervalMs = 250): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        const r = await probeVersion();
        if (r.ok) return true;
        await new Promise((res) => setTimeout(res, intervalMs));
    }
    return false;
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

    // Check whether an external instance is already running (e.g. started by
    // the user in a terminal or by another tool).
    const probe = await probeVersion();
    if (probe.ok) {
        setState({ kind: 'external-running' });
        return;
    }

    busy = true;
    setState({ kind: 'starting' });
    const { ollamaPath, modelsDir } = cfg();

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

        const child = spawn(ollamaPath, ['serve'], {
            stdio: ['ignore', 'pipe', 'pipe'], // stdin closed; stdout/stderr piped for logging
            detached: false,  // Keep the child attached so it is killed with VS Code on a crash
            env: spawnEnv,
        });

        // The 'error' event fires synchronously before any 'exit' event when
        // spawn itself fails (binary not found, permission denied, etc.).
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

        // Forward server stdout/stderr to the Output channel at debug level.
        // The user can inspect them via View > Output > Ollama for Copilot.
        child.stdout?.on('data', (d) => output.debug(`[ollama] ${String(d).trimEnd()}`));
        child.stderr?.on('data', (d) => output.debug(`[ollama] ${String(d).trimEnd()}`));

        // Watch for unexpected exits (e.g. port already in use → ollama exits ~immediately).
        child.on('exit', (code, signal) => {
            output.info(`Ollama process exited (code=${code}, signal=${signal})`);
            if (ownedProcess === child) {
                ownedProcess = undefined;
                // Don't overwrite a deliberate 'stopping' transition.
                if (state.kind !== 'stopping') {
                    setState({ kind: 'stopped' });
                }
            }
        });

        ownedProcess = child;

        // Poll until the server's HTTP endpoint responds or we time out.
        const ready = await waitUntilReady();

        if (spawnFailed) {
            // Error state was already set inside the 'error' handler above.
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

