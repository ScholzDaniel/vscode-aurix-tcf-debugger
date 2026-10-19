import * as assert from 'assert';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { DapEvents } from '../dapEvents';

function stopped(threadId = 1): DebugProtocol.StoppedEvent {
	return { seq: 0, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId } };
}

suite('DAP event synchronization (offline)', () => {
	test('finds an event arriving before the request response', async () => {
		const events = new DapEvents();
		const mark = events.mark();
		const expected = stopped();
		events.record(expected);
		assert.strictEqual(await events.waitFor('stopped', mark, 100), expected);
		assert.strictEqual(events.pendingCount, 0);
	});

	test('ignores stale events and events for another thread', async () => {
		const events = new DapEvents();
		events.record(stopped());
		const mark = events.mark();
		const pending = events.waitFor('stopped', mark, 100, (event) => event.body.threadId === 1);
		events.record(stopped(2));
		assert.strictEqual(events.pendingCount, 1);
		const expected = stopped();
		events.record(expected);
		assert.strictEqual(await pending, expected);
		assert.strictEqual(events.pendingCount, 0);
		assert.deepStrictEqual(events.since(mark, 'stopped').map(event => event.body.threadId), [2, 1]);
		assert.deepStrictEqual(events.since(mark, 'continued'), []);
	});

	test('times out and removes the waiter', async () => {
		const events = new DapEvents();
		await assert.rejects(events.waitFor('stopped', events.mark(), 5), /Timed out waiting for DAP 'stopped'/);
		assert.strictEqual(events.pendingCount, 0);
	});

	test('rejects pending and future waits when the session ends', async () => {
		const events = new DapEvents();
		const pending = assert.rejects(events.waitFor('stopped', 0, 100), /connection lost/);
		events.close(new Error('connection lost'));
		await pending;
		await assert.rejects(events.waitFor('stopped', 0, 100), /connection lost/);
		assert.strictEqual(events.pendingCount, 0);
	});

	test('delivers an event to multiple waiters', async () => {
		const events = new DapEvents();
		const first = events.waitFor('stopped', 0, 100);
		const second = events.waitFor('stopped', 0, 100);
		const expected = stopped();
		events.record(expected);
		assert.deepStrictEqual(await Promise.all([first, second]), [expected, expected]);
	});

	test('bounds retained event history', async () => {
		const events = new DapEvents(2);
		events.record(stopped(1));
		events.record(stopped(2));
		events.record(stopped(3));
		await assert.rejects(events.waitFor('stopped', 0, 5, (event) => event.body.threadId === 1), /Timed out/);
		const latest = await events.waitFor('stopped', 0, 100, (event) => event.body.threadId === 3);
		assert.strictEqual(latest.body.threadId, 3);
	});

	test('rejects a throwing predicate without breaking event delivery', async () => {
		const events = new DapEvents();
		const pending = assert.rejects(events.waitFor('stopped', 0, 100, () => {
			throw new Error('invalid assertion');
		}), /invalid assertion/);
		events.record(stopped());
		await pending;
		assert.strictEqual(events.pendingCount, 0);
	});
});