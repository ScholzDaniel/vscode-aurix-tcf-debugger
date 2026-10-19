import * as assert from 'assert';
import * as fs from 'fs';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { DebugHarness, hardwareTest, withDebugSession } from '../debugHarness';

function executableBytes(program: string, address: number, count: number): Buffer {
	const elf = fs.readFileSync(program);
	assert.ok(elf.length >= 52, 'ELF header is truncated');
	assert.strictEqual(elf.subarray(0, 4).toString('hex'), '7f454c46', 'Invalid ELF magic');
	assert.strictEqual(elf[4], 1, 'Code inspection requires an ELF32 fixture');
	assert.strictEqual(elf[5], 1, 'Code inspection requires a little-endian fixture');
	const table = elf.readUInt32LE(28);
	const entrySize = elf.readUInt16LE(42);
	const entries = elf.readUInt16LE(44);
	assert.ok(entrySize >= 32 && table + entrySize * entries <= elf.length, 'Invalid ELF program headers');
	for (let index = 0; index < entries; index++) {
		const header = table + index * entrySize;
		if (elf.readUInt32LE(header) !== 1 || !(elf.readUInt32LE(header + 24) & 1)) {
			continue;
		}
		const base = elf.readUInt32LE(header + 8);
		const size = elf.readUInt32LE(header + 16);
		if (address >= base && address + count <= base + size) {
			const offset = elf.readUInt32LE(header + 4) + address - base;
			assert.ok(offset + count <= elf.length, 'Executable segment is truncated');
			return elf.subarray(offset, offset + count);
		}
	}
	throw new Error(`No file-backed executable ELF segment contains 0x${address.toString(16)} + ${count}`);
}

async function scopes(session: DebugHarness, frameId: number): Promise<DebugProtocol.Scope[]> {
	const response = await session.request<DebugProtocol.ScopesResponse['body']>('scopes', { frameId });
	assert.ok(response?.scopes?.length, 'Stopped frame exposes no scopes');
	for (const scope of response.scopes) {
		assert.ok(Number.isInteger(scope.variablesReference) && scope.variablesReference > 0, 'Invalid scope reference');
	}
	return response.scopes;
}

async function variables(session: DebugHarness, variablesReference: number): Promise<DebugProtocol.Variable[]> {
	const response = await session.request<DebugProtocol.VariablesResponse['body']>('variables', { variablesReference });
	assert.ok(Array.isArray(response?.variables), 'Missing variables array');
	for (const variable of response.variables) {
		assert.ok(variable.name.length > 0, 'Unnamed variable');
		assert.strictEqual(typeof variable.value, 'string', 'Invalid variable value');
		assert.ok(Number.isInteger(variable.variablesReference) && variable.variablesReference >= 0, 'Invalid child reference');
	}
	return response.variables;
}

