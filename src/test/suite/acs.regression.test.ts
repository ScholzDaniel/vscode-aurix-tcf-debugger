import * as assert from 'assert';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { hardwareTest, withDebugSession } from '../debugHarness';
import { positiveInteger } from '../hardwareProfile';

suite('ACS-derived AURIX regression (hardware)', () => {
	hardwareTest('[ACS 1-0-4] stop at the configured function and source line', async profile => {
		await withDebugSession(profile, 'ACS-1-0-4', async session => {
			await session.assertLocation(profile.entry);
		});
	});

	for (const [command, caseId] of [['stepIn', '1-1-0'], ['next', '1-2-0'], ['stepOut', '1-3-0']] as const) {
		hardwareTest(`[ACS ${caseId}] ${command} reaches the expected source location`, async profile => {
			await withDebugSession(profile, `ACS-${caseId}`, async session => {
				const fixture = profile.steps[command];
				await session.runTo(fixture.from);
				const before = await session.frames();
				const mark = session.events.mark();
				await session.request(command, { threadId: session.threadId });
				await session.expectStop(mark, fixture.to, ['step']);
				if (command === 'stepOut') {
					assert.ok((await session.frames()).length < before.length, 'Step out did not unwind a stack frame');
				}
			});
		});
	}

	hardwareTest('[REG step-out-source-breakpoint] a user breakpoint interrupts Step Out before returning', async profile => {
		await withDebugSession(profile, 'REG-step-out-source-breakpoint', async session => {
			const start = profile.steps.stepIn.to;
			const fixture = profile.steps.stepOut;
			assert.strictEqual(start.function, fixture.from.function, 'Step fixtures must share a callee for the interruption test');
			await session.runTo(start);
			const before = await session.frames();
			await session.setBreakpoints(fixture.from.source, [fixture.from.line]);
			const mark = session.events.mark();
			await session.request('stepOut', { threadId: session.threadId });
			await session.expectStop(mark, fixture.from, ['breakpoint']);
			assert.strictEqual((await session.frames()).length, before.length, 'User breakpoint did not interrupt before unwinding');
			await session.setBreakpoints(fixture.from.source, []);
			const retry = session.events.mark();
			await session.request('stepOut', { threadId: session.threadId });
			await session.expectStop(retry, fixture.to, ['step']);
			assert.ok((await session.frames()).length < before.length, 'Step Out after interruption did not unwind');
		});
	});

	hardwareTest('[REG step-out-return-breakpoint] a user instruction breakpoint at the return PC takes precedence', async profile => {
		await withDebugSession(profile, 'REG-step-out-return-breakpoint', async session => {
			const fixture = profile.steps.stepOut;
			await session.runTo(fixture.from);
			const before = await session.frames();
			const instructionReference = before[1]?.instructionPointerReference;
			assert.ok(instructionReference, 'Caller frame has no instruction pointer');
			const added = session.events.mark();
			const response = await session.request<DebugProtocol.SetInstructionBreakpointsResponse['body']>('setInstructionBreakpoints', {
				breakpoints: [{ instructionReference }]
			});
			assert.strictEqual(response?.breakpoints?.length, 1, 'Wrong instruction breakpoint count');
			const breakpoint = response.breakpoints[0];
			if (!breakpoint.verified) {
				assert.notStrictEqual(breakpoint.id, undefined, 'Unverified instruction breakpoint has no ID');
				await session.events.waitFor('breakpoint', added, profile.timeoutMs, event =>
					event.body?.breakpoint?.id === breakpoint.id && event.body.breakpoint.verified === true);
			}
			const mark = session.events.mark();
			await session.request('stepOut', { threadId: session.threadId });
			await session.expectStop(mark, fixture.to, ['breakpoint']);
			const after = await session.frames();
			assert.strictEqual(after[0].instructionPointerReference, instructionReference, 'Did not hit the exact caller return PC');
			assert.ok(after.length < before.length, 'Step Out did not unwind to the caller breakpoint');
			await session.request('setInstructionBreakpoints', { breakpoints: [] });
		});
	});

	hardwareTest('[ACS 1-6-0] add a breakpoint and verify its hit location', async profile => {
		await withDebugSession(profile, 'ACS-1-6-0', session => session.runTo(profile.loopBreakpoint));
	});

	for (const [remove, caseId] of [[false, '1-6-3'], [true, '1-6-4']] as const) {
		hardwareTest(`[ACS ${caseId}] ${remove ? 'remove' : 'add'} a breakpoint during execution`, async profile => {
			await withDebugSession(profile, `ACS-${caseId}`, async session => {
				const mark = await session.resume();
				await session.setBreakpoints(profile.beforeEntry.source, [profile.beforeEntry.line]);
				if (remove) {
					await session.setBreakpoints(profile.beforeEntry.source, []);
				}
				await session.threads();
				assert.deepStrictEqual(session.events.since(mark, 'stopped'), [], 'Breakpoint update unexpectedly stopped execution');
				await session.setBreakpoints(profile.beforeEntry.source, []);
				await session.pauseAll();
			});
		});
	}

	hardwareTest('[ACS 1-10-4] pause leaves every configured core inspectable', async profile => {
		await withDebugSession(profile, 'ACS-1-10-4', async session => {
			await session.resume();
			await session.pauseAll();
		});
	});

	for (const [running, caseId] of [[false, '1-8-0'], [true, '1-8-2']] as const) {
		hardwareTest(`[ACS ${caseId}] reset from ${running ? 'running' : 'suspended'} returns to entry`, async profile => {
			await withDebugSession(profile, `ACS-${caseId}`, async session => {
				if (running) {
					await session.resume();
				}
				await session.setBreakpoints(profile.entry.source, [profile.entry.line]);
				const mark = session.events.mark();
				await session.request('aurix-tcf/reset', { suspend: false, pauseAll: false, core: profile.core });
				await session.expectStop(mark, profile.entry, ['breakpoint', 'entry']);
			});
		});
	}

	hardwareTest('[REG peripheral-guard] peripheral reads are unreadable without losing the session', async profile => {
		await withDebugSession(profile, 'REG-peripheral-guard', async session => {
			for (const running of [false, true]) {
				if (running) {
					await session.resume();
				}
				const response = await session.request<DebugProtocol.ReadMemoryResponse['body']>('readMemory', {
					memoryReference: '0xF0000000', count: 4
				});
				assert.strictEqual(response?.unreadableBytes, 4, 'Peripheral read was not rejected as unreadable');
				await session.threads();
			}
			await session.pauseAll();
		});
	});

	hardwareTest('[REG breakpoint-cycles] repeated verified loop breakpoint hits and removal', async (profile, context) => {
		const cycles = positiveInteger(process.env.AURIX_TEST_BP_CYCLES ?? '10', 'AURIX_TEST_BP_CYCLES');
		context.timeout(profile.launchTimeoutMs + (cycles * 10 + 10) * profile.timeoutMs);
		await withDebugSession(profile, 'REG-breakpoint-cycles', async session => {
			for (let iteration = 1; iteration <= cycles; iteration++) {
				try {
					await session.runTo(profile.loopBreakpoint);
				} catch (error) {
					throw new Error(`Breakpoint cycle ${iteration}/${cycles} failed`, { cause: error });
				}
			}
		});
	});
});