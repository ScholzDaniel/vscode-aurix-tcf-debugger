import * as assert from 'assert';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { hardwareTest, withDebugSession } from '../debugHarness';

function frameLocations(frames: DebugProtocol.StackFrame[]): unknown[] {
	return frames.map(frame => ({
		name: frame.name, path: frame.source?.path, line: frame.line,
		column: frame.column, pc: frame.instructionPointerReference
	}));
}

suite('Instruction stepping and reference isolation (hardware)', () => {
	for (const command of ['next', 'stepIn'] as const) {
		hardwareTest(`[REG control-instruction-${command}] instruction mode advances one decoded instruction and can return to source mode`, async profile => {
			await withDebugSession(profile, `REG-control-instruction-${command}`, async session => {
				await session.request('aurix-tcf/setInstructionStepping', { enabled: true });
				for (let iteration = 0; iteration < 2; iteration++) {
					const [before] = await session.frames();
					assert.ok(before.instructionPointerReference, 'Missing instruction PC');
					const decoded = await session.request<DebugProtocol.DisassembleResponse['body']>('disassemble', {
						memoryReference: before.instructionPointerReference, instructionCount: 2
					});
					assert.ok(decoded && decoded.instructions.length === 2, 'Missing next instruction boundary');
					const [current, following] = decoded.instructions;
					assert.strictEqual(Number(current.address), Number(before.instructionPointerReference));
					assert.match(current.instruction.trim(), /^(?:mov[\w.]*|sub[\w.]*|add[\w.]*|lea|nop)\s/i,
						'Fixture needs a straight-line instruction at entry; control-flow stepping is not covered here');
					const mark = session.events.mark();
					await session.request(command, { threadId: session.threadId });
					await session.expectStop(mark, undefined, ['step']);
					const [after] = await session.frames();
					assert.strictEqual(Number(after.instructionPointerReference), Number(following.address), 'Instruction step skipped or repeated an instruction');
					assert.strictEqual(await session.coreProgramCounter(after.id), Number(following.address), 'Physical PC disagrees with instruction step');
				}
				await session.request('aurix-tcf/setInstructionStepping', { enabled: false });
				await session.runTo(profile.steps.next.from);
				const mark = session.events.mark();
				await session.request('next', { threadId: session.threadId });
				await session.expectStop(mark, profile.steps.next.to, ['step']);
			});
		});
	}

	hardwareTest('[REG control-frame-refresh] repeated full-stack reads preserve suspended-frame references', async profile => {
		await withDebugSession(profile, 'REG-control-frame-refresh', async session => {
			await session.runTo(profile.steps.stepOut.from);
			const first = await session.request<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId: session.threadId });
			assert.ok(first?.stackFrames && first.stackFrames.length >= 2, 'Fixture needs a real caller');
			const scopes = await session.request<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: first.stackFrames[0].id });
			const locals = scopes?.scopes.find(scope => scope.name === 'Locals');
			assert.ok(locals, 'Missing initial locals reference');
			const second = await session.request<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId: session.threadId, levels: 0 });
			assert.ok(second, 'Missing refreshed stack');
			assert.deepStrictEqual(frameLocations(second.stackFrames), frameLocations(first.stackFrames), 'Suspended stack changed during refresh');
			assert.strictEqual(first.totalFrames, first.stackFrames.length);
			assert.strictEqual(second.totalFrames, first.totalFrames);
			for (const frame of [first.stackFrames[0], second.stackFrames[0]]) {
				assert.strictEqual(await session.coreProgramCounter(frame.id), Number(frame.instructionPointerReference), 'Refresh invalidated a still-suspended frame');
			}
			const variables = await session.request<DebugProtocol.VariablesResponse['body']>('variables', { variablesReference: locals.variablesReference });
			assert.ok(Array.isArray(variables?.variables), 'Refresh lost the initial locals reference');
		});
	});

	hardwareTest('[REG control-core-isolation] multicore references stay distinct and invalidate on all-core Continue', async profile => {
		await withDebugSession(profile, 'REG-control-core-isolation', async session => {
			const threads = await session.threads();
			assert.ok(threads.length >= 2, 'Isolation fixture needs multiple cores');
			const snapshots: Array<{ threadId: number; frame: DebugProtocol.StackFrame; locals: number }> = [];
			const references = new Set<number>();
			const frameIds = new Set<number>();
			for (const thread of threads) {
				const [frame] = await session.frames(thread.id);
				assert.ok(frame.instructionPointerReference, `No PC for ${thread.name}`);
				assert.ok(!frameIds.has(frame.id), 'Frame IDs collide between cores');
				frameIds.add(frame.id);
				const scopes = await session.request<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: frame.id });
				assert.ok(scopes?.scopes.length, 'Core has no scopes');
				for (const scope of scopes.scopes) {
					assert.ok(scope.variablesReference > 0 && !references.has(scope.variablesReference), 'Scope references collide between cores');
					references.add(scope.variablesReference);
				}
				const locals = scopes.scopes.find(scope => scope.name === 'Locals');
				assert.ok(locals, 'Core has no locals scope');
				assert.strictEqual(await session.coreProgramCounter(frame.id), Number(frame.instructionPointerReference), `Wrong register context for ${thread.name}`);
				snapshots.push({ threadId: thread.id, frame, locals: locals.variablesReference });
			}
			const mark = await session.resume();
			for (const snapshot of snapshots) {
				await session.events.waitFor('continued', mark, profile.timeoutMs, event =>
					event.body?.threadId === snapshot.threadId || event.body?.allThreadsContinued === true);
				const stale = await session.request<DebugProtocol.VariablesResponse['body']>('variables', { variablesReference: snapshot.locals });
				assert.deepStrictEqual(stale?.variables, [], `Running thread ${snapshot.threadId} returned stale stopped variables`);
				const staleValue = await session.request<DebugProtocol.EvaluateResponse['body']>('evaluate', {
					frameId: snapshot.frame.id, expression: '6 * 7', context: 'hover'
				});
				assert.strictEqual(staleValue.result, '', `Running thread ${snapshot.threadId} reused an invalid frame`);
			}
			assert.deepStrictEqual(session.events.since(mark, 'stopped'), [], 'Reference reads unexpectedly stopped the running core');
			await session.pauseAll();
			const refreshedReferences = new Set<number>();
			for (const thread of threads) {
				const [frame] = await session.frames(thread.id);
				assert.ok(frame.instructionPointerReference, 'New stopped frame has no PC');
				assert.strictEqual(await session.coreProgramCounter(frame.id), Number(frame.instructionPointerReference), `New frame/register context mismatch for ${thread.name}`);
				const scopes = await session.request<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: frame.id });
				assert.ok(scopes?.scopes.length, 'New stopped frame has no scopes');
				for (const scope of scopes.scopes) {
					assert.ok(scope.variablesReference > 0 && !refreshedReferences.has(scope.variablesReference), 'Refreshed core scope references collide');
					refreshedReferences.add(scope.variablesReference);
				}
				const value = await session.request<DebugProtocol.EvaluateResponse['body']>('evaluate', {
					frameId: frame.id, expression: '6 * 7', context: 'hover'
				});
				assert.strictEqual(value.result, '42', `New frame evaluation failed for ${thread.name}`);
			}
		});
	});
});
