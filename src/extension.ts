/*
 * Aurix TCF Debugger VSCode Extension
 * Based on Intel's vscode-tcf-debug
 * Copyright (C) 2025 Infineon Technologies AG
 * 
 * Entry point for the VSCode extension.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { AurixTCFDebugSession } from './debugProvider';
import { ChildProcess, execFile, spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { showDebugConfigPanel } from './debugConfigPanel';
import { LiveWatchProvider } from './liveWatchView';
import { getSvdOptionsForDevice } from './svdCatalog';
import { flashingUnavailableMessage, validateFlashingOptions } from './flashing';

let tcfAgentProcess: ChildProcess | undefined;
let agentStopPromise: Promise<void> = Promise.resolve();
let extensionContext: vscode.ExtensionContext;
let agentOutput: vscode.OutputChannel | undefined;
let activeAurixSessions = 0;
let startingAurixSessions = 0;
let pendingStopTimer: NodeJS.Timeout | undefined;
let pendingStopToken = 0;
let lastAgentHost: string | undefined;
let lastAgentPort: number | undefined;
let enforcingMemoryInspectorSettings = false;
const memoryInspectorExtensionId = 'eclipse-cdt.memory-inspector';
let instructionStepStatusItem: vscode.StatusBarItem | undefined;
const instructionStepStateKey = 'aurix-tcf.instructionSteppingEnabled';
let lastInstructionSteppingEnabled = false;
let liveWatchStatusItem: vscode.StatusBarItem | undefined;
let liveWatchProvider: LiveWatchProvider | undefined;
const liveWatchEnabledStateKey = 'aurix-tcf.liveWatch.enabled';
const liveWatchIntervalStateKey = 'aurix-tcf.liveWatch.intervalMs';
let lastLiveWatchEnabled = false;
let lastLiveWatchIntervalMs = 1000;
let sourceRevealGeneration = 0;
let sourceRevealQueue: Promise<void> = Promise.resolve();
const SVD_CACHE_FOLDER = 'svd-cache';
const LIVE_WATCH_INTERVAL_OPTIONS = [200, 500, 1000, 2000] as const;

export function activate(context: vscode.ExtensionContext) {
	// This method is called when the extension is activated
	extensionContext = context;
	console.log('Aurix TCF debugging extension is activating...');
	agentOutput = vscode.window.createOutputChannel('AURIX TCF Agent');
	liveWatchProvider = new LiveWatchProvider(context);
	context.subscriptions.push(liveWatchProvider);

	void ensureMemoryInspectorSettings();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (enforcingMemoryInspectorSettings) {
				return;
			}
			if (
				event.affectsConfiguration('memory-inspector.debugTypes') ||
				event.affectsConfiguration('memory-inspector.refreshOnStop') ||
				event.affectsConfiguration('memory-inspector.periodicRefresh') ||
				event.affectsConfiguration('memory-inspector.periodicRefreshInterval')
			) {
				void ensureMemoryInspectorSettings();
			}
		})
	);

	// Commands (added): open the debug configuration webview panel
	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.openDebugConfig', () => {
			void showDebugConfigPanel(context);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.pickSvd', async (args?: { targetDevice?: string }) => {
			void args;
			const options = await getSvdOptionsForDevice(context.extensionPath);
			const items: Array<vscode.QuickPickItem & { value?: string; browse?: boolean }> = [
				...options.map((option) => ({ label: option.label, description: option.value, value: option.value })),
				{ label: 'Browse local SVD...', description: 'Select any .svd file from disk', browse: true },
			];

			const picked = await vscode.window.showQuickPick(items, {
				title: 'Select SVD file',
				placeHolder: 'Pick SVD file',
				ignoreFocusOut: true,
			});
			if (!picked) {
				return undefined;
			}
			if (picked.browse) {
				const selected = await vscode.window.showOpenDialog({
					canSelectMany: false,
					openLabel: 'Select SVD',
					filters: {
						svdFiles: ['svd'],
						allFiles: ['*'],
					},
				});
				return selected?.[0]?.fsPath;
			}

			return picked.value;
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.resetTarget', async () => {
			const s = vscode.debug.activeDebugSession;
			if (!s || s.type !== 'aurix-tcf') {
				void vscode.window.showWarningMessage('No active AURIX™ TCF debug session.');
				return;
			}
			await s.customRequest('aurix-tcf/reset', { suspend: true, pauseAll: true });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.toggleInstructionStepping', async () => {
			const enabled = !(await getInstructionSteppingEnabled());
			await setInstructionSteppingMode(enabled);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.toggleLiveWatch', async () => {
			const enabled = !(await getLiveWatchEnabled());
			await setLiveWatchMode(enabled);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.configureLiveWatch', async () => {
			const currentEnabled = await getLiveWatchEnabled();
			const currentInterval = await getLiveWatchIntervalMs();
			const items: Array<vscode.QuickPickItem & { enabled: boolean; intervalMs?: number; custom?: boolean }> = [
				{ label: 'Off', description: currentEnabled ? '' : 'Current', enabled: false },
				...LIVE_WATCH_INTERVAL_OPTIONS.map((intervalMs) => ({
					label: `${intervalMs} ms`,
					description: currentEnabled && currentInterval === intervalMs ? 'Current' : '',
					enabled: true,
					intervalMs,
				})),
				{
					label: 'Custom...',
					description: currentEnabled && !LIVE_WATCH_INTERVAL_OPTIONS.includes(currentInterval as any) ? `Current: ${currentInterval} ms` : '',
					enabled: true,
					custom: true,
				},
			];
			const picked = await vscode.window.showQuickPick(items, {
				title: 'Configure Live Watch',
				placeHolder: 'Select refresh interval for running global watch values (minimum 200ms+)',
				ignoreFocusOut: true,
			});
			if (!picked) {
				return;
			}
			if (picked.custom) {
				const customValue = await vscode.window.showInputBox({
					title: 'Custom Live Watch Interval',
					placeHolder: 'Enter refresh interval in milliseconds (minimum 200ms+)',
					value: String(currentInterval),
					ignoreFocusOut: true,
					validateInput: (input) => {
						const trimmed = input.trim();
						if (trimmed === '') {
							return 'Interval is required.';
						}
						const parsed = Number(trimmed);
						if (!Number.isFinite(parsed) || parsed < 200) {
							return 'Minimum 200ms+';
						}
						return undefined;
					},
				});
				if (customValue === undefined) {
					return;
				}
				await setLiveWatchMode(true, Number(customValue.trim()));
				return;
			}
			await setLiveWatchMode(picked.enabled, picked.intervalMs);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchAddExpression', async () => {
			await liveWatchProvider?.addExpression();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchRemoveExpression', async (item?: { expression?: string }) => {
			await liveWatchProvider?.removeExpression(item as any);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchClearExpressions', async () => {
			await liveWatchProvider?.clearExpressions();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchRefresh', async () => {
			await liveWatchProvider?.refreshNow();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.enableInstructionStepping', async () => {
			await setInstructionSteppingMode(true);
		}),
		vscode.commands.registerCommand('aurix-tcf.disableInstructionStepping', async () => {
			await setInstructionSteppingMode(false);
		})
	);

	instructionStepStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	instructionStepStatusItem.command = 'aurix-tcf.toggleInstructionStepping';
	instructionStepStatusItem.tooltip = 'Toggle instruction-level stepping';
	context.subscriptions.push(instructionStepStatusItem);
	liveWatchStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	liveWatchStatusItem.command = 'aurix-tcf.configureLiveWatch';
	liveWatchStatusItem.tooltip = 'Configure live watch refresh for running global variables';
	context.subscriptions.push(liveWatchStatusItem);
	const liveWatchTreeView = vscode.window.createTreeView('aurixTcfLiveWatch', { treeDataProvider: liveWatchProvider });
	liveWatchProvider.attachView(liveWatchTreeView);
	context.subscriptions.push(liveWatchTreeView);

	// Register debug configuration provider
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('aurix-tcf', new AurixTCFConfigurationProvider())
	);

	// Register debug adapter factory
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory('aurix-tcf', new AurixTCFDebugAdapterFactory())
	);

	// Register timestamp command (useful for recording TCF messages with timestamps)
	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.timestamp', () => {
			return new Date().toISOString().replaceAll(":", "-");
		})
	);

	// Ensure we clean up the agent when the debug session is terminated.
	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session: vscode.DebugSession) => {
			if (session.type === 'aurix-tcf') {
				activeAurixSessions++;
				if (pendingStopTimer) {
					clearTimeout(pendingStopTimer);
					pendingStopTimer = undefined;
					pendingStopToken++;
					agentOutput?.appendLine('Cancelled pending agent shutdown (new session started).');
				}
				void ensureMemoryInspectorSettings();
				void syncInstructionSteppingOnSessionStart(session);
				void syncLiveWatchOnSessionStart(session);
				void liveWatchProvider?.refreshNow();
			}
		})
	);
	context.subscriptions.push(
		vscode.debug.onDidChangeActiveDebugSession(() => {
			sourceRevealGeneration++;
			void liveWatchProvider?.refreshNow();
		})
	);
	context.subscriptions.push(
		vscode.debug.onDidChangeActiveStackItem((item) => {
			sourceRevealGeneration++;
			const session = vscode.debug.activeDebugSession;
			if (!session || session.type !== 'aurix-tcf') {
				return;
			}
			if (!item) {
				return;
			}
			// Only act once we have a stack frame (stopped state).
			const isStackFrame = typeof (item as vscode.DebugStackFrame).frameId === 'number';
			if (!isStackFrame) {
				return;
			}
			queueSourceReveal(item as vscode.DebugStackFrame);
		})
	);
	context.subscriptions.push(
		vscode.debug.onDidTerminateDebugSession(async (session) => {
			if (session.type !== 'aurix-tcf') {
				return;
			}
			sourceRevealGeneration++;
			activeAurixSessions = Math.max(0, activeAurixSessions - 1);
			if (activeAurixSessions === 0) {
				updateInstructionSteppingStatus(lastInstructionSteppingEnabled, false);
				updateLiveWatchStatus(lastLiveWatchEnabled, lastLiveWatchIntervalMs, false);
				liveWatchProvider?.refreshScheduling(false, lastLiveWatchIntervalMs);
			}
			// A new launch cancels this timer and awaits the owned agent's shutdown itself.
			if (activeAurixSessions === 0) {
				if (pendingStopTimer) {
					clearTimeout(pendingStopTimer);
				}
				const stopToken = ++pendingStopToken;
				agentOutput?.appendLine('Scheduling agent shutdown in 1s (cancelled if a new session starts).');
				pendingStopTimer = setTimeout(() => {
					pendingStopTimer = undefined;
					if (
						stopToken === pendingStopToken &&
						activeAurixSessions === 0 &&
						startingAurixSessions === 0
					) {
						void stopTCFAgent('debug session terminated').catch(reportAgentStopError);
					}
				}, 1000);
			}
		})
	);

	// Handle agent lifecycle
	context.subscriptions.push({
		dispose: () => {
			void stopTCFAgent('extension disposed').catch(reportAgentStopError);
		}
	});

	void vscode.window.showInformationMessage('Aurix TCF debugging extension is enabled.');
}

export class AurixTCFDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    // Create the debug adapter descriptor for a debug session
	async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
		startingAurixSessions++;
		// VS Code Restart can create a new session/adapter before firing onDidStartDebugSession.
		// Cancel any pending shutdown early so we don't kill the agent mid-start.
		if (pendingStopTimer) {
			clearTimeout(pendingStopTimer);
			pendingStopTimer = undefined;
			pendingStopToken++;
			agentOutput?.appendLine('Cancelled pending agent shutdown (session is starting).');
		}
		try {
		const config = session.configuration;

		try {
			validateFlashingOptions(config);
		} catch (error) {
			void vscode.window.showErrorMessage(flashingUnavailableMessage);
			throw error;
		}

		// Auto-start TCF agent if requested
		if (config.autoStartAgent) {
			// Preflight: validate targetDevice early so typos fail fast.
			if (typeof config.targetDevice === 'string' && config.targetDevice.trim() !== '') {
				try {
					await validateAgentTargetDevice(config.targetDevice);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					void vscode.window.showErrorMessage(`Invalid targetDevice for agent: ${msg}`);
					throw e;
				}
			}

			// Use configured agent path, or fallback to bundled agent
			const configuredPath = config.agentPath || vscode.workspace.getConfiguration("aurix-tcf").get('agentPath');
			const agentPath = configuredPath || path.join(extensionContext.extensionPath, 'bin', 'aurix-debugger.exe');
			
			// Build agent arguments based on Eclipse log format
			const agentArgs: string[] = [];
			const userArgs: string[] = [];
			
			// -s TCP:host:port (server mode)
			agentArgs.push('-s', `TCP:${config.host || '127.0.0.1'}:${config.port || 1534}`);
			
			// -p device_name (target device)
			if (config.targetDevice) {
				agentArgs.push('-p', config.targetDevice);
			}
			
			// -e entry_function
			if (config.entryFunction) {
				agentArgs.push('-e', config.entryFunction);
			}
			
			// -b is the user breakpoint count, not the selected core.
			const enabledSourceBreakpoints = vscode.debug.breakpoints.filter(
				breakpoint => breakpoint.enabled && breakpoint instanceof vscode.SourceBreakpoint
			).length;
			agentArgs.push('-b', String(enabledSourceBreakpoints));
			
			// -r svd_file_path
			if (config.svdFile) {
				agentArgs.push('-r', config.svdFile);
			}
			
			// -K workspace_path
			if (config.workspace) {
				agentArgs.push('-K', config.workspace);
			}
			
			// -f and -G flags
			if (config.flashDownload !== false) {
				agentArgs.push('-f');
			}

			// Collect user-provided args first so they can override auto-generated flags.
			// This is important for multi-core selection (-A) where the launcher may emit
			// a mask that does not correspond 1:1 with the ELF-path fields in this extension.
			if (typeof config.additionalAgentOptions === 'string' && config.additionalAgentOptions.trim() !== '') {
				userArgs.push(...splitCommandLine(config.additionalAgentOptions));
			}
			if (config.agentArgs && Array.isArray(config.agentArgs)) {
				userArgs.push(...config.agentArgs);
			}

			// Auto-generate -A core selection mask from PPU/CDSP/SCR ELF paths,
			// unless the user already provided -A in additionalAgentOptions or agentArgs.
			if (!userProvidedAParameter(userArgs)) {
				const mask = buildCoreSelectionMask(config);
				if (mask) {
					agentArgs.push('-A', mask);
				}
			}

			agentArgs.push(...userArgs);
			
			const host = config.host || '127.0.0.1';
			const port = config.port || 1534;

			await startTCFAgent(agentPath, agentArgs, host, port);
		}

		// Enable path mapper based on workspace trust and configuration
		const pathMapperConfigDefault = vscode.workspace.getConfiguration("aurix-tcf").inspect("executePathMapper")?.defaultValue ?? true;
		const pathMapperConfig = vscode.workspace.getConfiguration("aurix-tcf").get('executePathMapper', pathMapperConfigDefault);

		const enablePathMapper = vscode.workspace.isTrusted && pathMapperConfig === true;
		
		return new vscode.DebugAdapterInlineImplementation(new AurixTCFDebugSession(enablePathMapper));
		} finally {
			startingAurixSessions = Math.max(0, startingAurixSessions - 1);
		}
	}
}

function parseCsvLine(line: string): string[] {
	// Minimal CSV parser supporting quoted fields.
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++;
				continue;
			}
			inQuotes = !inQuotes;
			continue;
		}
		if (ch === ',' && !inQuotes) {
			fields.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	fields.push(current.trim());
	return fields;
}

type LsmcddDevice = {
	id: string;
	name: string;
	family: string;
};

async function listLsmcddDevices(): Promise<LsmcddDevice[]> {
	const exePath = path.join(extensionContext.extensionPath, 'bin', 'lsmcdd.exe');
	if (!fs.existsSync(exePath)) {
		throw new Error(`lsmcdd.exe not found: ${exePath}`);
	}
	const output = await new Promise<string>((resolve, reject) => {
		execFile(
			exePath,
			{ cwd: path.dirname(exePath), windowsHide: true, maxBuffer: 5 * 1024 * 1024, timeout: 10_000 },
			(err, stdout, stderr) => {
			const combined = (stdout && stdout.trim().length > 0) ? stdout : (stderr ?? '');
			if (err && (!combined || combined.trim().length === 0)) {
				reject(new Error((stderr || err.message || 'Unknown error').trim()));
				return;
			}
			resolve(combined ?? '');
		}
		);
	});
	const devices: LsmcddDevice[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const fields = parseCsvLine(line);
		const id = (fields[0] ?? '').trim();
		const name = (fields[1] ?? '').trim();
		const family = (fields[3] ?? '').trim();
		if (id !== '' && name !== '') {
			devices.push({ id, name, family });
		}
	}
	return devices;
}

async function validateAgentTargetDevice(targetDevice: string): Promise<void> {
	const raw = targetDevice.trim();
	if (raw === '') {
		return;
	}
	if (/^\d+$/.test(raw)) {
		throw new Error(`targetDevice must be a device name (not a numeric id).`);
	}
	try {
		const devices = await listLsmcddDevices();
		if (devices.length === 0) {
			throw new Error('No devices detected by lsmcdd.exe');
		}
		const rawLower = raw.toLowerCase();
		const ok = devices.some((d) => (d.name ?? '').trim() !== '' && d.name.toLowerCase() === rawLower);
		if (!ok) {
			const names = devices.map((d) => d.name).join('; ');
			throw new Error(`Device '${raw}' not found. Available: ${names}`);
		}
	} catch (e) {
		// If we cannot validate (tool missing/timeout), don't block debugging.
		// But if we *did* get a device list and it doesn't match, we throw above.
		const msg = e instanceof Error ? e.message : String(e);
		agentOutput?.appendLine(`Warning: could not validate targetDevice via lsmcdd.exe: ${msg}`);
		// Re-throw only for definite mismatch errors (which include 'Available:').
		if (typeof msg === 'string' && msg.includes('Available:')) {
			throw e;
		}
	}
}

function splitCommandLine(text: string): string[] {
	// Simple quote-aware split for Additional Agent Options.
	// Supports: foo bar "quoted arg" 'single quoted'.
	const out: string[] = [];
	let cur = '';
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch as any;
			continue;
		}
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			if (cur.trim() !== '') {
				out.push(cur);
				cur = '';
			}
			continue;
		}
		cur += ch;
	}
	if (cur.trim() !== '') {
		out.push(cur);
	}
	return out;
}

function buildCoreSelectionMask(config: any): string | undefined {
	const hasPath = (v: any) => typeof v === 'string' && v.trim() !== '';
	const chars = new Array(14).fill('-');
	if (hasPath(config.ppuElfPath)) {
		chars[0] = 'p';
	}
	const cdsp = Array.isArray(config.cdspElfPaths) ? config.cdspElfPaths : [];
	for (let i = 0; i < 12; i++) {
		if (hasPath(cdsp[i])) {
			chars[i + 1] = 'c';
		}
	}
	if (hasPath(config.scrElfPath)) {
		chars[13] = 's';
	}
	const mask = chars.join('');
	return /[^-]/.test(mask) ? mask : undefined;
}

function userProvidedAParameter(args: string[]): boolean {
	for (const a of args) {
		if (a === '-A') {
			return true;
		}
		// Allow combined form: -Apcc-----
		if (a.startsWith('-A') && a.length > 2) {
			return true;
		}
	}
	return false;
}

function resolveConfigPathFromFolder(folder: vscode.WorkspaceFolder | undefined, p: unknown): string | undefined {
	if (typeof p !== 'string' || p.trim() === '') {
		return undefined;
	}
	let out = p;
	const ws = folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
	if (ws) {
		out = out.replaceAll('${workspaceFolder}', ws);
		out = out.replaceAll('${workspaceRoot}', ws);
	}
	out = out.replace(/\//g, path.sep);
	if (!path.isAbsolute(out) && ws) {
		out = path.resolve(ws, out);
	}
	return out;
}

function getSvdCacheRoot(): string {
	const fromGlobalStorage = extensionContext?.globalStorageUri?.fsPath;
	if (typeof fromGlobalStorage === 'string' && fromGlobalStorage.trim() !== '') {
		return path.join(fromGlobalStorage, SVD_CACHE_FOLDER);
	}
	return path.join(extensionContext.extensionPath, '.cache', SVD_CACHE_FOLDER);
}

async function ensureDirectory(dirPath: string): Promise<void> {
	await fs.promises.mkdir(dirPath, { recursive: true });
}

async function materializeCompressedSvd(svdGzPath: string): Promise<string> {
	const normalizedInput = path.normalize(svdGzPath);
	if (!fs.existsSync(normalizedInput)) {
		throw new Error(`Compressed SVD not found: ${normalizedInput}`);
	}

	const stat = await fs.promises.stat(normalizedInput);
	const baseName = path.basename(normalizedInput, '.gz');
	const digest = crypto
		.createHash('sha256')
		.update(`${baseName}:${stat.size}`)
		.digest('hex')
		.slice(0, 16);

	const cacheDir = getSvdCacheRoot();
	await ensureDirectory(cacheDir);

	const outputPath = path.join(cacheDir, `${baseName}.${digest}`);
	if (fs.existsSync(outputPath)) {
		return outputPath;
	}

	const tempPath = `${outputPath}.tmp`;
	agentOutput?.appendLine(`Preparing SVD cache: ${baseName}`);
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'AURIX™ TCF: preparing SVD definitions (first run)',
			cancellable: false,
		},
		async (progress) => {
			progress.report({ message: baseName });
			await pipeline(
				fs.createReadStream(normalizedInput),
				createGunzip(),
				fs.createWriteStream(tempPath)
			);
		}
	);
	await fs.promises.rename(tempPath, outputPath);
	agentOutput?.appendLine(`SVD cache ready: ${outputPath}`);
	return outputPath;
}

async function resolveUsableSvdPath(
	folder: vscode.WorkspaceFolder | undefined,
	value: string | undefined,
): Promise<string | undefined> {
	if (!value || value.trim() === '') {
		return undefined;
	}

	const resolved = resolveConfigPathFromFolder(folder, value) ?? value;
	const lower = resolved.toLowerCase();
	if (lower.endsWith('.svd.gz')) {
		return await materializeCompressedSvd(resolved);
	}
	return resolved;
}

export class AurixTCFConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Provide initial debug configurations when launch.json is created
	 */
	provideDebugConfigurations(
		folder: vscode.WorkspaceFolder | undefined,
		token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration[]> {
		return [
			{
				type: 'aurix-tcf',
				request: 'launch',
				name: 'Debug Aurix Program',
				workspace: '${workspaceFolder}',
				program: '${workspaceFolder}/build/program.elf',
				enableFlashing: false,
				enableConsoleLog: false
			}
		];
	}

	/**
	 * Massage a debug configuration just before a debug session is being launched.
	 */
	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined, 
		config: vscode.DebugConfiguration, 
		token?: vscode.CancellationToken
	): Promise<vscode.DebugConfiguration | undefined> {

		// This extension does not support user-facing attach sessions.
		if ((config as any).request === 'attach') {
			void vscode.window.showErrorMessage('AURIX™ TCF Debugger: attach is not supported. Use a launch configuration (via the GUI panel).');
			return undefined;
		}

		// If launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && (editor.document.languageId === 'cpp' || editor.document.languageId === 'c')) {
				config.type = 'aurix-tcf';
				config.name = 'Launch Aurix Program';
				config.request = 'launch';
				config.host = 'localhost';
				config.port = 1534;
			}
		}

		// Provide defaults
		if (!config.host) {
			config.host = 'localhost';
		}
		if (!config.port) {
			config.port = 1534;
		}
		if (typeof (config as any).liveWatchEnabled !== 'boolean') {
			(config as any).liveWatchEnabled = await getLiveWatchEnabled();
		}
		if (typeof (config as any).liveWatchIntervalMs !== 'number') {
			(config as any).liveWatchIntervalMs = await getLiveWatchIntervalMs();
		}

		// Console logging toggle: enableConsoleLog maps to debugTCFMessages.
		if (typeof (config as any).enableConsoleLog === 'boolean') {
			(config as any).debugTCFMessages = (config as any).enableConsoleLog;
		}

		const asNonEmptyString = (value: any): string | undefined => {
			return typeof value === 'string' && value.trim() !== '' ? value : undefined;
		};
		const looksLikeFilePath = (value: string): boolean => {
			const v = value.trim();
			if (v === '' || v.includes('::')) {
				return false;
			}
			return v.toLowerCase().endsWith('.svd') || v.toLowerCase().endsWith('.svd.gz') || v.includes('${') || /[\\/]/.test(v);
		};

		const svdFile = asNonEmptyString((config as any).svdFile);
		const svdPath = asNonEmptyString((config as any).svdPath);
		const definitionPath = asNonEmptyString((config as any).definitionPath);

		const effectiveSvdFile = asNonEmptyString((config as any).svdFile);

		if (!svdPath && effectiveSvdFile) {
			(config as any).svdPath = effectiveSvdFile;
		}
		if (!definitionPath && effectiveSvdFile) {
			(config as any).definitionPath = effectiveSvdFile;
		}
		if (!effectiveSvdFile) {
			const candidate = svdPath || definitionPath;
			if (candidate && looksLikeFilePath(candidate)) {
				(config as any).svdFile = candidate;
			}
		}

		const usableSvd = await resolveUsableSvdPath(folder, asNonEmptyString((config as any).svdFile));
		if (usableSvd) {
			(config as any).svdFile = usableSvd;
			(config as any).svdPath = usableSvd;
			(config as any).definitionPath = usableSvd;
		}

		return config;
	}
}

