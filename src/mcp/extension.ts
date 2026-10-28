import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRelease, DebugController, DebugHost, DebugMcpError, PeripheralWriteApproval, SourceBreakpoint, validateWorkspaceSource } from './debugController';
import { DebugMcpHttpServer } from './server';
import { createMcpLaunchConfiguration, DebugLifecycleGate } from './launch';
import { preparePeripheralLaunch } from '../peripheralProfile';
import { prepareDebugLaunch } from './prepare';
import { listDasDevices } from '../deviceDiscovery';

function sourceBreakpoint(breakpoint: vscode.SourceBreakpoint): SourceBreakpoint {
	return {
		id: breakpoint.id, source: breakpoint.location.uri.fsPath,
		line: breakpoint.location.range.start.line + 1, column: breakpoint.location.range.start.character + 1,
		enabled: breakpoint.enabled, condition: breakpoint.condition,
		hitCondition: breakpoint.hitCondition, logMessage: breakpoint.logMessage,
	};
}

export class DebugMcpRegistration implements vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel('AURIX Debug MCP');
	private readonly changes = new vscode.EventEmitter<void>();
	private readonly subscriptions: vscode.Disposable[] = [this.output, this.changes];
	private readonly sessions = new Map<string, vscode.DebugSession>();
	private readonly endedSessions = new Map<string, vscode.DebugSession>();
	private readonly controller: DebugController;
	private endpoint?: DebugMcpHttpServer;
	private starting?: Promise<DebugMcpHttpServer>;
	private stopping: Promise<void> = Promise.resolve();
	private disposed = false;
	private confirmingWrite = false;

	constructor(private readonly context: vscode.ExtensionContext, private readonly lifecycle: DebugLifecycleGate,
		private readonly releaseAgent: (session: vscode.DebugSession) => Promise<AgentRelease>) {
		const host: DebugHost = {
			prepareLaunch: async (options, signal, onProgress) => {
				const roots = () => (vscode.workspace.workspaceFolders ?? [])
					.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
				const folders = roots();
				const check = () => {
					signal.throwIfAborted();
					if (!this.allowed() || this.lifecycle.busy || JSON.stringify(folders) !== JSON.stringify(roots())) {
						throw new DebugMcpError('PREPARE_UNAVAILABLE', 'Workspace, trust, MCP availability or debug lifecycle changed during preparation.');
					}
				};
				check();
				let lastStage: string | undefined;
				const result = await prepareDebugLaunch(options, {
					workspaceFolders: folders, extensionPath: this.context.extensionPath,
					listDevices: inner => { check(); return listDasDevices(this.context.extensionPath, inner); },
					onProgress: progress => {
						onProgress?.(progress);
						if (lastStage !== progress.stage) {
							this.output.appendLine(`[debug_prepare] ${JSON.stringify({
								stage: progress.stage, elapsedMs: progress.elapsedMs, path: progress.currentPath,
								entriesVisited: progress.partial.elf.entriesVisited, elfCandidates: progress.partial.elf.candidates.length,
								devices: progress.partial.devices.length,
							})}`);
							lastStage = progress.stage;
						}
					},
				}, signal);
				check();
				return result;
			},
			confirmPeripheralWrite: (approval, signal) => this.confirmPeripheralWrite(approval, signal),
			reportError: error => this.report(error),
			reserveStart: (id, signal, onProgress) => this.lifecycle.reserveStart(id, signal, progress => {
				onProgress?.(progress);
				this.output.appendLine(`[debug_start] ${JSON.stringify({ launchId: id, ...progress })}`);
			}),
			startSession: async (options, id) => {
				const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
				const config = await createMcpLaunchConfiguration(options, folders.map(folder => folder.uri.fsPath), id);
				await preparePeripheralLaunch(config, this.context.globalStorageUri.fsPath);
				this.lifecycle.setConfiguration(id, config);
				this.lifecycle.checkConfiguration(config);
				const folder = folders.find(folder => path.relative(folder.uri.fsPath, options.workspaceFolder) === '');
				if (!folder || !this.allowed()) { throw new DebugMcpError('START_UNAVAILABLE', 'The workspace changed or Debug MCP was disabled during startup.'); }
				let accepted: boolean;
				try {
					accepted = await vscode.debug.startDebugging(folder, config);
				} catch (error) {
					throw this.lifecycle.startFailure(id) ?? error;
				}
				const failure = this.lifecycle.startFailure(id);
				if (failure) { throw failure; }
				return accepted;
			},
			breakpoints: () => vscode.debug.breakpoints
				.filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
				.map(sourceBreakpoint),
			validateSource: source => validateWorkspaceSource(source,
				(vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)),
			addBreakpoint: (source, line) => {
				const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(line - 1, 0)));
				vscode.debug.addBreakpoints([bp]);
				return sourceBreakpoint(bp);
			},
			removeBreakpoint: id => {
				const bp = vscode.debug.breakpoints.find(bp => bp.id === id && bp instanceof vscode.SourceBreakpoint);
				if (!bp) { throw new DebugMcpError('BREAKPOINT_NOT_FOUND', 'Source breakpoint no longer exists.'); }
				vscode.debug.removeBreakpoints([bp]);
			},
			stopSession: id => {
				const session = this.sessions.get(id) ?? this.endedSessions.get(id);
				if (!session) { throw new DebugMcpError('SESSION_NOT_FOUND', 'The debug session no longer exists.'); }
				return this.stopSession(session);
			},
		};
		this.controller = new DebugController(host);
		this.subscriptions.push(
			vscode.debug.registerDebugAdapterTrackerFactory('aurix-tcf', {
				createDebugAdapterTracker: session => {
					this.sessions.set(session.id, session);
					this.endedSessions.delete(session.id);
					this.controller.addSession({
						id: session.id, name: session.name, workspace: session.workspaceFolder?.uri.fsPath,
						program: typeof session.configuration.program === 'string' ? session.configuration.program : undefined,
						targetDevice: typeof session.configuration.targetDevice === 'string' ? session.configuration.targetDevice : undefined,
						launchId: typeof session.configuration.__aurixMcpLaunchId === 'string' ? session.configuration.__aurixMcpLaunchId : undefined,
						request: (command, args) => session.customRequest(command, args),
					});
					return {
						onWillReceiveMessage: message => this.controller.observeRequest(session.id, message),
						onDidSendMessage: message => this.controller.observeMessage(session.id, message),
						onError: error => {
							this.report(error);
							this.controller.endSession(session.id, error);
						},
						onExit: () => {
							this.controller.endSession(session.id);
						},
					};
				},
			}),
			vscode.debug.onDidTerminateDebugSession(session => {
				if (session.type !== 'aurix-tcf') { return; }
				this.controller.endSession(session.id);
				this.sessions.delete(session.id);
				this.endedSessions.set(session.id, session);
				if (this.endedSessions.size > 64) {
					const oldest = this.endedSessions.keys().next().value;
					if (oldest !== undefined) { this.endedSessions.delete(oldest); }
				}
			}),
			vscode.lm.registerMcpServerDefinitionProvider('aurix-tcf.debugMcp', {
				onDidChangeMcpServerDefinitions: this.changes.event,
				provideMcpServerDefinitions: async () => this.allowed() ? [await this.definition()] : [],
				resolveMcpServerDefinition: async () => {
					if (!this.allowed()) {
						throw new Error('Debug MCP requires a trusted local Windows workspace and must not be explicitly disabled in settings.');
					}
					return this.definition();
				},
			}),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (!event.affectsConfiguration('aurix-tcf.mcp.enabled')) { return; }
				if (!this.allowed()) { void this.stopEndpoint().catch(error => this.report(error)); }
				this.changes.fire();
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.changes.fire()),
		);
	}

	private async confirmPeripheralWrite(approval: PeripheralWriteApproval, signal: AbortSignal): Promise<(() => void) | undefined> {
		const session = this.sessions.get(approval.sessionId);
		const configuration = JSON.stringify(session?.configuration);
		const validate = () => {
			signal.throwIfAborted();
			if (!this.allowed() || !session || this.sessions.get(approval.sessionId) !== session ||
				session.name !== approval.sessionName || session.configuration.targetDevice !== approval.targetDevice ||
				session.workspaceFolder?.uri.fsPath !== approval.workspace || JSON.stringify(session.configuration) !== configuration) {
				throw new DebugMcpError('STATE_CHANGED', 'Peripheral write approval no longer matches the live session, target, configuration or trusted MCP environment.');
			}
		};
		validate();
		if (this.confirmingWrite) { throw new DebugMcpError('BUSY', 'Dismiss the previous peripheral write confirmation before requesting another.'); }
		this.confirmingWrite = true;
		try {
			const write = { title: 'Write once' }, cancel = { title: 'Cancel', isCloseAffordance: true };
			const detail = [
				`Device: ${JSON.stringify(approval.targetDevice)}`,
				`Session: ${JSON.stringify(approval.sessionName)} (${JSON.stringify(approval.sessionId)})`,
				`Workspace: ${JSON.stringify(approval.workspace ?? '')}`,
				`Thread: ${approval.threadId} (${JSON.stringify(approval.contextId)})`,
				`Register: ${JSON.stringify(approval.name)}`,
				`Address: ${approval.address}; width: ${approval.size * 8} bits`,
				`Value to write: ${approval.valueHex}`,
				'One whole-register native write. It may have hardware side effects. No old-value read, read-modify-write, verification read or automatic retry.',
			].join('\n');
			const selected = await vscode.window.showWarningMessage('AURIX Debug MCP requests one peripheral-register write.',
				{ modal: true, detail }, write, cancel);
			validate();
			return selected === write ? validate : undefined;
		} finally { this.confirmingWrite = false; }
	}

	private async stopSession(session: vscode.DebugSession): Promise<AgentRelease> {
		const release = this.lifecycle.reserveRelease(session.id);
		let subscription: vscode.Disposable | undefined;
		let timer: NodeJS.Timeout | undefined;
		try {
			if (this.sessions.has(session.id)) {
				const ended = new Promise<void>((resolve, reject) => {
					subscription = vscode.debug.onDidTerminateDebugSession(candidate => {
						if (candidate.id === session.id) { resolve(); }
					});
					timer = setTimeout(() => reject(new DebugMcpError('STOP_INCOMPLETE', 'VS Code did not confirm session termination within 60 seconds.')), 60000);
				});
				await Promise.all([vscode.debug.stopDebugging(session), ended]);
			}
			return await this.releaseAgent(session);
		} catch (error) {
			this.report(error);
			throw error;
		} finally {
			subscription?.dispose();
			if (timer) { clearTimeout(timer); }
			release();
		}
	}

	private allowed(): boolean {
		return !this.disposed && process.platform === 'win32' && !vscode.env.remoteName &&
			vscode.workspace.isTrusted && vscode.workspace.getConfiguration('aurix-tcf').get<boolean>('mcp.enabled', true);
	}

	private report(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.output.appendLine(message);
		void vscode.window.showErrorMessage(`AURIX Debug MCP: ${message}`);
	}

	private async definition(): Promise<vscode.McpHttpServerDefinition> {
		await this.stopping;
		if (!this.allowed()) { throw new Error('Debug MCP is disabled or unavailable in this workspace.'); }
		if (!this.starting) {
			this.starting = this.startEndpoint();
		}
		const starting = this.starting;
		let endpoint: DebugMcpHttpServer;
		try { endpoint = await starting; }
		catch (error) {
			if (this.starting === starting) { this.starting = undefined; }
			this.report(error);
			throw error;
		}
		if (this.starting !== starting) { throw new Error('Debug MCP settings changed during startup. Refresh MCP servers.'); }
		if (!this.allowed()) { await this.stopEndpoint(); throw new Error('Debug MCP was disabled during startup.'); }
		return new vscode.McpHttpServerDefinition('AURIX Debug MCP', vscode.Uri.parse(endpoint.url),
			{ Authorization: `Bearer ${endpoint.token}` }, this.context.extension.packageJSON.version);
	}

	private async startEndpoint(): Promise<DebugMcpHttpServer> {
		const endpoint = new DebugMcpHttpServer(this.controller, this.context.extension.packageJSON.version,
			() => this.allowed(), message => this.output.appendLine(message));
		this.endpoint = endpoint;
		try {
			await endpoint.listen();
			this.output.appendLine(`Listening on ${endpoint.url}. Shared VS Code sessions; controlled no-flash startup enabled.`);
			return endpoint;
		} catch (error) {
			await endpoint.close();
			this.endpoint = undefined;
			throw error;
		}
	}

	private stopEndpoint(): Promise<void> {
		this.controller.cancelPending(new DebugMcpError('MCP_DISABLED', 'Debug MCP is stopping; pending operations and write approvals were cancelled.'));
		const starting = this.starting;
		this.starting = undefined;
		const stopping = this.stopping.then(async () => {
			if (starting) {
				try { await starting; } catch (error) { this.output.appendLine(`MCP startup failed during shutdown: ${String(error)}`); }
			}
			const endpoint = this.endpoint;
			this.endpoint = undefined;
			await endpoint?.close();
		});
		// Keep the sequencing barrier usable after a failed close, but reject the caller.
		this.stopping = stopping.catch(error => this.output.appendLine(`MCP shutdown failed: ${String(error)}`));
		return stopping;
	}

	close(): Promise<void> {
		this.disposed = true;
		this.controller.dispose();
		return this.stopEndpoint();
	}

	dispose(): void {
		void this.close().catch(error => this.output.appendLine(`MCP shutdown failed: ${String(error)}`)).finally(() => {
			for (const subscription of this.subscriptions) { subscription.dispose(); }
		});
	}
}
