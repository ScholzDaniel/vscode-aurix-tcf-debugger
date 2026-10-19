import * as assert from 'assert';
import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { hardwareTest, withDebugSession } from '../debugHarness';
import { StateObserver } from '../nativeStateObserver';

suite('CALL STACK focus and Pause state (hardware)', () => {
	hardwareTest('[REG focus-entry] stop-at-core-entry selects the target frame across three launches', async profile => {
		assert.ok(profile.coreEntry, 'Configure the exact coreEntry source location');
		const disassemblyTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
			.filter(tab => tab.label === 'Disassembly');
		await vscode.window.tabGroups.close(disassemblyTabs());
		for (let iteration = 1; iteration <= 3; iteration++) {
			await withDebugSession({ ...profile, entry: profile.coreEntry }, `REG-focus-entry-${iteration}`, async session => {
				await session.assertFocusedThread(session.threadId, profile.coreEntry);
				// Observe beyond the removed 1200 ms auto-open timer and its 150 ms layout delay.
				await new Promise(resolve => setTimeout(resolve, 2000));
				assert.strictEqual(disassemblyTabs().length, 0, 'Startup must not open Disassembly');
				await session.assertFocusedThread(session.threadId, profile.coreEntry);
				session.recordEvidence('startup-no-disassembly', { iteration });
				if (iteration === 3) {
					try {
						await vscode.commands.executeCommand('debug.action.openDisassemblyView');
						const deadline = Date.now() + profile.timeoutMs;
						while (!disassemblyTabs().length && Date.now() < deadline) {
							await new Promise(resolve => setTimeout(resolve, 25));
						}
						assert.strictEqual(disassemblyTabs().length, 1, 'Manual Disassembly opening must still work');
						session.recordEvidence('manual-disassembly-open', { label: disassemblyTabs()[0].label });
					} finally {
						await vscode.window.tabGroups.close(disassemblyTabs());
					}
				}
			});
		}
	});

	hardwareTest('[REG focus-stepping] toolbar source steps retain focus on the requested core', async profile => {
		await withDebugSession(profile, 'REG-focus-stepping', async session => {
			for (let cycle = 1; cycle <= 2; cycle++) {
				for (const [step, command] of [
					['stepIn', 'workbench.action.debug.stepInto'],
					['next', 'workbench.action.debug.stepOver'],
					['stepOut', 'workbench.action.debug.stepOut']
				] as const) {
					await session.runTo(profile.steps[step].from);
					await session.assertFocusedThread();
					const mark = session.events.mark();
					await vscode.commands.executeCommand(command);
					await session.expectStop(mark, profile.steps[step].to, ['step']);
					await session.assertFocusedThread(session.threadId, profile.steps[step].to);
					session.recordEvidence('toolbar-step-focus', { cycle, step });
				}
			}
		});
	});

	hardwareTest('[REG focus-startup-breakpoint] an early secondary-core breakpoint and subsequent steps select that core', async profile => {
		assert.ok(profile.coreEntry && profile.startupBreakpoint, 'Configure coreEntry and startupBreakpoint');
		const breakpoint = profile.startupBreakpoint;
		assert.notStrictEqual(breakpoint.core, profile.core, 'This fixture must stop a different core');
		await withDebugSession({ ...profile, entry: profile.coreEntry }, 'REG-focus-startup-breakpoint', async session => {
			await session.assertFocusedThread(session.threadId, profile.coreEntry);
			const threads = await session.threads();
			const target = threads[breakpoint.core].id;
			const mark = session.events.mark();
			await vscode.commands.executeCommand('workbench.action.debug.continue');
			const stop = await session.events.waitFor('stopped', mark, profile.timeoutMs,
				event => event.body?.reason === 'breakpoint');
			assert.strictEqual(stop.body?.threadId, target, 'Early breakpoint selected the wrong core');
			assert.strictEqual(stop.body?.allThreadsStopped, true);
			await session.assertLocation(breakpoint.point, target);
			await session.assertFocusedThread(target, breakpoint.point);
			await session.setBreakpoints(breakpoint.point.source, []);
			await session.request('aurix-tcf/setInstructionStepping', { enabled: true });
			for (let step = 0; step < 2; step++) {
				const [before] = await session.frames(target);
				const decoded = await session.request<DebugProtocol.DisassembleResponse['body']>('disassemble', {
					memoryReference: before.instructionPointerReference, instructionCount: 2
				});
				assert.ok(decoded?.instructions.length === 2, 'Missing current/next instruction');
				assert.match(decoded.instructions[0].instruction.trim(), /^(mov[\w.]*|lea|nop)\s/i,
					'The early breakpoint fixture must start with straight-line instructions');
				assert.notStrictEqual(decoded.instructions[1].presentationHint, 'invalid');
				const stepped = session.events.mark();
				await vscode.commands.executeCommand('workbench.action.debug.stepOver');
				const event = await session.events.waitFor('stopped', stepped, profile.timeoutMs,
					event => event.body?.threadId === target);
				assert.strictEqual(event.body?.reason, 'step');
				const [after] = await session.frames(target);
				assert.strictEqual(Number(after.instructionPointerReference), Number(decoded.instructions[1].address));
				assert.strictEqual(await session.coreProgramCounter(after.id), Number(after.instructionPointerReference));
				await session.assertLocation(breakpoint.point, target);
				await session.assertFocusedThread(target, breakpoint.point);
			}
		}, { breakpoint: { point: breakpoint.point, enabled: true } });
	});

	hardwareTest('[REG focus-cross-core-source] breakpoint focus and displayed source follow CPU0, CPU1, CPU2 and CPU0', async profile => {
		assert.ok(profile.coreBreakpoints?.length === 3, 'Configure three per-core breakpoint locations');
		const points = profile.coreBreakpoints;
		await withDebugSession(profile, 'REG-focus-cross-core-source', async session => {
			const threads = await session.threads();
			for (const core of [0, 1, 2, 0]) {
				const point = points[core];
				await session.resume();
				const mark = session.events.mark();
				await session.setBreakpoints(point.source, [point.line]);
				const stop = await session.events.waitFor('stopped', mark, profile.timeoutMs,
					event => event.body?.reason === 'breakpoint');
				assert.strictEqual(stop.body?.threadId, threads[core].id, 'Wrong breakpoint core');
				assert.strictEqual(stop.body?.allThreadsStopped, true);
				await session.assertLocation(point, threads[core].id);
				await session.assertFocusedThread(threads[core].id, point);
				await session.setBreakpoints(point.source, []);
			}
		});
	});

	hardwareTest('[REG focus-pause] toolbar Continue/Pause confirms all cores stopped and retains target focus', async profile => {
		await withDebugSession(profile, 'REG-focus-pause', async session => {
			const observer = new StateObserver(session);
			try {
				await observer.connect(profile.host, profile.port);
				const threads = await session.threads();
				await session.assertFocusedThread();
				for (let cycle = 1; cycle <= 3; cycle++) {
					const resumed = session.events.mark();
					await vscode.commands.executeCommand('workbench.action.debug.continue');
					for (const thread of threads) {
						await session.events.waitFor('continued', resumed, profile.timeoutMs, event =>
							event.body?.threadId === thread.id || event.body?.allThreadsContinued === true);
					}
					const running = await observer.snapshot(`cycle-${cycle}-toolbar-running`);
					assert.ok(running.every(core => !core.state.suspended), 'Continue did not run every core');
					const mark = session.events.mark();
					await vscode.commands.executeCommand('workbench.action.debug.pause');
					await session.events.waitFor('stopped', mark, profile.timeoutMs, event =>
						event.body?.reason === 'pause' && event.body?.allThreadsStopped === true);
					const stopped = await observer.snapshot(`cycle-${cycle}-toolbar-paused`);
					assert.ok(stopped.every(core => core.state.suspended), 'A core is still running after Pause');
					await session.assertFocusedThread();
					for (let index = 0; index < threads.length; index++) {
						const [frame] = await session.frames(threads[index].id);
						assert.strictEqual(await session.coreProgramCounter(frame.id), stopped[index].state.pc);
					}
				}
			} finally {
				observer.disconnect();
			}
		});
	});
});
