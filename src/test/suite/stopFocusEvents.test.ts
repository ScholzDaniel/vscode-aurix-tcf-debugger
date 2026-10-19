import * as assert from 'assert';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { AurixTCFDebugSession } from '../../debugProvider';

class FocusSession extends AurixTCFDebugSession {
	readonly messages: DebugProtocol.Event[] = [];

	constructor() { super(false); }

	override sendEvent(event: DebugProtocol.Event): void { this.messages.push(event); }
	override sendResponse(_response: DebugProtocol.Response): void {}

	stopped(reason: string, threadId: number, allThreadsStopped = false): void {
		this.sendStoppedEvent(reason, threadId, { allThreadsStopped });
	}

	suspend(contextId: string, reason: string): void {
		this.onContextSuspended({ id: contextId, reason, pc: 0, data: {} });
	}

	frame(id: number, threadId: number, source?: { path: string; line: number }): void {
		this.rememberFrameMeta(id, threadId, `core${threadId}`, undefined, source);
	}

	resume(threadId: number): void { this.onThreadResumed(threadId); }

	async source(frameId: number, threadId: number): Promise<unknown> {
		const response: DebugProtocol.Response = {
			seq: 1, type: 'response', command: 'aurix-tcf/frameSource', request_seq: 1, success: true
		};
		await this.customRequestAsync(response.command, response, { frameId, threadId });
		return response.body;
	}
}

suite('Stopped core and source focus events (offline)', () => {
	test('primary breakpoint, step, entry and explicit pause events use the DAP focus hint', () => {
		const session = new FocusSession();
		for (const reason of ['breakpoint', 'step', 'entry', 'pause']) {
			session.stopped(reason, 2, true);
			const event = session.messages[session.messages.length - 1];
			assert.strictEqual(event.event, 'stopped');
			assert.deepStrictEqual(event.body, {
				reason, threadId: 2, allThreadsStopped: true, preserveFocusHint: false
			});
			assert.strictEqual('preserveFocus' in event.body, false);
		}
	});

	test('instruction/source step focuses its core without claiming all other cores stopped', () => {
		const session = new FocusSession();
		session.suspend('S0.D0.C1', 'Step');
		const stops = session.messages.filter(event => event.event === 'stopped');
		assert.strictEqual(stops.length, 1);
		assert.deepStrictEqual(stops[0].body, { reason: 'step', threadId: 2, preserveFocusHint: false });
		assert.ok(session.messages.every(event => event.event !== 'aurix-tcf/sourceLocation'));
	});

	test('a late sibling suspension updates its state without replacing the selected source/core', async () => {
		const session = new FocusSession();
		session.suspend('S0.D0.C0', 'Step');
		session.suspend('S0.D0.C2', 'Suspended');
		await new Promise(resolve => setTimeout(resolve, 60));
		const stops = session.messages.filter(event => event.event === 'stopped');
		assert.deepStrictEqual(stops.map(event => event.body), [
			{ reason: 'step', threadId: 1, preserveFocusHint: false },
			{ reason: 'pause', threadId: 3, preserveFocusHint: true }
		]);
		assert.ok(session.messages.every(event => event.event !== 'aurix-tcf/sourceLocation'),
			'Source must follow the selected DAP stack frame, not an independent source-opening event');
	});

	test('source lookup uses the exact selected frame rather than a source-file-to-core guess', async () => {
		const session = new FocusSession();
		session.frame(10, 1, { path: 'shared.c', line: 20 });
		session.frame(11, 2, { path: 'shared.c', line: 40 });
		assert.deepStrictEqual(await session.source(11, 2), { source: { path: 'shared.c', line: 40 } });
		assert.deepStrictEqual(await session.source(10, 1), { source: { path: 'shared.c', line: 20 } });
		session.frame(12, 2);
		assert.deepStrictEqual(await session.source(12, 2), { source: undefined });
	});

	test('source lookup rejects wrong-core and expired references even when frame IDs are reused', async () => {
		const session = new FocusSession();
		session.frame(10, 1, { path: 'core0.c', line: 20 });
		await assert.rejects(session.source(10, 2), /expired frame or a different core/);
		session.resume(1);
		await assert.rejects(session.source(10, 1), /expired frame or a different core/);
		session.frame(10, 2, { path: 'core1.c', line: 40 });
		await assert.rejects(session.source(10, 1), /expired frame or a different core/);
		assert.deepStrictEqual(await session.source(10, 2), { source: { path: 'core1.c', line: 40 } });
		await assert.rejects(session.source(0.5, 2), /requires integer/);
	});
});
