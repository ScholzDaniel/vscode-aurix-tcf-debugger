import * as assert from 'assert';
import { BreakpointStopBarrier, CoreStopState } from '../../breakpointStopBarrier';

const contexts = ['core0', 'core1', 'core2'];
const states = (...suspended: boolean[]): CoreStopState[] => suspended.map((value, index) => ({
	id: contexts[index], suspended: value
}));

function fixture(read: () => Promise<CoreStopState[]>, timeout = 0) {
	const events: Array<{ context: string; allStopped: boolean; refocus: boolean }> = [];
	const warnings: string[] = [];
	const barrier = new BreakpointStopBarrier(read,
		(context, allStopped, refocus) => events.push({ context, allStopped, refocus }),
		message => warnings.push(message), timeout);
	return { barrier, events, warnings };
}

suite('Verified breakpoint all-stop notification (offline)', () => {
	test('waits for every core and preserves the actual breakpoint core', async () => {
		let reads = 0;
		const test = fixture(async () => {
			assert.deepStrictEqual(test.events, [], 'Notification escaped before verification');
			return ++reads === 1 ? states(false, true, true) : states(true, true, true);
		}, 1000);
		await test.barrier.notify('core1', contexts);
		assert.strictEqual(reads, 2);
		assert.deepStrictEqual(test.events, [{ context: 'core1', allStopped: true, refocus: false }]);
		assert.deepStrictEqual(test.warnings, []);
	});

	test('does not treat empty, missing-core or running-core snapshots as all-stop', async () => {
		for (const snapshot of [[], states(true, true), states(false, true, true)]) {
			const test = fixture(async () => snapshot);
			await test.barrier.notify('core1', contexts);
			assert.strictEqual(test.events.length, 1);
			assert.strictEqual(test.events[0].allStopped, false);
			assert.strictEqual(test.warnings.length, 1, 'Incomplete state must be reported explicitly');
		}
	});

	test('includes the hit core even when context discovery omitted it', async () => {
		const test = fixture(async () => states(true, true));
		await test.barrier.notify('core2', ['core0', 'core1']);
		assert.strictEqual(test.events[0].allStopped, false);
		assert.match(test.warnings[0], /core2/);
	});

	test('remembers discovered cores if a later snapshot drops one', async () => {
		let reads = 0;
		const test = fixture(async () => ++reads === 1 ? states(true, true, false) : states(true, true), 30);
		await test.barrier.notify('core1', ['core0', 'core1']);
		assert.ok(reads >= 2);
		assert.strictEqual(test.events[0].allStopped, false);
		assert.match(test.warnings[0], /core2/);
	});

	test('query failure reports an error and retains only the original per-thread breakpoint', async () => {
		const test = fixture(async () => { throw new Error('transport failed'); });
		await test.barrier.notify('core1', contexts);
		assert.deepStrictEqual(test.events, [{ context: 'core1', allStopped: false, refocus: false }]);
		assert.match(test.warnings[0], /transport failed/);
	});

	test('a fresh running hit core is not announced as stopped', async () => {
		const test = fixture(async () => states(true, false, true));
		await test.barrier.notify('core1', contexts);
		assert.deepStrictEqual(test.events, []);
		assert.strictEqual(test.warnings.length, 1);
	});

	test('coalesces status and run-control notifications before and after completion', async () => {
		let finish!: (value: CoreStopState[]) => void;
		const test = fixture(() => new Promise(resolve => { finish = resolve; }));
		const pending = test.barrier.notify('core1', contexts);
		assert.strictEqual(test.barrier.waiting, true);
		await test.barrier.notify('core1', contexts);
		assert.strictEqual(test.events.length, 0);
		finish(states(true, true, true));
		await pending;
		await test.barrier.notify('core1', contexts);
		assert.strictEqual(test.events.length, 1);
		assert.strictEqual(test.barrier.waiting, false);
	});

	test('resume/reset/disconnect invalidation discards an in-flight successful snapshot', async () => {
		let finish!: (value: CoreStopState[]) => void;
		const test = fixture(() => new Promise(resolve => { finish = resolve; }));
		const pending = test.barrier.notify('core1', contexts);
		test.barrier.invalidate();
		finish(states(true, true, true));
		await pending;
		assert.deepStrictEqual(test.events, []);
		assert.deepStrictEqual(test.warnings, []);
	});

	test('an invalidated query error cannot emit a late warning or stop', async () => {
		let fail!: (error: Error) => void;
		const test = fixture(() => new Promise((_resolve, reject) => { fail = reject; }));
		const pending = test.barrier.notify('core1', contexts);
		test.barrier.invalidate();
		fail(new Error('old disconnected channel'));
		await pending;
		assert.deepStrictEqual(test.events, []);
		assert.deepStrictEqual(test.warnings, []);
	});

	test('a new stop survives completion of a cancelled previous generation', async () => {
		const replies: Array<(value: CoreStopState[]) => void> = [];
		const test = fixture(() => new Promise(resolve => replies.push(resolve)));
		const old = test.barrier.notify('core1', contexts);
		test.barrier.invalidate();
		const current = test.barrier.notify('core1', contexts);
		replies[0](states(true, true, true));
		await old;
		assert.strictEqual(test.barrier.waiting, true);
		replies[1](states(true, true, true));
		await current;
		assert.strictEqual(test.events.length, 1);
		assert.strictEqual(test.barrier.waiting, false);
	});

	test('refocus rechecks state instead of reusing an earlier all-stop claim', async () => {
		let snapshot = states(true, true, true);
		const test = fixture(async () => snapshot);
		await test.barrier.notify('core1', contexts);
		snapshot = states(false, true, true);
		await test.barrier.notify('core1', contexts, true);
		assert.deepStrictEqual(test.events.map(event => [event.allStopped, event.refocus]), [[true, false], [false, true]]);
		assert.strictEqual(test.warnings.length, 1);
	});
});
