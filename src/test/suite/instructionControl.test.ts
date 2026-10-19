/* eslint-disable @typescript-eslint/naming-convention -- TCF wire-format property names. */
import * as assert from 'assert';
import { SmallCommandStamper } from '../../tcf';
import { TCFClient } from '../../tcfclient';
import { DisassemblyLine } from '../../tcf/disassembly';
import { SimpleCommand } from '../../tcf/tcfutils';
import { disassemblyWindow } from '../../disassemblyWindow';

class ModeClient extends TCFClient {
	readonly requests: string[][] = [];

	constructor() {
		super({
			sent: () => undefined, received: () => undefined, log: () => undefined,
			stdout: () => undefined, error: message => { throw new Error(message); }
		}, new SmallCommandStamper());
	}

	override async sendCommand<T>(command: SimpleCommand<T>): Promise<T> {
		assert.strictEqual(command.service(), 'RunControl', 'Unexpected service');
		assert.strictEqual(command.command(), 'resume', 'Unexpected command');
		this.requests.push(command.toBuffer('test').toString().split('\0').slice(2, 7));
		return command.resultPromise([Buffer.alloc(0)]);
	}

	protected onBreakpoint(): void { throw new Error('Unexpected breakpoint'); }
	protected onBreakpointRemoved(): void { throw new Error('Unexpected breakpoint removal'); }
	protected onBreakpointAdded(): void { throw new Error('Unexpected breakpoint addition'); }
	protected onBreakpointChanged(): void { throw new Error('Unexpected breakpoint change'); }
}

function instruction(address: number, size = 2, text = 'nop'): DisassemblyLine {
	return {
		Address: address, Size: size, Instruction: [{ Type: 'String', Text: text }],
		OpcodeValue: Buffer.alloc(size).toString('base64')
	};
}

suite('Instruction control and disassembly windows (offline)', () => {
	test('instruction Next sends mode 1 while Step Into sends mode 2', async () => {
		const client = new ModeClient();
		await client.nextInstruction('core0');
		await client.stepInInstruction('core0');
		assert.deepStrictEqual(client.requests, [
			['RunControl', 'resume', '"core0"', '1', '1'],
			['RunControl', 'resume', '"core0"', '2', '1']
		]);
	});

	test('source stepping, Step Out and Continue retain their native modes', async () => {
		const client = new ModeClient();
		await client.next('core0');
		await client.stepIn('core0');
		await client.stepOut('core0');
		await client.continue('core0');
		assert.deepStrictEqual(client.requests.map(request => request[3]), ['3', '4', '5', '0']);
	});

	test('a short ret reply preserves the decoded instruction and pads without inventing opcodes', () => {
		const result = disassemblyWindow([instruction(100, 2, 'ret')], 100, 0, 2);
		assert.strictEqual(result.length, 2);
		assert.deepStrictEqual(result[0], { address: '0x64', instruction: 'ret', instructionBytes: '00 00' });
		assert.deepStrictEqual(result[1], { address: '0x66', instruction: '<not decoded>', presentationHint: 'invalid' });
	});

	test('empty replies produce exactly the requested number of explicitly invalid entries', () => {
		const result = disassemblyWindow([], 100, 0, 4);
		assert.strictEqual(result.length, 4);
		assert.deepStrictEqual(result.map(item => item.address), ['0x64', '0x66', '0x68', '0x6a']);
		assert.ok(result.every(item => item.presentationHint === 'invalid' && item.instructionBytes === undefined));
	});

	test('positive and negative offsets preserve decoded variable-width instruction boundaries', () => {
		const lines = [instruction(100), instruction(102, 4), instruction(106), instruction(108, 4)];
		assert.deepStrictEqual(disassemblyWindow(lines, 100, 1, 2).map(item => item.address), ['0x66', '0x6a']);
		assert.deepStrictEqual(disassemblyWindow(lines, 108, -2, 2).map(item => item.address), ['0x66', '0x6a']);
		assert.ok(disassemblyWindow(lines, 108, -2, 2).every(item => item.presentationHint === undefined));
	});

	test('unavailable leading instructions do not shift the known anchor into the wrong slot', () => {
		const result = disassemblyWindow([instruction(100), instruction(102, 4)], 100, -2, 4);
		assert.strictEqual(result.length, 4);
		assert.ok(result.slice(0, 2).every(item => item.presentationHint === 'invalid'));
		assert.deepStrictEqual(result.slice(2).map(item => item.address), ['0x64', '0x66']);
	});

	test('tail placeholders use the last decoded size even when opcode bytes are absent', () => {
		const line = instruction(100, 4);
		delete line.OpcodeValue;
		const result = disassemblyWindow([line], 100, 1, 3);
		assert.deepStrictEqual(result.map(item => item.address), ['0x68', '0x6a', '0x6c']);
		assert.ok(result.every(item => item.presentationHint === 'invalid'));
	});

	test('a reply missing the requested anchor does not expose unrelated instructions as valid', () => {
		const result = disassemblyWindow([instruction(200)], 100, 0, 2);
		assert.strictEqual(result.length, 2);
		assert.ok(result.every(item => item.presentationHint === 'invalid'));
		assert.strictEqual(result[0].address, '0x64');
	});

	test('zero count produces an empty window and missing instruction text is explicit', () => {
		assert.deepStrictEqual(disassemblyWindow([], 100, 0, 0), []);
		const result = disassemblyWindow([{ Address: 100, Size: 2, Instruction: null }], 100, 0, 1);
		assert.strictEqual(result[0].presentationHint, 'invalid');
		assert.strictEqual(result[0].instruction, '<not decoded>');
	});

	test('invalid counts, offsets, sizes and overflowing addresses are rejected', () => {
		for (const count of [-1, 1.5, NaN, Infinity]) {
			assert.throws(() => disassemblyWindow([], 100, 0, count), /Invalid disassembly window/);
		}
		assert.throws(() => disassemblyWindow([], 100, 0.5, 1), /Invalid disassembly window/);
		assert.throws(() => disassemblyWindow([instruction(100, 0)], 100, 0, 2), /Invalid decoded instruction size/);
		assert.throws(() => disassemblyWindow([], Number.MAX_SAFE_INTEGER, 1, 1), /exceeds supported precision/);
	});
});
