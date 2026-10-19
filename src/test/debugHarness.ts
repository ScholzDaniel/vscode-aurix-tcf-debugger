import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { DapEvents } from './dapEvents';
import { HardwareProfile, loadHardwareProfile, SourcePoint } from './hardwareProfile';

const profile = loadHardwareProfile();

async function timed<T>(operation: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			Promise.resolve(operation),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

export function hardwareTest(name: string, run: (profile: HardwareProfile, context: Mocha.Context) => Promise<void>): void {
	test(name, async function () {
		if (!profile) {
			this.skip();
			return;
		}
		this.timeout(profile.launchTimeoutMs + 30 * profile.timeoutMs);
		await run(profile, this);
	});
}

export interface SessionOptions {
	startupPoint?: SourcePoint;
	breakpoint?: { point: SourcePoint; enabled: boolean };
}

export class DebugHarness {
	readonly events = new DapEvents();
	readonly name = `AURIX test ${crypto.randomUUID()}`;
	private session?: vscode.DebugSession;
	private targetThreadId?: number;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly originalBreakpoints = [...vscode.debug.breakpoints];
	private terminated = false;
	private closing = false;
	private adapterFailure?: Error;
	private resolveTermination!: () => void;
	private readonly termination = new Promise<void>(resolve => { this.resolveTermination = resolve; });
	private readonly logFile: string;
	private readonly resultFile: string;
	private startedAt = Date.now();

	constructor(readonly profile: HardwareProfile, readonly caseName: string) {
		const directory = path.resolve(process.env.AURIX_TEST_RESULTS || 'test-results');
		fs.mkdirSync(directory, { recursive: true });
		const basename = `${caseName.replace(/[^a-zA-Z0-9.-]+/g, '_')}-${crypto.randomUUID()}`;
		this.logFile = path.join(directory, `${basename}.dap.jsonl`);
		this.resultFile = path.join(directory, `${basename}.result.json`);
	}

	private log(direction: string, message: unknown): void {
		fs.appendFileSync(this.logFile, JSON.stringify({ time: new Date().toISOString(), direction, message }) + '\n');
	}

	recordEvidence(label: string, data: unknown): void {
		this.log('evidence', { label, data });
	}

	get threadId(): number {
		assert.notStrictEqual(this.targetThreadId, undefined, 'Target thread has not been discovered');
		return this.targetThreadId!;
	}

	async start(options: SessionOptions = {}): Promise<void> {
		this.startedAt = Date.now();
		assert.ok(!vscode.debug.activeDebugSession, 'Test host already has an active debug session');
		const extension = vscode.extensions.getExtension('zehuazhang.vscode-aurix-tcf-debug');
		assert.ok(extension, 'AURIX TCF extension is missing from the test host');
		await timed(extension.activate(), this.profile.timeoutMs, 'Extension activation');
		this.disposables.push(vscode.debug.onDidTerminateDebugSession(session => {
			if (session.id === this.session?.id) {
				if (!this.closing) {
					this.adapterFailure ??= new Error('Debug session terminated unexpectedly');
				}
				this.terminated = true;
				this.resolveTermination();
				this.events.close(this.adapterFailure);
			}
		}));
		this.disposables.push(vscode.debug.registerDebugAdapterTrackerFactory('aurix-tcf', {
			createDebugAdapterTracker: session => {
				if (session.name !== this.name) {
					return undefined;
				}
				this.session = session;
				return {
					onWillReceiveMessage: message => this.log('request', message),
					onDidSendMessage: message => {
						this.log('adapter', message);
						if (message.type === 'event' && message.event !== 'output') {
							this.events.record(message);
						}
					},
					onError: error => {
						this.log('error', String(error));
						this.adapterFailure = error;
						this.events.close(error);
					},
					onExit: (code, signal) => {
						this.log('exit', { code, signal });
						if (!this.closing || (code !== undefined && code !== 0)) {
							this.adapterFailure ??= new Error(`Unexpected adapter exit: code=${code}, signal=${signal}`);
							this.events.close(this.adapterFailure);
						}
					}
				};
			}
		}));
		this.disposables.push(vscode.debug.onDidChangeActiveStackItem(item => {
			if (!item || item.session.id === this.session?.id) {
				this.recordEvidence('ui-active-stack-item', item ? {
					threadId: item.threadId, frameId: 'frameId' in item ? item.frameId : undefined
				} : null);
			}
		}));
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
			this.recordEvidence('ui-active-source', editor?.document.uri.fsPath ?? null);
		}));
		vscode.debug.removeBreakpoints(this.originalBreakpoints);
		if (options.breakpoint) {
			const { point, enabled } = options.breakpoint;
			vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(
				new vscode.Location(vscode.Uri.file(point.source), new vscode.Position(point.line - 1, 0)), enabled
			)]);
		}
		const folder = vscode.workspace.workspaceFolders?.find(folder =>
			path.resolve(folder.uri.fsPath).toLowerCase() === this.profile.workspace.toLowerCase());
		assert.ok(folder, 'The profile workspace must be open in the test host');
		const config: vscode.DebugConfiguration = {
			type: 'aurix-tcf', request: 'launch', name: this.name,
			program: this.profile.program, workspace: this.profile.workspace,
			targetDevice: this.profile.targetDevice, core: this.profile.core,
			agentPath: this.profile.agentPath, autoStartAgent: this.profile.autoStartAgent,
			host: this.profile.host, port: this.profile.port,
			entryFunction: this.profile.entry.function, stopOnEntry: false,
			resumeOtherCoresOnEntry: false, flashDownload: false, svdFile: this.profile.svdFile,
			instructionStepping: false, liveWatchEnabled: false, debugTCFMessages: true,
			internal: { debugTCFMessages: true }
		};
		this.log('profile', this.profile);
		const mark = this.events.mark();
		assert.ok(await timed(vscode.debug.startDebugging(folder, config), this.profile.launchTimeoutMs, 'Debug launch'), 'Debug launch was rejected');
		assert.ok(this.session, 'No DAP tracker was attached to the launched session');
		const threads = await this.threads();
		this.targetThreadId = threads[this.profile.core].id;
		await this.expectStop(mark, options.startupPoint ?? this.profile.entry, ['breakpoint', 'entry'], this.profile.launchTimeoutMs, true);
	}

	async request<T>(command: string, args?: unknown): Promise<T> {
		assert.ok(this.session && !this.terminated, `Cannot send ${command}: debug session is not active`);
		return timed(this.session.customRequest(command, args), this.profile.timeoutMs, `DAP ${command}`);
	}

	async threads(): Promise<DebugProtocol.Thread[]> {
		const response = await this.request<DebugProtocol.ThreadsResponse['body']>('threads');
		assert.ok(Array.isArray(response?.threads), 'Missing threads response');
		const ordered = this.profile.threadPatterns.map(pattern => {
			const matching = response.threads.filter(thread => new RegExp(pattern, 'i').test(thread.name));
			assert.strictEqual(matching.length, 1, `Expected one core matching '${pattern}', got ${JSON.stringify(response.threads)}`);
			return matching[0];
		});
		assert.strictEqual(new Set(ordered.map(thread => thread.id)).size, ordered.length, 'Core patterns match the same thread');
		return ordered;
	}

	async frames(threadId = this.threadId): Promise<DebugProtocol.StackFrame[]> {
		const response = await this.request<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId, startFrame: 0, levels: 20 });
		assert.ok(response?.stackFrames?.length, `No stack frames for thread ${threadId}`);
		return response.stackFrames;
	}

	async assertLocation(point: SourcePoint, threadId = this.threadId): Promise<void> {
		const [frame] = await this.frames(threadId);
		assert.strictEqual(frame.name.split('(')[0].trim(), point.function, `Unexpected function: ${JSON.stringify(frame)}`);
		assert.ok(frame.source?.path, 'Top frame has no source path');
		assert.strictEqual(path.resolve(frame.source.path).toLowerCase(), path.resolve(point.source).toLowerCase(), 'Unexpected source file');
		assert.strictEqual(frame.line, point.line, `Unexpected source line in ${point.source}`);
	}

	async assertFocusedThread(threadId = this.threadId, source?: SourcePoint): Promise<void> {
		await this.frames(threadId);
		const deadline = Date.now() + this.profile.timeoutMs;
		let stableSince: number | undefined;
		while (Date.now() < deadline) {
			const item = vscode.debug.activeStackItem;
			const editor = vscode.window.activeTextEditor;
			const sourceMatches = !source || vscode.window.visibleTextEditors.some(visible =>
				path.resolve(visible.document.uri.fsPath).toLowerCase() === path.resolve(source.source).toLowerCase());
			const matches = item?.session.id === this.session?.id && item?.threadId === threadId && 'frameId' in item && sourceMatches;
			if (matches) {
				stableSince ??= Date.now();
				if (Date.now() - stableSince >= 500) {
					this.recordEvidence('ui-focus-verified', {
						threadId, frameId: item.frameId, source: source?.source ?? editor?.document.uri.fsPath,
						stableMs: Date.now() - stableSince
					});
					return;
				}
			} else {
				stableSince = undefined;
			}
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		const actual = vscode.debug.activeStackItem;
		assert.fail(`CALL STACK/source focus did not stabilize on thread ${threadId}, source=${source?.source}; actual=${
			JSON.stringify(actual ? { threadId: actual.threadId, frameId: 'frameId' in actual ? actual.frameId : undefined } : null)
		}, visibleSources=${JSON.stringify(vscode.window.visibleTextEditors.map(editor => editor.document.uri.fsPath))}`);
	}

	async coreProgramCounter(frameId: number): Promise<number> {
		const scopes = await this.request<DebugProtocol.ScopesResponse['body']>('scopes', { frameId });
		const registers = scopes?.scopes.find(scope => scope.name === 'CORE Registers');
		assert.ok(registers && registers.variablesReference > 0, 'Core register scope missing');
		const read = async (variablesReference: number): Promise<DebugProtocol.Variable[]> => {
			const result = await this.request<DebugProtocol.VariablesResponse['body']>('variables', { variablesReference });
			assert.ok(Array.isArray(result?.variables), 'Missing register variables array');
			for (const variable of result.variables) {
				assert.ok(variable.name.length > 0, 'Unnamed register variable');
				assert.strictEqual(typeof variable.value, 'string', 'Invalid register value');
				assert.ok(Number.isInteger(variable.variablesReference) && variable.variablesReference >= 0, 'Invalid register child reference');
			}
			return result.variables;
		};
		const roots = await read(registers.variablesReference);
		const core = roots.find(variable => /^(core|core registers)$/i.test(variable.name));
		assert.ok(core && core.variablesReference > 0, 'CORE group missing; refusing to traverse peripheral groups');
		const queue = [core.variablesReference];
		const visited = new Set<number>();
		let pc: DebugProtocol.Variable | undefined;
		while (queue.length && !pc) {
			const reference = queue.shift()!;
			assert.ok(!visited.has(reference) && visited.size < 16, 'Cyclic or unexpectedly deep core register tree');
			visited.add(reference);
			const children = await read(reference);
			pc = children.find(variable => /^pc$/i.test(variable.name));
			queue.push(...children.filter(variable => variable.variablesReference > 0).map(variable => variable.variablesReference));
		}
		assert.ok(pc, 'PC register missing');
		assert.match(pc.value, /^0x[0-9a-f]{8}$/i, 'Expected four raw PC bytes');
		// Register values expose raw bytes; TriCore is little-endian.
		return Buffer.from(pc.value.slice(2), 'hex').readUInt32LE();
	}

	async expectStop(after: number, point?: SourcePoint, reasons = ['breakpoint'], timeoutMs = this.profile.timeoutMs, ignoreStartupPause = false): Promise<void> {
		// A reset-halted target can emit pause before startup breakpoints are configured.
		const event = await this.events.waitFor('stopped', after, timeoutMs, event =>
			event.body?.threadId === this.threadId && !(ignoreStartupPause && event.body.reason === 'pause'));
		assert.ok(reasons.includes(event.body.reason), `Unexpected stop reason: ${JSON.stringify(event.body)}`);
		if (point) {
			await this.assertLocation(point);
		} else {
			await this.frames();
		}
	}

	async setBreakpoints(source: string, lines: number[]): Promise<void> {
		const mark = this.events.mark();
		const response = await this.request<DebugProtocol.SetBreakpointsResponse['body']>('setBreakpoints', {
			source: { path: source }, breakpoints: lines.map(line => ({ line }))
		});
		assert.strictEqual(response?.breakpoints?.length, lines.length, 'Wrong breakpoint count');
		for (const line of lines) {
			const breakpoint = response.breakpoints.find(breakpoint => breakpoint.line === line);
			assert.ok(breakpoint, `Breakpoint moved away from fixture line ${line}`);
			if (!breakpoint.verified) {
				assert.notStrictEqual(breakpoint.id, undefined, 'Unverified breakpoint has no ID');
				await this.events.waitFor('breakpoint', mark, this.profile.timeoutMs, event =>
					event.body?.breakpoint?.id === breakpoint.id && event.body.breakpoint.verified === true);
			}
		}
	}

	async resume(): Promise<number> {
		const mark = this.events.mark();
		await this.request('continue', { threadId: this.threadId });
		await this.events.waitFor('continued', mark, this.profile.timeoutMs, event =>
			event.body?.threadId === this.threadId || event.body?.allThreadsContinued === true);
		return mark;
	}

	async runTo(point: SourcePoint): Promise<void> {
		await this.setBreakpoints(point.source, [point.line]);
		const mark = this.events.mark();
		await this.request('continue', { threadId: this.threadId });
		await this.expectStop(mark, point);
		await this.setBreakpoints(point.source, []);
	}

	async pauseAll(): Promise<void> {
		const mark = this.events.mark();
		await this.request('pause', { threadId: this.threadId });
		await this.expectStop(mark, undefined, ['pause']);
		for (const thread of await this.threads()) {
			await this.frames(thread.id);
		}
	}

	async close(): Promise<void> {
		this.closing = true;
		try {
			if (this.session && !this.terminated) {
				await timed(vscode.debug.stopDebugging(this.session), this.profile.timeoutMs, 'Debug stop');
				await timed(this.termination, this.profile.timeoutMs, 'Session termination event');
			}
		} finally {
			this.events.close();
			for (const disposable of this.disposables) {
				disposable.dispose();
			}
			vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
			vscode.debug.addBreakpoints(this.originalBreakpoints);
		}
		if (this.adapterFailure) {
			throw this.adapterFailure;
		}
	}

	writeResult(error?: unknown): void {
		fs.writeFileSync(this.resultFile, JSON.stringify({
			case: this.caseName, status: error ? 'FAIL' : 'PASS', durationMs: Date.now() - this.startedAt,
			error: error instanceof Error ? error.stack : error ? String(error) : undefined,
			dapLog: path.basename(this.logFile), fixtureVersion: this.profile.fixtureVersion,
			compilerVersion: this.profile.compilerVersion, agentVersion: this.profile.agentVersion
		}, null, 2) + '\n');
	}
}

export async function withDebugSession(
	profile: HardwareProfile,
	caseName: string,
	run: (session: DebugHarness) => Promise<void>,
	options?: SessionOptions
): Promise<void> {
	const session = new DebugHarness(profile, caseName);
	let failure: unknown;
	try {
		await session.start(options);
		await run(session);
	} catch (error) {
		failure = error;
	} finally {
		try {
			await session.close();
		} catch (error) {
			failure = failure ? new AggregateError([failure, error], 'Test and session cleanup failed') : error;
		}
		session.writeResult(failure);
	}
	if (failure) {
		throw failure;
	}
}