async function startTCFAgent(agentPath: string, args: string[], host: string, port: number): Promise<void> {
	// A new session must not inherit the previous agent's launch arguments or breakpoints.
	await stopTCFAgent('restart requested');
	await waitForTcpPortClosed(host, port, 1000);

	lastAgentHost = host;
	lastAgentPort = port;

	agentOutput?.show(true);
	agentOutput?.appendLine(`Starting TCF agent: ${agentPath}`);
	agentOutput?.appendLine(`Agent arguments: ${args.join(' ')}`);

	const proc = spawn(agentPath, args, {
		cwd: path.dirname(agentPath),
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	tcfAgentProcess = proc;

	proc.stdout?.on('data', (data) => {
		agentOutput?.appendLine(String(data).trimEnd());
	});

	proc.stderr?.on('data', (data) => {
		agentOutput?.appendLine(String(data).trimEnd());
	});

	proc.on('exit', (code, signal) => {
		agentOutput?.appendLine(`TCF agent exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
		if (tcfAgentProcess === proc) {
			tcfAgentProcess = undefined;
		}
	});

	proc.on('error', (err) => {
		agentOutput?.appendLine(`Failed to start TCF agent: ${err.message}`);
	});

	// Avoid a race where the debug adapter tries to connect before the agent has
	// started listening on the requested TCP port.
	agentOutput?.appendLine(`Waiting for TCF agent to listen on ${host}:${port}...`);
	try {
		await waitForTcpPort(host, port, 15_000);
	} catch (error) {
		await stopTCFAgent('agent startup failed');
		throw error;
	}
	agentOutput?.appendLine(`TCF agent is listening on ${host}:${port}`);
}

function reportAgentStopError(error: unknown): void {
	const message = `Failed to stop TCF agent: ${String(error)}`;
	agentOutput?.appendLine(message);
	void vscode.window.showErrorMessage(message);
}

function stopTCFAgent(reason: string): Promise<void> {
	agentStopPromise = agentStopPromise.then(() => stopTCFAgentProcess(reason));
	return agentStopPromise;
}

async function stopTCFAgentProcess(reason: string): Promise<void> {
	// Stop the TCF agent process if running
	if (!tcfAgentProcess) {
		return;
	}

	const proc = tcfAgentProcess;
	const pid = proc.pid;
	tcfAgentProcess = undefined;

	if (!pid) {
		return;
	}

	agentOutput?.appendLine(`Stopping TCF agent (pid ${pid}) - ${reason}`);

	if (proc.exitCode === null && proc.signalCode === null) {
		if (process.platform === 'win32') {
			// Kill the whole process tree; aurix-debugger.exe may spawn helper processes.
			await new Promise<void>((resolve, reject) => {
				execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
					if (stdout) {
						agentOutput?.appendLine(String(stdout).trimEnd());
					}
					if (stderr) {
						agentOutput?.appendLine(String(stderr).trimEnd());
					}
					if (err) {
						reject(err);
						return;
					}
					resolve();
				});
			});
		} else {
			if (!proc.kill()) {
				throw new Error(`Failed to signal TCF agent ${pid}`);
			}
		}
	}

	if (lastAgentHost && typeof lastAgentPort === 'number') {
		await waitForTcpPortClosed(lastAgentHost, lastAgentPort, 10_000);
	}
}

function waitForTcpPortClosed(host: string, port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tryOnce = () => {
			const socket = new net.Socket();
			socket.setTimeout(500);
			socket.once('connect', () => {
				socket.destroy();
				retryOrFail();
			});
			socket.once('timeout', () => {
				socket.destroy();
				// timeout means no clean refusal; keep trying until deadline
				retryOrFail();
			});
			socket.once('error', () => {
				socket.destroy();
				// ECONNREFUSED/ENOTFOUND => port not listening
				resolve();
			});

			const retryOrFail = () => {
				if (Date.now() >= deadline) {
					reject(new Error(`Timed out waiting for ${host}:${port} to close`));
					return;
				}
				setTimeout(tryOnce, 150);
			};

			socket.connect(port, host);
		};
		tryOnce();
	});
}

function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tryOnce = () => {
			// If the agent already exited, don't keep polling.
			if (!tcfAgentProcess) {
				reject(new Error('TCF agent process is not running'));
				return;
			}
			if (tcfAgentProcess.exitCode !== null) {
				reject(new Error(`TCF agent exited early (code ${tcfAgentProcess.exitCode})`));
				return;
			}
			const socket = new net.Socket();
			socket.setTimeout(500);
			socket.once('connect', () => {
				socket.destroy();
				resolve();
			});
			socket.once('timeout', () => {
				socket.destroy();
				retryOrFail();
			});
			socket.once('error', () => {
				socket.destroy();
				retryOrFail();
			});

			const retryOrFail = () => {
				if (Date.now() >= deadline) {
					reject(new Error(`Timed out waiting for ${host}:${port}`));
					return;
				}
				setTimeout(tryOnce, 150);
			};

			socket.connect(port, host);
		};

		tryOnce();
	});
}

async function ensureMemoryInspectorSettings(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration();
	const desiredDebugger = 'aurix-tcf';
	const currentTypes = cfg.get<string[]>('memory-inspector.debugTypes') ?? [];
	const typeList = Array.isArray(currentTypes) ? currentTypes.slice() : [];
	const needsType = !typeList.includes(desiredDebugger);
	if (!needsType) {
		return;
	}
	try {
		enforcingMemoryInspectorSettings = true;
		typeList.push(desiredDebugger);
		await cfg.update('memory-inspector.debugTypes', typeList, vscode.ConfigurationTarget.Workspace);
	} catch (e) {
		agentOutput?.appendLine(`Failed to enforce memory-inspector settings: ${String(e)}`);
	} finally {
		enforcingMemoryInspectorSettings = false;
	}
}

async function getInstructionSteppingEnabled(): Promise<boolean> {
	const stored = extensionContext.workspaceState.get<boolean>(instructionStepStateKey);
	if (typeof stored === 'boolean') {
		return stored;
	}
	const cfg = vscode.workspace.getConfiguration('aurix-tcf');
	return cfg.get<boolean>('instructionSteppingDefault', false);
}

function normalizeLiveWatchIntervalMs(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric)) {
		return 1000;
	}
	return Math.min(10_000, Math.max(200, Math.round(numeric)));
}

async function getLiveWatchEnabled(): Promise<boolean> {
	const stored = extensionContext.workspaceState.get<boolean>(liveWatchEnabledStateKey);
	if (typeof stored === 'boolean') {
		return stored;
	}
	const cfg = vscode.workspace.getConfiguration('aurix-tcf');
	return cfg.get<boolean>('liveWatch.enabled', false);
}

async function getLiveWatchIntervalMs(): Promise<number> {
	const stored = extensionContext.workspaceState.get<number>(liveWatchIntervalStateKey);
	if (typeof stored === 'number' && Number.isFinite(stored)) {
		return normalizeLiveWatchIntervalMs(stored);
	}
	const cfg = vscode.workspace.getConfiguration('aurix-tcf');
	return normalizeLiveWatchIntervalMs(cfg.get<number>('liveWatch.intervalMs', 1000));
}

async function setLiveWatchEnabled(value: boolean): Promise<void> {
	lastLiveWatchEnabled = value;
	await extensionContext.workspaceState.update(liveWatchEnabledStateKey, value);
}

async function setLiveWatchInterval(value: number): Promise<void> {
	lastLiveWatchIntervalMs = normalizeLiveWatchIntervalMs(value);
	await extensionContext.workspaceState.update(liveWatchIntervalStateKey, lastLiveWatchIntervalMs);
}

async function setLiveWatchMode(enabled: boolean, intervalMs?: number, session?: vscode.DebugSession): Promise<void> {
	const nextIntervalMs = normalizeLiveWatchIntervalMs(intervalMs ?? await getLiveWatchIntervalMs());
	await setLiveWatchEnabled(enabled);
	await setLiveWatchInterval(nextIntervalMs);
	const targetSession = session ?? vscode.debug.activeDebugSession;
	if (targetSession && targetSession.type === 'aurix-tcf') {
		try {
			await targetSession.customRequest('aurix-tcf/setLiveWatch', { enabled, intervalMs: nextIntervalMs });
		} catch (e) {
			agentOutput?.appendLine(`Failed to set live watch: ${String(e)}`);
		}
	}
	updateLiveWatchStatus(enabled, nextIntervalMs, true);
	liveWatchProvider?.refreshScheduling(enabled, nextIntervalMs);
	if (enabled) {
		void liveWatchProvider?.refreshNow();
	}
}

function updateLiveWatchStatus(enabled: boolean, intervalMs: number, visible: boolean): void {
	lastLiveWatchEnabled = enabled;
	lastLiveWatchIntervalMs = normalizeLiveWatchIntervalMs(intervalMs);
	void vscode.commands.executeCommand('setContext', 'aurix-tcf.liveWatchEnabled', enabled);
	if (!liveWatchStatusItem) {
		return;
	}
	liveWatchStatusItem.text = enabled ? `Live Watch: ${lastLiveWatchIntervalMs}ms` : 'Live Watch: OFF';
	liveWatchStatusItem.tooltip = enabled
		? `Live watch is enabled for running global watch expressions (${lastLiveWatchIntervalMs} ms). Click to change.`
		: 'Live watch is disabled. Click to enable or change interval.';
	if (visible) {
		liveWatchStatusItem.show();
	} else {
		liveWatchStatusItem.hide();
	}
}

async function setInstructionSteppingEnabled(value: boolean): Promise<void> {
	lastInstructionSteppingEnabled = value;
	await extensionContext.workspaceState.update(instructionStepStateKey, value);
}

async function setInstructionSteppingMode(enabled: boolean, session?: vscode.DebugSession): Promise<void> {
	await setInstructionSteppingEnabled(enabled);
	const targetSession = session ?? vscode.debug.activeDebugSession;
	if (targetSession && targetSession.type === 'aurix-tcf') {
		try {
			await targetSession.customRequest('aurix-tcf/setInstructionStepping', { enabled });
		} catch (e) {
			agentOutput?.appendLine(`Failed to set instruction stepping: ${String(e)}`);
		}
	}
	updateInstructionSteppingStatus(enabled, true);
}

function updateInstructionSteppingStatus(enabled: boolean, visible: boolean): void {
	lastInstructionSteppingEnabled = enabled;
	void vscode.commands.executeCommand('setContext', 'aurix-tcf.instructionStepping', enabled);
	if (!instructionStepStatusItem) {
		return;
	}
	instructionStepStatusItem.text = enabled ? 'Instr Step: ON' : 'Instr Step: OFF';
	instructionStepStatusItem.tooltip = enabled
		? 'Instruction stepping enabled (click to disable)'
		: 'Instruction stepping disabled (click to enable)';
	if (visible) {
		instructionStepStatusItem.show();
	} else {
		instructionStepStatusItem.hide();
	}
}

async function syncInstructionSteppingOnSessionStart(session: vscode.DebugSession): Promise<void> {
	if (session.type !== 'aurix-tcf') {
		return;
	}
	const enabled = await getInstructionSteppingEnabled();
	await setInstructionSteppingMode(enabled, session);
}

async function syncLiveWatchOnSessionStart(session: vscode.DebugSession): Promise<void> {
	if (session.type !== 'aurix-tcf') {
		return;
	}
	const sessionConfig = session.configuration as { liveWatchEnabled?: boolean; liveWatchIntervalMs?: number } | undefined;
	const enabled = typeof sessionConfig?.liveWatchEnabled === 'boolean'
		? sessionConfig.liveWatchEnabled
		: await getLiveWatchEnabled();
	const intervalMs = sessionConfig?.liveWatchIntervalMs !== undefined
		? normalizeLiveWatchIntervalMs(sessionConfig.liveWatchIntervalMs)
		: await getLiveWatchIntervalMs();
	await setLiveWatchMode(enabled, intervalMs, session);
}

function queueSourceReveal(item: vscode.DebugStackFrame): void {
	const generation = ++sourceRevealGeneration;
	sourceRevealQueue = sourceRevealQueue.then(() => revealSelectedFrameSource(item, generation));
}

async function revealSelectedFrameSource(item: vscode.DebugStackFrame, generation: number): Promise<void> {
	const isCurrent = () => {
		const current = vscode.debug.activeStackItem;
		return sourceRevealGeneration === generation && vscode.debug.activeDebugSession?.id === item.session.id &&
			current?.session.id === item.session.id && current.threadId === item.threadId &&
			'frameId' in current && current.frameId === item.frameId;
	};
	if (!isCurrent()) {
		return;
	}
	try {
		const result: { source?: { path: string; line: number } } = await item.session.customRequest(
			'aurix-tcf/frameSource', { threadId: item.threadId, frameId: item.frameId });
		if (!isCurrent() || !result.source) {
			return;
		}
		const source = result.source;
		if (typeof source.path !== 'string' || !Number.isInteger(source.line) || source.line < 1) {
			throw new Error('Invalid source location for selected frame');
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.path));
		if (!isCurrent()) {
			return;
		}
		const visible = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === document.uri.toString());
		const editor = await vscode.window.showTextDocument(document, {
			viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
			preview: false, preserveFocus: true
		});
		if (!isCurrent()) {
			return;
		}
		const position = new vscode.Position(source.line - 1, 0);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	} catch (error) {
		if (isCurrent()) {
			agentOutput?.appendLine(`Failed to reveal selected core/frame source: ${String(error)}`);
		}
	}
}

export function deactivate() {
	sourceRevealGeneration++;
	void stopTCFAgent('extension deactivate').catch(reportAgentStopError);
	agentOutput?.dispose();
	agentOutput = undefined;
}
