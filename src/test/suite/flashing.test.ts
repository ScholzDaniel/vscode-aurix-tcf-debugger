import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFlasherArgs, collectFlashHexFiles, createFlashingPlan, selectFlasherDeviceId } from '../../flashing';
import { resolveConfigPath } from '../../configPaths';

suite('Integrated flashing (offline)', () => {
	let directory: string;
	let program: string;
	let ppu: string;
	let cdsp: string;

	setup(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurix-flashing-'));
		program = path.join(directory, 'program.elf');
		ppu = path.join(directory, 'ppu.ELF');
		cdsp = path.join(directory, 'cdsp.elf');
		fs.writeFileSync(program, '');
		fs.writeFileSync(path.join(directory, 'ppu.hex'), '');
		fs.writeFileSync(path.join(directory, 'cdsp.hex'), '');
	});

	teardown(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('allows debug-only configurations without modifying them', () => {
		for (const config of [{}, { enableFlashing: false, ppuFlashHex: false, cdspFlashHex: false }]) {
			const before = { ...config };
			assert.strictEqual(createFlashingPlan(config), undefined);
			assert.deepStrictEqual(config, before);
		}
	});

	test('restores every PPU/CDSP combination with the master flashing switch', () => {
		for (let mask = 0; mask < 8; mask++) {
			const config = {
				program, ppuElfPath: ppu, cdspElfPaths: ['', cdsp, ''],
				enableFlashing: Boolean(mask & 1), ppuFlashHex: Boolean(mask & 2), cdspFlashHex: Boolean(mask & 4),
			};
			const expectedHex = [
				...(config.ppuFlashHex ? [path.join(directory, 'ppu.hex')] : []),
				...(config.cdspFlashHex ? [path.join(directory, 'cdsp.hex')] : []),
			];
			assert.deepStrictEqual(createFlashingPlan(config),
				config.enableFlashing ? { elfPath: program, hexFiles: expectedHex } : undefined);
		}
	});

	test('resolves all selected paths before checking files', () => {
		const resolved: unknown[] = [];
		const plan = createFlashingPlan({
			enableFlashing: true, program: 'program.elf',
			ppuFlashHex: true, ppuElfPath: 'ppu.ELF',
			cdspFlashHex: true, cdspElfPaths: ['cdsp.elf'],
		}, value => {
			resolved.push(value);
			return typeof value === 'string' ? path.join(directory, value) : undefined;
		});
		assert.deepStrictEqual(resolved, ['ppu.ELF', 'cdsp.elf', 'program.elf']);
		assert.deepStrictEqual(plan, { elfPath: program, hexFiles: [path.join(directory, 'ppu.hex'), path.join(directory, 'cdsp.hex')] });
	});

	test('rejects missing program paths and directories instead of flashing', () => {
		assert.throws(() => createFlashingPlan({ enableFlashing: true }), /no program\/ELF path/);
		assert.throws(() => createFlashingPlan({ enableFlashing: true, program: path.join(directory, 'missing.elf') }), /ELF file not found/);
		assert.throws(() => createFlashingPlan({ enableFlashing: true, program: directory }), /ELF file not found/);
	});

	test('uses the same workspace path resolution for panel and launch validation', () => {
		assert.strictEqual(resolveConfigPath(undefined, directory), undefined);
		assert.strictEqual(resolveConfigPath(' ', directory), undefined);
		assert.strictEqual(resolveConfigPath(program, directory), program);
		assert.strictEqual(resolveConfigPath('program.elf', directory), program);
		assert.strictEqual(resolveConfigPath('${workspaceFolder}/program.elf', directory), program);
		assert.strictEqual(resolveConfigPath('${workspaceRoot}/program.elf', directory), program);
		assert.deepStrictEqual(createFlashingPlan({
			enableFlashing: true, program: '${workspaceFolder}/program.elf',
			ppuFlashHex: true, ppuElfPath: 'ppu.ELF',
		}, value => resolveConfigPath(value, directory)), {
			elfPath: program, hexFiles: [path.join(directory, 'ppu.hex')],
		});
	});

	test('reports missing selections for both PPU and CDSP', () => {
		assert.throws(() => collectFlashHexFiles({ ppuFlashHex: true, cdspFlashHex: true, cdspElfPaths: ['', null, 12] }),
			/PPU:.*no ELF file.*\nCDSP:.*no ELF files/);
	});

	test('reports every missing HEX and preserves CDSP core indices', () => {
		assert.throws(() => collectFlashHexFiles({
			ppuFlashHex: true, ppuElfPath: path.join(directory, 'missing-ppu.elf'),
			cdspFlashHex: true, cdspElfPaths: ['', path.join(directory, 'missing-cdsp.elf')],
		}), /PPU: HEX file not found:.*\nCDSP1: HEX file not found:/);
	});

	test('does not pass non-ELF paths or directories as HEX files', () => {
		assert.throws(() => collectFlashHexFiles({ ppuFlashHex: true, ppuElfPath: program + '.bak' }), /ending in \.elf/);
		fs.mkdirSync(path.join(directory, 'folder.hex'));
		assert.throws(() => collectFlashHexFiles({ ppuFlashHex: true, ppuElfPath: path.join(directory, 'folder.elf') }), /HEX file not found/);
	});

	test('builds one Eclipse-compatible invocation without shell quoting paths', () => {
		assert.deepStrictEqual(buildFlasherArgs('C:\\my project\\app.elf', ['C:\\my project\\ppu.hex', 'C:\\cdsp.hex'], '2'), [
			'-gui', 'off', '-elf', 'C:\\my project\\app.elf',
			'-hex', 'C:\\my project\\ppu.hex', '-hex', 'C:\\cdsp.hex',
			'-start', 'off', '-ver', 'on', '-id', '2',
		]);
		assert.deepStrictEqual(buildFlasherArgs(program, [], '0'),
			['-gui', 'off', '-elf', program, '-start', 'off', '-ver', 'on', '-id', '0']);
	});

	const devices = [
		{ id: '0', name: 'Board A', family: 'TC37x' },
		{ id: '1', name: 'Board B', family: 'TC4Dx' },
	];

	test('selects a sole device, exact name, or unique family', () => {
		assert.strictEqual(selectFlasherDeviceId([devices[0]], undefined), '0');
		assert.strictEqual(selectFlasherDeviceId(devices, ' board b '), '1');
		assert.strictEqual(selectFlasherDeviceId(devices, 'tc37x'), '0');
	});

	test('rejects numeric, absent, unknown, or ambiguous device selections', () => {
		assert.throws(() => selectFlasherDeviceId(devices, '0'), /not a numeric id/);
		assert.throws(() => selectFlasherDeviceId([], undefined), /No devices detected/);
		assert.throws(() => selectFlasherDeviceId(devices, undefined), /Multiple devices detected/);
		assert.throws(() => selectFlasherDeviceId(devices, 'other'), /not found/);
		assert.throws(() => selectFlasherDeviceId([...devices, { id: '2', name: 'Board C', family: 'TC37x' }], 'TC37x'),
			/matches multiple devices/);
	});
});
