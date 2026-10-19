import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { HardwareProfile, loadHardwareProfile, positiveInteger } from './hardwareProfile';

async function main() {
	const root = path.resolve(__dirname, '../../');
	process.env.AURIX_TEST_RESULTS = path.resolve(process.env.AURIX_TEST_RESULTS || path.join(root, 'test-results'));
	const profile = loadHardwareProfile();
	if (process.env.AURIX_TEST_PROFILE) {
		process.env.AURIX_TEST_PROFILE = path.resolve(process.env.AURIX_TEST_PROFILE);
	}
	if (profile) {
		positiveInteger(process.env.AURIX_TEST_RUNS ?? '10', 'AURIX_TEST_RUNS');
		positiveInteger(process.env.AURIX_TEST_BP_CYCLES ?? '10', 'AURIX_TEST_BP_CYCLES');
	}
	if (process.env.AURIX_TEST_GREP) {
		new RegExp(process.env.AURIX_TEST_GREP);
	}
	if (process.argv.includes('--preflight')) {
		if (!profile) {
			throw new Error('Preflight requires AURIX_TEST_HARDWARE=1 and AURIX_TEST_PROFILE');
		}
		console.log('Hardware profile preflight passed. No agent, board or VS Code test host was started.');
		return;
	}
	const lockPath = path.join(root, '.vscode-test', 'test.lock');
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	let lock: number;
	try {
		lock = fs.openSync(lockPath, 'wx');
	} catch (error) {
		throw new Error(`Cannot acquire test-host lock ${lockPath}. Check for a running test process before removing a stale lock.`, { cause: error });
	}
	try {
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hardware: Boolean(profile), device: profile?.targetDevice }));
		delete process.env.ELECTRON_RUN_AS_NODE;
		delete process.env.NODE_OPTIONS;
		await runLocked(profile);
	} finally {
		fs.closeSync(lock);
		fs.unlinkSync(lockPath);
	}
}

async function runLocked(profile?: HardwareProfile) {
	const extensionDevelopmentPath = path.resolve(__dirname, '../../');
	const extensionTestsPath = path.resolve(__dirname, './suite/index');
	const vscodeTestRoot = path.resolve(extensionDevelopmentPath, '.vscode-test');
	const extensionsDir = path.resolve(vscodeTestRoot, 'extensions');
	const userDataDir = path.resolve(vscodeTestRoot, 'user-data');
	fs.mkdirSync(extensionsDir, { recursive: true });
	fs.mkdirSync(userDataDir, { recursive: true });
	const dependencyIds = ['mcu-debug.peripheral-viewer', 'eclipse-cdt.memory-inspector'];
	const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.AURIX_TEST_VSCODE_VERSION || 'stable');
	const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
	for (const id of dependencyIds) {
		const alreadyInstalled = fs.readdirSync(extensionsDir, { withFileTypes: true })
			.filter(directory => directory.isDirectory())
			.some(directory => directory.name.toLowerCase().startsWith(id.toLowerCase() + '-'));
		if (alreadyInstalled) {
			continue;
		}
		try {
			const installArgs = [...cliArgs, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--install-extension', id, '--force'];
			if (process.platform === 'win32') {
				execFileSync('cmd.exe', ['/c', cliPath, ...installArgs], { stdio: 'inherit' });
			} else {
				execFileSync(cliPath, installArgs, { stdio: 'inherit' });
			}
		} catch (error) {
			throw new Error(`Failed to install test dependency '${id}' into ${extensionsDir}`, { cause: error });
		}
	}
	const workspacePath = profile?.workspace || extensionDevelopmentPath;
	const results = process.env.AURIX_TEST_RESULTS!;
	fs.mkdirSync(results, { recursive: true });
	const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
	const sources = profile ? [...new Set([
		profile.entry.source, profile.beforeEntry.source, profile.loopBreakpoint.source,
		...(profile.coreEntry ? [profile.coreEntry.source] : []),
		...(profile.startupBreakpoint ? [profile.startupBreakpoint.point.source] : []),
		...(profile.coreBreakpoints ?? []).map(point => point.source),
		...Object.values(profile.steps).flatMap(step => [step.from.source, step.to.source])
	])] : [];
	fs.writeFileSync(path.join(results, 'manifest.json'), JSON.stringify({
		startedAt: new Date().toISOString(), hardwareRequested: Boolean(profile),
		isolatePeripheralViewer: Boolean(profile) && process.env.AURIX_TEST_ISOLATE_PERIPHERAL === '1',
		vscodeExecutablePath, nodeVersion: process.version, platform: process.platform,
		extensionVersion: JSON.parse(fs.readFileSync(path.join(extensionDevelopmentPath, 'package.json'), 'utf8')).version,
		installedExtensions: fs.readdirSync(extensionsDir), profile,
		elfSha256: profile ? hash(profile.program) : undefined,
		agentSha256: profile?.autoStartAgent ? hash(profile.agentPath) : undefined,
		svdSha256: profile?.svdFile ? hash(profile.svdFile) : undefined,
		sources: sources.map(source => ({ source, sha256: hash(source) }))
	}, null, 2) + '\n');
	await runTests({
		extensionDevelopmentPath,
		extensionTestsPath,
		vscodeExecutablePath,
		launchArgs: [workspacePath, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir],
	});
}

main().catch((error) => {
	console.error(error);
	const results = process.env.AURIX_TEST_RESULTS || path.resolve(__dirname, '../../test-results');
	fs.mkdirSync(results, { recursive: true });
	fs.writeFileSync(path.join(results, 'run-error.json'), JSON.stringify({
		status: 'RUN_ERROR', error: error instanceof Error ? error.stack : String(error)
	}, null, 2) + '\n');
	process.exit(1);
});
