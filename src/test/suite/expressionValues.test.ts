/* eslint-disable @typescript-eslint/naming-convention -- TCF wire-format property names. */
import * as assert from 'assert';
import { SmallCommandStamper } from '../../tcf';
import { TCFClient } from '../../tcfclient';
import { ValueProperties } from '../../tcf/expressions';
import { TCFSymbolClass, TCFSymbolContextData, TCFTypeClass } from '../../tcf/symbols';
import { SimpleCommand } from '../../tcf/tcfutils';

class ExpressionClient extends TCFClient {
	readonly errors: string[] = [];
	readonly commands: string[] = [];
	wireValue: Buffer;
	properties: ValueProperties | null = { Class: TCFTypeClass.integer };
	context: { ID: string; Class?: number; Size?: number; Type?: string };
	type: TCFSymbolContextData = { ID: 'int', Class: TCFSymbolClass.type, TypeClass: TCFTypeClass.integer, Size: 4, Name: 'int' };
	evaluationError?: { Code: number; Format: string };

	constructor(bytes = Buffer.from('2a00000000000000', 'hex')) {
		const errors: string[] = [];
		super({
			sent: () => undefined, received: () => undefined, log: () => undefined,
			stdout: () => undefined, error: message => { errors.push(message); }
		}, new SmallCommandStamper());
		this.errors = errors;
		this.wireValue = Buffer.from(JSON.stringify(bytes.toString('base64')));
		this.context = { ID: 'EXPR0', Class: TCFTypeClass.integer, Size: bytes.length };
	}

	override async sendCommand<T>(command: SimpleCommand<T>): Promise<T> {
		const name = `${command.service()}.${command.command()}`;
		this.commands.push(name);
		switch (name) {
			case 'Expressions.evaluate':
				return command.resultPromise([
					this.wireValue,
					this.evaluationError ? Buffer.from(JSON.stringify(this.evaluationError)) : Buffer.alloc(0),
					Buffer.from(JSON.stringify(this.evaluationError ? null : this.properties))
				]);
			case 'Expressions.getContext':
				return command.resultPromise([Buffer.alloc(0), Buffer.from(JSON.stringify(this.context))]);
			case 'Symbols.getContext':
				return command.resultPromise([Buffer.alloc(0), Buffer.from(JSON.stringify(this.type))]);
			default:
				throw new Error(`Unexpected command ${name}`);
		}
	}

	async display(): Promise<string | undefined> {
		const variable = await this.getExpressionIDVariable('core0', 'frame0', 'EXPR0', 'expression');
		assert.ok(variable, 'Missing expression variable');
		assert.deepStrictEqual(await variable.getChildren(), []);
		return variable.displayValue();
	}

	protected onBreakpoint(): void { throw new Error('Unexpected breakpoint'); }
	protected onBreakpointRemoved(): void { throw new Error('Unexpected breakpoint removal'); }
	protected onBreakpointAdded(): void { throw new Error('Unexpected breakpoint addition'); }
	protected onBreakpointChanged(): void { throw new Error('Unexpected breakpoint change'); }
}

