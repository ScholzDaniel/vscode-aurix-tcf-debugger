import * as assert from 'assert';
import { hardwareTest, withDebugSession } from '../debugHarness';
import { StateObserver } from '../nativeStateObserver';

suite('Cross-core breakpoint suspension (hardware)', () => {
	for (const core of [0, 1, 2]) {
		hardwareTest(`[REG multicore-stop-${core}] CPU${core} breakpoint suspends every core across three Continue cycles`, async profile => {
			assert.strictEqual(profile.threadPatterns.length, 3, 'This batch requires a calibrated three-core fixture');
			assert.ok(profile.coreBreakpoints, 'Configure coreBreakpoints in threadPatterns order before running this batch');
			const point = profile.coreBreakpoints[core];
			await withDebugSession(profile, `REG-multicore-stop-${core}`, async session => {
				const observer = new StateObserver(session);
				try {
					await observer.connect(profile.host, profile.port);
					const threads = await session.threads();
					for (let cycle = 1; cycle <= 3; cycle++) {
						const resumed = await session.resume();
						for (const thread of threads) {
							await session.events.waitFor('continued', resumed, profile.timeoutMs, event =>
								event.body?.threadId === thread.id || event.body?.allThreadsContinued === true);
						}
						const running = await observer.snapshot(`cycle-${cycle}-running`);
						assert.deepStrictEqual(running.map(core => core.state.suspended), [false, false, false],
							'Every core must really be running before installing the breakpoint');

						const mark = session.events.mark();
						await session.setBreakpoints(point.source, [point.line]);
						// Sibling-core pause events can precede the actual breakpoint-core notification.
						const stop = await session.events.waitFor('stopped', mark, profile.timeoutMs,
							event => event.body?.reason === 'breakpoint');
						const stopped = await observer.snapshot(`cycle-${cycle}-stopped`);
						session.recordEvidence(`cycle-${cycle}-dap-stop`, stop);
						session.recordEvidence(`cycle-${cycle}-stop-sequence`, session.events.since(mark, 'stopped'));
						assert.strictEqual(stop.body?.reason, 'breakpoint', 'Stop must be the user breakpoint');
						assert.strictEqual(stop.body?.threadId, threads[core].id, 'DAP focused the wrong core');
						assert.strictEqual(stop.body?.allThreadsStopped, true, 'Missing all-core stop notification');
						if (stopped.some(core => !core.state.suspended)) {
							for (const delay of [100, 900]) {
								await new Promise(resolve => setTimeout(resolve, delay));
								await observer.snapshot(`cycle-${cycle}-diagnostic-after-${delay}ms-more`);
							}
						}
						assert.deepStrictEqual(stopped.map(core => core.state.suspended), [true, true, true],
							'DAP claims allThreadsStopped but fresh native states disagree');
						await session.assertLocation(point, threads[core].id);
						for (let index = 0; index < threads.length; index++) {
							const [frame] = await session.frames(threads[index].id);
							assert.ok(frame.instructionPointerReference, `Missing PC for ${threads[index].name}`);
							assert.strictEqual(Number(frame.instructionPointerReference), stopped[index].state.pc,
								`Stack PC differs from native PC for ${threads[index].name}`);
							assert.strictEqual(await session.coreProgramCounter(frame.id), stopped[index].state.pc,
								`Register PC differs from native PC for ${threads[index].name}`);
						}
						const stable = await observer.snapshot(`cycle-${cycle}-still-stopped`);
						assert.deepStrictEqual(stable.map(core => [core.state.suspended, core.state.pc]),
							stopped.map(core => [core.state.suspended, core.state.pc]), 'Core state changed without Continue');
						await session.setBreakpoints(point.source, []);
					}
				} finally {
					observer.disconnect();
				}
			});
		});
	}
});
