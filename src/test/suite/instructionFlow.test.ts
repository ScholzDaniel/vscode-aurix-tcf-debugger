import * as assert from 'assert';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { DebugHarness, hardwareTest, withDebugSession } from '../debugHarness';

async function instructionWindow(session: DebugHarness, instructionCount = 2): Promise<DebugProtocol.DisassembledInstruction[]> {
	const [frame] = await session.frames();
	assert.ok(frame.instructionPointerReference, 'Missing current instruction address');
	const response = await session.request<DebugProtocol.DisassembleResponse['body']>('disassemble', {
		memoryReference: frame.instructionPointerReference, instructionCount
	});
	assert.ok(response && response.instructions.length === instructionCount, 'Missing decoded instruction window');
	assert.strictEqual(Number(response.instructions[0].address), Number(frame.instructionPointerReference), 'Disassembly is not anchored at PC');
	return response.instructions;
}

function directTarget(instruction: DebugProtocol.DisassembledInstruction, mnemonic: 'call' | 'j'): number {
	const match = new RegExp(`^\\s*${mnemonic}\\s+(0x[0-9a-f]+)\\b`, 'i').exec(instruction.instruction);
	if (match) {
		return Number(match[1]);
	}
	if (mnemonic === 'j') {
		// The bundled agent renders this TriCore branch as a signed byte displacement.
		const relative = /^\s*j\s+([+-]\d+)\s*$/i.exec(instruction.instruction);
		if (relative) {
			return Number(instruction.address) + Number(relative[1]);
		}
	}
	throw new Error(`Fixture requires a direct ${mnemonic} instruction, got ${instruction.instruction}`);
}

async function assertPC(session: DebugHarness, expected: number): Promise<DebugProtocol.StackFrame[]> {
	const frames = await session.frames();
	assert.strictEqual(Number(frames[0].instructionPointerReference), expected,
		`Wrong control-flow destination: expected 0x${expected.toString(16)}, got ${frames[0].instructionPointerReference}`);
	assert.strictEqual(await session.coreProgramCounter(frames[0].id), expected, 'Physical PC disagrees with control-flow destination');
	return frames;
}