suite('Read-only data inspection (hardware)', () => {
	hardwareTest('[REG inspect-stack] callee and caller expose distinct readable scopes', async profile => {
		await withDebugSession(profile, 'REG-inspect-stack', async session => {
			await session.runTo(profile.steps.stepOut.from);
			const frames = await session.frames();
			assert.ok(frames.length >= 2, 'Fixture has no caller frame');
			assert.strictEqual(frames[1].name.split('(')[0].trim(), profile.steps.stepOut.to.function, 'Wrong caller');
			assert.strictEqual(new Set(frames.map(frame => frame.id)).size, frames.length, 'Duplicate frame IDs');
			const references = new Set<number>();
			for (const frame of frames.slice(0, 2)) {
				const frameScopes = await scopes(session, frame.id);
				for (const scope of frameScopes) {
					assert.ok(!references.has(scope.variablesReference), 'Scope reference is shared between frames');
					references.add(scope.variablesReference);
				}
				const locals = frameScopes.find(scope => scope.name === 'Locals');
				assert.ok(locals, 'Locals scope missing');
				await variables(session, locals.variablesReference);
			}
			await session.assertLocation(profile.steps.stepOut.from);
		});
	});

	hardwareTest('[REG inspect-expressions] evaluate exact values and recover from an invalid symbol', async profile => {
		await withDebugSession(profile, 'REG-inspect-expressions', async session => {
			const [frame] = await session.frames();
			for (const context of ['watch', 'hover', 'repl']) {
				for (const [expression, expected] of [
					['6 * 7', '42'], ['(0x12345678U >> 8) & 0xff', '86'],
					['-42', '-42'], ['1.5', '1.5'], ['9007199254740993LL', '9007199254740993']
				] as const) {
					const result = await session.request<DebugProtocol.EvaluateResponse['body']>('evaluate', {
						expression, context, frameId: frame.id
					});
					assert.strictEqual(result.result, expected, `Incorrect ${context} result for ${expression}`);
					assert.strictEqual(result.variablesReference, 0, 'Scalar expression unexpectedly has children');
				}
			}
			for (const expression of ['__aurix_regression_missing_symbol__', '1 / 0']) {
				await assert.rejects(session.request('evaluate', {
					expression, frameId: frame.id, context: 'watch'
				}), /Evaluate error/);
			}
			const recovered = await session.request<DebugProtocol.EvaluateResponse['body']>('evaluate', {
				expression: '6 * 7', frameId: frame.id, context: 'watch'
			});
			assert.strictEqual(recovered.result, '42', 'Evaluation did not recover after expression errors');
			const withoutFrame = await session.request<DebugProtocol.EvaluateResponse['body']>('evaluate', {
				expression: '6 * 7', context: 'watch'
			});
			assert.strictEqual(withoutFrame.result, '42', 'Watch evaluation without frameId lost the result');
			await session.assertLocation(profile.entry);
		});
	});

	hardwareTest('[REG inspect-registers] core PC bytes match the stopped stack frame', async profile => {
		await withDebugSession(profile, 'REG-inspect-registers', async session => {
			const [frame] = await session.frames();
			assert.ok(frame.instructionPointerReference, 'Frame has no PC');
			assert.strictEqual(await session.coreProgramCounter(frame.id), Number(frame.instructionPointerReference), 'Register PC disagrees with stack PC');
			await session.assertLocation(profile.entry);
		});
	});

	hardwareTest('[REG inspect-memory] code bytes and offset reads match the ELF', async profile => {
		await withDebugSession(profile, 'REG-inspect-memory', async session => {
			const [frame] = await session.frames();
			const memoryReference = frame.instructionPointerReference;
			assert.ok(memoryReference, 'Frame has no code address');
			for (const [offset, count] of [[0, 32], [8, 8]]) {
				const address: number = Number(memoryReference) + offset;
				const expected = executableBytes(profile.program, address, count);
				const response: DebugProtocol.ReadMemoryResponse['body'] = await session.request('readMemory', { memoryReference, offset, count });
				assert.ok(response?.data, 'Missing code bytes');
				assert.strictEqual(Number(response.address), address, 'Wrong memory response address');
				assert.strictEqual(response.unreadableBytes ?? 0, 0, 'Executable bytes are unreadable');
				const actual: Buffer = Buffer.from(response.data, 'base64');
				assert.strictEqual(actual.length, count, 'Wrong memory response length');
				assert.deepStrictEqual(actual, expected, 'Code memory differs from the matching ELF');
			}
			await session.assertLocation(profile.entry);
		});
	});

	hardwareTest('[REG inspect-disassembly] decoded instructions and signed offsets match the ELF window', async profile => {
		await withDebugSession(profile, 'REG-inspect-disassembly', async session => {
			const [frame] = await session.frames();
			const memoryReference = frame.instructionPointerReference;
			assert.ok(memoryReference, 'Frame has no code address');
			const baseline = await session.request<DebugProtocol.DisassembleResponse['body']>('disassemble', {
				memoryReference, instructionCount: 8
			});
			assert.ok(baseline, 'Missing disassembly response');
			assert.strictEqual(baseline.instructions.length, 8, 'Wrong disassembly count');
			let address = Number(memoryReference);
			for (const instruction of baseline.instructions) {
				assert.strictEqual(Number(instruction.address), address, 'Non-contiguous disassembly or wrong start PC');
				assert.ok(instruction.instruction.trim() && !/^\s*\.(byte|half|word)\b/i.test(instruction.instruction), 'Missing real instruction decoding');
				const hex = instruction.instructionBytes?.replace(/\s/g, '');
				assert.ok(hex && /^(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(hex), 'Invalid TriCore opcode bytes');
				const bytes = Buffer.from(hex, 'hex');
				assert.deepStrictEqual(bytes, executableBytes(profile.program, address, bytes.length), 'Disassembly opcode differs from ELF');
				address += bytes.length;
			}
			for (const [anchor, offset, start] of [[0, 2, 2], [3, -2, 1]]) {
				const result: DebugProtocol.DisassembleResponse['body'] = await session.request('disassemble', {
					memoryReference: baseline.instructions[anchor].address, instructionOffset: offset, instructionCount: 4
				});
				assert.ok(result, 'Missing offset disassembly response');
				assert.deepStrictEqual(result.instructions, baseline.instructions.slice(start, start + 4), `Wrong instructionOffset ${offset}`);
			}
			await session.assertLocation(profile.entry);
		});
	});
});