suite('Expression value conversion (offline)', () => {
	test('renders the observed Class-only, JSON-base64 response as 42', async () => {
		const client = new ExpressionClient();
		assert.strictEqual(await client.display(), '42');
		assert.deepStrictEqual(client.commands, ['Expressions.evaluate', 'Expressions.getContext']);
		assert.deepStrictEqual(client.errors, []);
	});

	test('uses expression context class when evaluate omits it', async () => {
		const client = new ExpressionClient();
		client.properties = {};
		assert.strictEqual(await client.display(), '42');
	});

	test('decodes raw, unquoted-base64 and JSON-base64 values without confusing raw ASCII bytes', async () => {
		const bytes = Buffer.from('2a000000', 'hex');
		for (const wire of [bytes, Buffer.from(bytes.toString('base64')), Buffer.from(JSON.stringify(bytes.toString('base64')))]) {
			const client = new ExpressionClient(bytes);
			client.wireValue = wire;
			assert.strictEqual(await client.display(), '42');
		}
		const client = new ExpressionClient(Buffer.from('AAAA'));
		client.wireValue = Buffer.from('AAAA');
		assert.strictEqual(await client.display(), '1094795585');
	});

	test('preserves signedness, endian order and exact 64-bit integer precision', async () => {
		for (const [hex, typeClass, bigEndian, expected] of [
			['d6ffffffffffffff', TCFTypeClass.integer, false, '-42'],
			['ffffffffffffffd6', TCFTypeClass.integer, true, '-42'],
			['ffffffffffffffff', TCFTypeClass.cardinal, false, '18446744073709551615'],
			['0100000000002000', TCFTypeClass.integer, false, '9007199254740993'],
			['0020000000000001', TCFTypeClass.cardinal, true, '9007199254740993']
		] as const) {
			const client = new ExpressionClient(Buffer.from(hex, 'hex'));
			client.properties = { Class: typeClass, BigEndian: bigEndian };
			assert.strictEqual(await client.display(), expected);
		}
	});

	test('renders one-byte numeric expressions as numbers, not guessed characters', async () => {
		for (const [typeClass, expected] of [[TCFTypeClass.integer, '-1'], [TCFTypeClass.cardinal, '255']] as const) {
			const client = new ExpressionClient(Buffer.from([255]));
			client.properties = { Class: typeClass };
			assert.strictEqual(await client.display(), expected);
		}
	});

	test('renders floating-point scalars in both endian orders', async () => {
		for (const [hex, bigEndian] of [['0000c03f', false], ['3fc00000', true], ['000000000000f83f', false], ['3ff8000000000000', true]] as const) {
			const client = new ExpressionClient(Buffer.from(hex, 'hex'));
			client.properties = { Class: TCFTypeClass.real, BigEndian: bigEndian };
			assert.strictEqual(await client.display(), '1.5');
		}
	});

	test('retains the typed symbol path and its character formatting', async () => {
		const integer = new ExpressionClient(Buffer.from('2a000000', 'hex'));
		integer.properties = { Type: 'int' };
		assert.strictEqual(await integer.display(), '42');
		assert.deepStrictEqual(integer.commands, ['Expressions.evaluate', 'Symbols.getContext']);
		const character = new ExpressionClient(Buffer.from([65]));
		character.properties = { Type: 'char' };
		character.type = { ID: 'char', Class: TCFSymbolClass.type, TypeClass: TCFTypeClass.cardinal, Size: 1, Name: 'char' };
		assert.strictEqual(await character.display(), "'A'");
	});

	test('uses a Type supplied by getContext instead of inventing scalar metadata', async () => {
		const client = new ExpressionClient(Buffer.from('2a000000', 'hex'));
		client.context.Type = 'int';
		assert.strictEqual(await client.display(), '42');
		assert.deepStrictEqual(client.commands, ['Expressions.evaluate', 'Expressions.getContext', 'Symbols.getContext']);
	});

	test('rejects unsupported, absent, scaled and fragmented metadata explicitly', async () => {
		for (const properties of [
			null, { Class: TCFTypeClass.complex }, { Class: TCFTypeClass.pointer },
			{ Class: TCFTypeClass.integer, BinaryScale: 2 },
			{ Class: TCFTypeClass.integer, DecimalScale: 1 },
			{ Class: TCFTypeClass.integer, ImplicitPointer: true },
			{ Class: TCFTypeClass.integer, Pieces: [{ Size: 8 }] }
		]) {
			const client = new ExpressionClient();
			client.properties = properties;
			await assert.rejects(client.display(), /Cannot display expression/);
		}
		const client = new ExpressionClient();
		client.properties = {};
		delete client.context.Class;
		await assert.rejects(client.display(), /unsupported scalar metadata/);
	});

	test('rejects empty, unsupported-width and truncated values instead of returning blank success', async () => {
		for (const bytes of [Buffer.alloc(0), Buffer.alloc(3)]) {
			await assert.rejects(new ExpressionClient(bytes).display(), /unsupported scalar metadata or value width/);
		}
		const client = new ExpressionClient();
		client.context.Size = 4;
		await assert.rejects(client.display(), /unsupported scalar metadata or value width/);
	});

	test('propagates evaluation failure and can evaluate again afterward', async () => {
		const client = new ExpressionClient();
		client.evaluationError = { Code: 22, Format: 'Invalid expression' };
		await assert.rejects(client.display());
		assert.strictEqual(client.errors.length, 1);
		client.evaluationError = undefined;
		assert.strictEqual(await client.display(), '42');
	});
});
