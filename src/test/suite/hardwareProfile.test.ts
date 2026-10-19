import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadHardwareProfile, parseHardwareProfile, positiveInteger } from '../hardwareProfile';

function fixture() {
	const point = { source: 'main.c', line: 10, function: 'core0_main' };
	const step = { from: point, to: point };
	return {
		program: 'firmware.elf', workspace: '.', agentPath: 'agent.exe', targetDevice: 'test-board',
		svdFile: 'device.svd',
		core: 0, threadPatterns: ['core 0', 'core 1', 'core 2'], entry: point, beforeEntry: point,
		loopBreakpoint: point, steps: { stepIn: step, next: step, stepOut: step },
		fixtureVersion: 'fixture-1', compilerVersion: 'compiler-1', agentVersion: 'agent-1'
	};
}

suite('Hardware profile preflight (offline)', () => {
	test('does not access hardware or files without explicit opt-in', () => {
		const environment: NodeJS.ProcessEnv = {};
		environment.AURIX_TEST_PROFILE = 'missing.json';
		assert.strictEqual(loadHardwareProfile(environment), undefined);
	});

	test('fails instead of skipping when an opted-in profile is missing', () => {
		const environment: NodeJS.ProcessEnv = {};
		environment.AURIX_TEST_HARDWARE = '1';
		assert.throws(() => loadHardwareProfile(environment), /AURIX_TEST_PROFILE/);
	});

	test('resolves paths relative to the profile and preserves an external agent', () => {
		const profile = parseHardwareProfile({ ...fixture(), autoStartAgent: false }, path.resolve('fixtures'));
		assert.strictEqual(profile.autoStartAgent, false);
		assert.strictEqual(profile.program, path.resolve('fixtures', 'firmware.elf'));
		assert.strictEqual(profile.svdFile, path.resolve('fixtures', 'device.svd'));
		assert.strictEqual(profile.entry.source, path.resolve('fixtures', 'main.c'));
	});

	test('requires a register description for a managed agent', () => {
		for (const svdFile of [undefined, '', '   ', 42]) {
			assert.throws(() => parseHardwareProfile({ ...fixture(), svdFile }, '.'), /svdFile/);
		}
		const external = parseHardwareProfile({ ...fixture(), autoStartAgent: false, svdFile: undefined }, '.');
		assert.strictEqual(external.svdFile, undefined);
	});

	test('requires an exact source line and an in-range target core', () => {
		assert.throws(() => parseHardwareProfile({ ...fixture(), core: 3 }, '.'), /core/);
		assert.throws(() => parseHardwareProfile({ ...fixture(), entry: { ...fixture().entry, line: 0 } }, '.'), /entry.line/);
	});

	test('rejects invalid patterns, timeouts and ambiguous booleans', () => {
		assert.throws(() => parseHardwareProfile({ ...fixture(), threadPatterns: ['['] }, '.'), SyntaxError);
		assert.throws(() => parseHardwareProfile({ ...fixture(), timeoutMs: -1 }, '.'), /timeoutMs/);
		assert.throws(() => parseHardwareProfile({ ...fixture(), autoStartAgent: 'false' }, '.'), /autoStartAgent/);
	});

	test('rejects a zero-run or fractional stress configuration', () => {
		assert.throws(() => positiveInteger('0', 'runs'), /runs/);
		assert.throws(() => positiveInteger('1.5', 'runs'), /runs/);
		assert.strictEqual(positiveInteger('100', 'runs'), 100);
	});

	test('validates optional per-core breakpoint fixtures without changing older profiles', () => {
		assert.strictEqual(parseHardwareProfile(fixture(), '.').coreBreakpoints, undefined);
		const points = [fixture().entry, fixture().entry, fixture().entry];
		const profile = parseHardwareProfile({ ...fixture(), coreBreakpoints: points }, '.');
		assert.strictEqual(profile.coreBreakpoints?.length, 3);
		assert.strictEqual(profile.coreBreakpoints[1].source, path.resolve('main.c'));
		for (const coreBreakpoints of [null, {}, [], points.slice(1), [...points, points[0]]]) {
			assert.throws(() => parseHardwareProfile({ ...fixture(), coreBreakpoints }, '.'), /coreBreakpoints/);
		}
		assert.throws(() => parseHardwareProfile({
			...fixture(), coreBreakpoints: [points[0], { ...points[1], line: 0 }, points[2]]
		}, '.'), /coreBreakpoints\[1\].line/);
	});

	test('rejects an uncalibrated example profile', () => {
		assert.throws(() => parseHardwareProfile({ ...fixture(), fixtureVersion: 'REPLACE_WITH_VERSION' }, '.'), /placeholder/);
	});

	test('validates the optional exact core-entry fixture for focus tests', () => {
		assert.strictEqual(parseHardwareProfile(fixture(), '.').coreEntry, undefined);
		const profile = parseHardwareProfile({ ...fixture(), coreEntry: fixture().entry }, '.');
		assert.strictEqual(profile.coreEntry?.source, path.resolve('main.c'));
		for (const coreEntry of [null, { ...fixture().entry, line: 0 }]) {
			assert.throws(() => parseHardwareProfile({ ...fixture(), coreEntry }, '.'), /coreEntry/);
		}
	});

	test('validates a startup breakpoint on a separately selected core', () => {
		const startupBreakpoint = { core: 1, point: fixture().entry };
		assert.strictEqual(parseHardwareProfile({ ...fixture(), startupBreakpoint }, '.').startupBreakpoint?.core, 1);
		for (const core of [-1, 3, 0.5, '1']) {
			assert.throws(() => parseHardwareProfile({
				...fixture(), startupBreakpoint: { ...startupBreakpoint, core }
			}, '.'), /startupBreakpoint.core/);
		}
		assert.throws(() => parseHardwareProfile({
			...fixture(), startupBreakpoint: { core: 1, point: null }
		}, '.'), /startupBreakpoint.point/);
	});

	test('checks source locations and ELF magic using local files only', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurix-preflight-'));
		try {
			const environment: NodeJS.ProcessEnv = {};
			environment.AURIX_TEST_HARDWARE = '1';
			environment.AURIX_TEST_PROFILE = path.join(directory, 'profile.json');
			fs.writeFileSync(environment.AURIX_TEST_PROFILE, JSON.stringify(fixture()));
			fs.writeFileSync(path.join(directory, 'main.c'), 'int counter;\n'.repeat(20));
			fs.writeFileSync(path.join(directory, 'agent.exe'), 'test fixture only');
			fs.writeFileSync(path.join(directory, 'firmware.elf'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
			assert.throws(() => loadHardwareProfile(environment), /ENOENT.*device\.svd/);
			fs.mkdirSync(path.join(directory, 'device.svd'));
			assert.throws(() => loadHardwareProfile(environment), /svdFile must be a file/);
			fs.rmdirSync(path.join(directory, 'device.svd'));
			fs.writeFileSync(path.join(directory, 'device.svd'), '<device />');
			assert.strictEqual(loadHardwareProfile(environment)?.entry.line, 10);
			fs.writeFileSync(environment.AURIX_TEST_PROFILE, JSON.stringify({
				...fixture(),
				coreBreakpoints: [fixture().entry, { source: 'missing-core.c', line: 1, function: 'core1_main' }, fixture().entry]
			}));
			assert.throws(() => loadHardwareProfile(environment), /ENOENT.*missing-core\.c/);
			fs.writeFileSync(environment.AURIX_TEST_PROFILE, JSON.stringify({
				...fixture(), coreEntry: { source: 'missing-entry.c', line: 1, function: 'core0_main' }
			}));
			assert.throws(() => loadHardwareProfile(environment), /ENOENT.*missing-entry\.c/);
			fs.writeFileSync(environment.AURIX_TEST_PROFILE, JSON.stringify(fixture()));
			fs.writeFileSync(path.join(directory, 'firmware.elf'), 'not an ELF');
			assert.throws(() => loadHardwareProfile(environment), /must be an ELF/);
			fs.writeFileSync(path.join(directory, 'main.c'), 'int counter;\n');
			assert.throws(() => loadHardwareProfile(environment), /Missing source code/);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});