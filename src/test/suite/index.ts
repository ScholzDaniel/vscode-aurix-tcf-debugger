import * as path from 'path';
import * as fs from 'fs';
import * as Mocha from 'mocha';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
	const useReport = process.env.AURIX_TEST_REPORT === '1' || process.env.AURIX_TEST_REPORT === 'true';
	const reporter = process.env.MOCHA_REPORTER || (useReport ? 'mocha-junit-reporter' : 'spec');
	const results = path.resolve(process.env.AURIX_TEST_RESULTS || 'test-results');
	const reportFile = process.env.MOCHA_FILE || (useReport ? path.join(results, 'junit.xml') : '');
	const reporterOptions = reportFile ? { mochaFile: reportFile } : undefined;
	if (reportFile) {
		fs.mkdirSync(path.dirname(reportFile), { recursive: true });
	}
	const hardware = process.env.AURIX_TEST_HARDWARE === '1';
	const isolatePeripheralViewer = hardware && process.env.AURIX_TEST_ISOLATE_PERIPHERAL === '1';
	const mocha = new Mocha({
		ui: 'tdd', timeout: 120000, reporter, reporterOptions,
		failZero: true, forbidPending: hardware, bail: hardware
	});
	if (process.env.AURIX_TEST_GREP) {
		mocha.grep(new RegExp(process.env.AURIX_TEST_GREP));
	}
	const testsRoot = path.resolve(__dirname);
	mocha.addFile(path.join(testsRoot, 'dapEvents.test'));
	mocha.addFile(path.join(testsRoot, 'hardwareProfile.test'));
	mocha.addFile(path.join(testsRoot, 'threadCache.test'));
	mocha.addFile(path.join(testsRoot, 'stepOutStop.test'));
	mocha.addFile(path.join(testsRoot, 'expressionValues.test'));
	mocha.addFile(path.join(testsRoot, 'instructionControl.test'));
	mocha.addFile(path.join(testsRoot, 'breakpointStopBarrier.test'));
	mocha.addFile(path.join(testsRoot, 'stopFocusEvents.test'));
	mocha.addFile(path.join(testsRoot, 'flashing.test'));
	mocha.addFile(path.join(testsRoot, 'breakpoint.stopat.test'));
	mocha.addFile(path.join(testsRoot, 'acs.regression.test'));
	mocha.addFile(path.join(testsRoot, 'dataInspection.test'));
	mocha.addFile(path.join(testsRoot, 'executionReferences.test'));
	mocha.addFile(path.join(testsRoot, 'instructionFlow.test'));
	mocha.addFile(path.join(testsRoot, 'multicoreStops.test'));
	mocha.addFile(path.join(testsRoot, 'stopFocus.test'));
	mocha.addFile(path.join(testsRoot, 'debug.stress.test'));
	const peripheralConfig = vscode.workspace.getConfiguration('mcu-debug.peripheral-viewer');
	const originalSvdPathConfig = peripheralConfig.inspect<string>('svdPathConfig')?.globalValue;
	try {
		if (isolatePeripheralViewer) {
			// Keep the agent's SVD while leaving the viewer's separate configuration key unset.
			await peripheralConfig.update('svdPathConfig', 'aurixTestPeripheralSvdFile', vscode.ConfigurationTarget.Global);
			if (vscode.workspace.getConfiguration('mcu-debug.peripheral-viewer').get('svdPathConfig') !== 'aurixTestPeripheralSvdFile') {
				throw new Error('Cannot isolate Peripheral Viewer: svdPathConfig is overridden by workspace settings');
			}
		}
		await new Promise<void>((resolve, reject) => {
			const outcomes: Array<{ name: string; status: string; durationMs?: number; error?: string }> = [];
			const runner = mocha.run((failures) => {
				fs.mkdirSync(results, { recursive: true });
				fs.writeFileSync(path.join(results, 'summary.json'), JSON.stringify({
					hardwareRequested: hardware, isolatePeripheralViewer, stats: runner.stats, tests: outcomes
				}, null, 2) + '\n');
				if (failures || runner.total === 0) {
					reject(new Error(`${failures} failures; ${runner.total} selected tests`));
				} else {
					resolve();
				}
			});
			runner.on('pass', test => outcomes.push({ name: test.fullTitle(), status: 'PASS', durationMs: test.duration }));
			runner.on('pending', test => outcomes.push({ name: test.fullTitle(), status: 'SKIP' }));
			runner.on('fail', (test, error) => outcomes.push({ name: test.fullTitle(), status: 'FAIL', durationMs: test.duration, error: error.stack }));
		});
	} finally {
		if (isolatePeripheralViewer) {
			await peripheralConfig.update('svdPathConfig', originalSvdPathConfig, vscode.ConfigurationTarget.Global);
		}
	}
}