suite('Instruction control flow (hardware)', () => {
	for (const command of ['stepIn', 'next'] as const) {
		hardwareTest(`[REG flow-call-${command}] instruction ${command} ${command === 'stepIn' ? 'enters' : 'steps over'} a direct call`, async profile => {
			await withDebugSession(profile, `REG-flow-call-${command}`, async session => {
				await session.runTo(profile.steps.stepIn.from);
				const before = await session.frames();
				const [call, following] = await instructionWindow(session);
				const target = directTarget(call, 'call');
				await session.request('aurix-tcf/setInstructionStepping', { enabled: true });
				const mark = session.events.mark();
				await session.request(command, { threadId: session.threadId });
				await session.expectStop(mark, undefined, ['step']);
				const after = await assertPC(session, command === 'stepIn' ? target : Number(following.address));
				if (command === 'stepIn') {
					assert.strictEqual(after[0].name.split('(')[0].trim(), profile.steps.stepIn.to.function, 'Did not enter the fixture callee');
					assert.strictEqual(after.length, before.length + 1, 'Call did not add one frame');
					assert.strictEqual(Number(after[1].instructionPointerReference), Number(following.address), 'Caller frame has the wrong return PC');
				} else {
					assert.strictEqual(after[0].name, before[0].name, 'Instruction Next entered the callee');
					assert.strictEqual(after.length, before.length, 'Instruction Next did not preserve caller depth');
				}
			});
		});
	}

	hardwareTest('[REG flow-return] instruction stepping executes ret and unwinds to the live caller PC', async profile => {
		await withDebugSession(profile, 'REG-flow-return', async session => {
			await session.runTo(profile.steps.stepOut.from);
			const before = await session.frames();
			const callerPC = before[1]?.instructionPointerReference;
			assert.ok(callerPC, 'Return fixture needs a caller PC');
			let [instruction] = await instructionWindow(session, 1);
			await session.request('aurix-tcf/setInstructionStepping', { enabled: true });
			if (/^\s*nop\s*$/i.test(instruction.instruction)) {
				const hex = instruction.instructionBytes?.replace(/\s/g, '');
				assert.ok(hex && /^(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(hex), 'Invalid nop opcode bytes');
				const following = Number(instruction.address) + hex.length / 2;
				const mark = session.events.mark();
				await session.request('stepIn', { threadId: session.threadId });
				await session.expectStop(mark, undefined, ['step']);
				await assertPC(session, following);
				[instruction] = await instructionWindow(session, 1);
			}
			assert.match(instruction.instruction, /^\s*ret\s*$/i, 'Fixture must stop at ret or one nop before ret');
			const mark = session.events.mark();
			await session.request('stepIn', { threadId: session.threadId });
			await session.expectStop(mark, profile.steps.stepOut.to, ['step']);
			const after = await assertPC(session, Number(callerPC));
			assert.strictEqual(after.length, before.length - 1, 'ret did not remove one frame');
		});
	});

	hardwareTest('[REG flow-jump] instruction stepping follows the decoded unconditional branch target', async profile => {
		await withDebugSession(profile, 'REG-flow-jump', async session => {
			await session.runTo(profile.steps.stepOut.from);
			const mark = session.events.mark();
			await session.request('stepOut', { threadId: session.threadId });
			await session.expectStop(mark, profile.steps.stepOut.to, ['step']);
			const before = await session.frames();
			const [branch] = await instructionWindow(session, 1);
			const target = directTarget(branch, 'j');
			assert.notStrictEqual(target, Number(branch.address), 'Fixture requires a non-self branch');
			await session.request('aurix-tcf/setInstructionStepping', { enabled: true });
			const step = session.events.mark();
			await session.request('stepIn', { threadId: session.threadId });
			await session.expectStop(step, undefined, ['step']);
			const after = await assertPC(session, target);
			assert.strictEqual(after[0].name, before[0].name, 'Branch left the fixture function');
			assert.strictEqual(after.length, before.length, 'Branch changed stack depth');
		});

	});

	hardwareTest('[REG flow-disassembly-count] disassembly while stopped at ret honors the requested instruction count', async profile => {
		await withDebugSession(profile, 'REG-flow-disassembly-count', async session => {
			await session.runTo(profile.steps.stepOut.from);
			let [instruction] = await instructionWindow(session, 1);
			if (/^\s*nop\s*$/i.test(instruction.instruction)) {
				const hex = instruction.instructionBytes?.replace(/\s/g, '');
				assert.ok(hex && /^(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(hex), 'Invalid nop opcode bytes');
				const address = Number(instruction.address) + hex.length / 2;
				await session.request('aurix-tcf/setInstructionStepping', { enabled: true });
				const mark = session.events.mark();
				await session.request('stepIn', { threadId: session.threadId });
				await session.expectStop(mark, undefined, ['step']);
				await assertPC(session, address);
				[instruction] = await instructionWindow(session, 1);
			}
			assert.match(instruction.instruction, /^\s*ret\s*$/i, 'Fixture needs ret at the stopped PC');
			const pair = await session.request<DebugProtocol.DisassembleResponse['body']>('disassemble', {
				memoryReference: instruction.address, instructionCount: 2
			});
			assert.ok(pair, 'Missing disassembly response');
			assert.strictEqual(pair.instructions.length, 2, 'DAP must return exactly instructionCount entries, padding unavailable instructions');
			assert.deepStrictEqual(pair.instructions[0], instruction, 'Changing the count changed the first instruction');
			if (pair.instructions[1].presentationHint === 'invalid') {
				assert.strictEqual(pair.instructions[1].instructionBytes, undefined, 'Unavailable instruction must not invent opcode bytes');
				assert.strictEqual(pair.instructions[1].instruction, '<not decoded>');
			} else {
				assert.ok(pair.instructions[1].instructionBytes, 'A decoded successor must expose opcode bytes');
			}
		});
	});

	hardwareTest('[REG flow-call-next-breakpoint] a user breakpoint interrupts instruction Next inside a call', async profile => {
		await withDebugSession(profile, 'REG-flow-call-next-breakpoint', async session => {
			await session.runTo(profile.steps.stepIn.from);
			const before = await session.frames();
			const [call] = await instructionWindow(session);
			directTarget(call, 'call');
			await session.setBreakpoints(profile.steps.stepIn.to.source, [profile.steps.stepIn.to.line]);
			await session.request('aurix-tcf/setInstructionStepping', { enabled: true });
			const mark = session.events.mark();
			await session.request('next', { threadId: session.threadId });
			await session.expectStop(mark, profile.steps.stepIn.to, ['breakpoint']);
			assert.strictEqual((await session.frames()).length, before.length + 1, 'User breakpoint did not interrupt inside the callee');
			await session.setBreakpoints(profile.steps.stepIn.to.source, []);
		});
	});

	hardwareTest('[REG flow-disassembly-validation] zero-count and invalid requests preserve the session', async profile => {
		await withDebugSession(profile, 'REG-flow-disassembly-validation', async session => {
			const [frame] = await session.frames();
			const memoryReference = frame.instructionPointerReference;
			assert.ok(memoryReference, 'Missing stopped PC');
			const empty = await session.request<DebugProtocol.DisassembleResponse['body']>('disassemble', {
				memoryReference, instructionCount: 0
			});
			assert.deepStrictEqual(empty?.instructions, [], 'Zero count must not default to a nonempty window');
			for (const args of [
				{ memoryReference: 'not-an-address', instructionCount: 1 },
				{ memoryReference, instructionCount: -1 },
				{ memoryReference, instructionCount: 1.5 },
				{ memoryReference, instructionCount: 1, instructionOffset: 0.5 },
				{ memoryReference, instructionCount: 1, offset: 0.5 }
			]) {
				await assert.rejects(session.request('disassemble', args), /Disassemble error/);
			}
			const recovered = await instructionWindow(session);
			assert.strictEqual(Number(recovered[0].address), Number(memoryReference), 'Invalid requests disturbed the stopped PC');
			await session.assertLocation(profile.entry);
		});
	});
});
