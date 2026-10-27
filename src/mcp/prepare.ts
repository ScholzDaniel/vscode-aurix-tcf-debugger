import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { DebugMcpError, validateWorkspaceSource } from './debugController';
import { launchOptionsSchema, DebugLaunchOptions } from './launch';
import { DasDevice, listDasDevices } from '../deviceDiscovery';
import { elfLoadRanges } from '../memoryInspection';
import { getAutomaticSvd, svdDeviceFamilies } from '../svdCatalog';
import { validateSvdInWorker } from '../svdValidation';

export const prepareOptionsSchema = launchOptionsSchema.pick({
	workspaceFolder: true, program: true, targetDevice: true, core: true,
}).partial();
export type DebugPrepareOptions = {
	workspaceFolder?: string; program?: string; targetDevice?: string; core?: number;
};
export const preparationLimits = Object.freeze({
	entries: 10000, depth: 16, elfCandidates: 64, elfBytes: 128 * 1024 * 1024, programHeaderBytes: 1024 * 1024,
});
const excludedDirectories = ['.git', 'node_modules', '.vscode-test', '.venv', 'venv', '.cache'];
type Issue = { code: string; message: string; path?: string };
type ElfCandidate = {
	program: string; valid: boolean; evidence: 'ELF-header-and-program-headers';
	size?: number; modifiedAt?: string; byteOrder?: 'little-endian' | 'big-endian';
	machine?: number; entry?: string; sha256?: string; unavailable?: string; failureKind?: 'invalid-elf' | 'unavailable';
};
type Scan = {
	complete: boolean; entriesVisited: number; symbolicLinksSkipped: number;
	excludedDirectories: string[]; issues: Issue[]; candidates: ElfCandidate[];
};
export type DebugPreparation = {
	status: 'prepared' | 'needs-input';
	workspaceFolders: string[]; workspaceFolder?: string; selectedProgram?: string;
	core: { index: number; selection: 'explicit' | 'default-cpu0'; hardwareVerified: false };
	elf: Scan; devices: DasDevice[]; selectedDevice?: DasDevice;
	deviceEvidence: 'lsmcdd' | 'not-queried';
	svd?: { path: string; device: string; registerCount: number; evidence: 'device-family-map-and-SVD'; contentValidated: true };
	issues: Issue[]; launchArguments?: DebugLaunchOptions;
};
export type PreparationEnvironment = {
	workspaceFolders: readonly string[]; extensionPath: string;
	listDevices?: (signal: AbortSignal) => Promise<DasDevice[]>;
	// A live progress view; retain a copy when returning diagnostics to a caller.
	onProgress?: (progress: PreparationProgress) => void;
};
export type PreparationStage = 'workspace' | 'elf-scan' | 'elf-validation' | 'device-enumeration' |
	'svd-matching' | 'svd-read' | 'svd-parse' | 'elf-hash' | 'complete';
export type PreparationProgress = {
	stage: PreparationStage; currentPath?: string; elapsedMs: number; stageElapsedMs: number;
	completedStages: Array<{ stage: PreparationStage; elapsedMs: number }>;
	partial: Pick<DebugPreparation, 'workspaceFolders' | 'workspaceFolder' | 'core' | 'elf' | 'devices' |
		'deviceEvidence' | 'selectedDevice' | 'svd' | 'issues'> & { svdPath?: string };
};

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function inspectElf(program: string, workspace: string, signal: AbortSignal, hash = false): Promise<ElfCandidate> {
	const result: ElfCandidate = { program, valid: false, evidence: 'ELF-header-and-program-headers' };
	try {
		signal.throwIfAborted();
		await validateWorkspaceSource(program, [workspace]);
		const real = await fs.realpath(program);
		const file = await fs.open(real, 'r');
		try {
			const before = await file.stat();
			result.size = before.size;
			result.modifiedAt = before.mtime.toISOString();
			if (!before.isFile() || before.size < 64 || before.size > preparationLimits.elfBytes) {
				throw new Error('ELF must be a regular file between 64 bytes and 128 MiB.');
			}
			const header = Buffer.alloc(64);
			if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length ||
				!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
				header[4] !== 1 || ![1, 2].includes(header[5]) || header[6] !== 1) {
				throw new Error('Expected a complete ELF32 header with a valid byte order and version.');
			}
			const view = new DataView(header.buffer, header.byteOffset, header.length);
			const little = header[5] === 1;
			const u16 = (offset: number) => view.getUint16(offset, little);
			const u32 = (offset: number) => view.getUint32(offset, little);
			result.machine = u16(18);
			result.byteOrder = little ? 'little-endian' : 'big-endian';
			if (result.machine !== 44 || u16(16) !== 2 || u32(20) !== 1 || u16(40) !== 52) {
				throw new Error('Expected an executable TriCore ELF (EM_TRICORE=44, ET_EXEC=2); PPU/CDSP/SCR or relocatable objects are not selected.');
			}
			result.entry = `0x${u32(24).toString(16)}`;
			const start = u32(28), stride = u16(42), count = u16(44), end = start + stride * count;
			if (start < 52 || stride < 32 || count < 1 || count > 4096 || end > before.size ||
				end > preparationLimits.programHeaderBytes) { throw new Error('Invalid or oversized ELF program header table (maximum 1 MiB prefix).'); }
			const prefix = Buffer.alloc(Math.max(64, end));
			if ((await file.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) { throw new Error('ELF program headers were truncated.'); }
			if (!elfLoadRanges(prefix, 1).length) { throw new Error('ELF has no executable load segment.'); }
			const segments = new DataView(prefix.buffer, prefix.byteOffset, prefix.length);
			for (let index = 0; index < count; index++) {
				const offset = start + index * stride;
				if (segments.getUint32(offset, little) !== 1) { continue; }
				const fileOffset = segments.getUint32(offset + 4, little), fileSize = segments.getUint32(offset + 16, little);
				const memorySize = segments.getUint32(offset + 20, little);
				if (fileSize > memorySize || fileOffset + fileSize > before.size ||
					segments.getUint32(offset + 8, little) + memorySize > 0x100000000) {
					throw new Error('ELF load segment exceeds the file or 32-bit address range.');
				}
			}
			if (hash) {
				const digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
				for (let offset = 0; offset < before.size;) {
					signal.throwIfAborted();
					const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
					if (!bytesRead) { throw new Error('ELF changed while computing its SHA-256.'); }
					digest.update(chunk.subarray(0, bytesRead));
					offset += bytesRead;
				}
				result.sha256 = digest.digest('hex');
			}
			const after = await file.stat();
			if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
				real !== await fs.realpath(program)) { throw new Error('ELF changed during preparation.'); }
			result.valid = true;
		} finally { await file.close(); }
	} catch (error) {
		signal.throwIfAborted();
		result.unavailable = message(error);
		result.failureKind = error instanceof Error && 'code' in error ? 'unavailable' : 'invalid-elf';
	}
	signal.throwIfAborted();
	return result;
}

async function scanElfs(workspace: string, signal: AbortSignal, onProgress: (scan: Scan, currentPath: string) => void): Promise<Scan> {
	const scan: Scan = { complete: false, entriesVisited: 0, symbolicLinksSkipped: 0,
		excludedDirectories: [...excludedDirectories], issues: [], candidates: [] };
	const queue = [{ directory: workspace, depth: 0 }];
	onProgress(scan, workspace);
	const realWorkspace = await fs.realpath(workspace);
	for (let index = 0; index < queue.length; index++) {
		signal.throwIfAborted();
		const { directory, depth } = queue[index];
		onProgress(scan, directory);
		try {
			const relative = path.relative(realWorkspace, await fs.realpath(directory));
			if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
				(directory !== workspace && (await fs.lstat(directory)).isSymbolicLink())) {
				throw new Error('Directory became a link or resolves outside the workspace; discovery is incomplete.');
			}
			const entries = await fs.opendir(directory);
			for await (const entry of entries) {
				signal.throwIfAborted();
				if (scan.entriesVisited === preparationLimits.entries) {
					scan.complete = false;
					scan.issues.push({ code: 'SCAN_LIMIT', message: 'Reached 10000 directory entries. Supply an explicit program path.' });
					return scan;
				}
				scan.entriesVisited++;
				const filename = path.join(directory, entry.name);
				if (entry.isSymbolicLink()) { scan.symbolicLinksSkipped++; continue; }
				if (entry.isDirectory() && !excludedDirectories.includes(entry.name.toLowerCase())) {
					if (depth === preparationLimits.depth) {
						scan.complete = false;
						scan.issues.push({ code: 'SCAN_DEPTH', message: 'Reached directory depth 16. Supply an explicit program path.', path: filename });
						return scan;
					}
					queue.push({ directory: filename, depth: depth + 1 });
				} else if (entry.isFile() && /\.elf$/i.test(entry.name)) {
					if (scan.candidates.length === preparationLimits.elfCandidates) {
						scan.complete = false;
						scan.issues.push({ code: 'ELF_LIMIT', message: 'More than 64 ELF candidates. Supply an explicit program path.' });
						return scan;
					}
					onProgress(scan, filename);
					const candidate = await inspectElf(filename, workspace, signal);
					scan.candidates.push(candidate);
					if (candidate.failureKind === 'unavailable') {
						scan.complete = false;
						scan.issues.push({ code: 'ELF_UNAVAILABLE', message: candidate.unavailable ?? 'ELF could not be validated.', path: filename });
					}
				}
			}
		} catch (error) {
			signal.throwIfAborted();
			scan.complete = false;
			scan.issues.push({ code: 'SCAN_ERROR', message: message(error), path: directory });
			return scan;
		}
	}
	scan.candidates.sort((a, b) => a.program.localeCompare(b.program));
	scan.complete = scan.issues.length === 0;
	return scan;
}

export async function prepareDebugLaunch(raw: DebugPrepareOptions, environment: PreparationEnvironment,
	signal: AbortSignal): Promise<DebugPreparation> {
	const options = prepareOptionsSchema.parse(raw);
	signal.throwIfAborted();
	const workspaceFolders = [...environment.workspaceFolders];
	const report: DebugPreparation = {
		status: 'needs-input', workspaceFolders,
		core: { index: options.core ?? 0, selection: options.core === undefined ? 'default-cpu0' : 'explicit', hardwareVerified: false },
		elf: { complete: false, entriesVisited: 0, symbolicLinksSkipped: 0, excludedDirectories: [], issues: [], candidates: [] },
		devices: [], deviceEvidence: 'not-queried', issues: [],
	};
	const started = performance.now();
	let stageStarted = started;
	const progress: PreparationProgress = { stage: 'workspace', elapsedMs: 0, stageElapsedMs: 0, completedStages: [],
		partial: { workspaceFolders, core: report.core, elf: report.elf, devices: report.devices,
			deviceEvidence: report.deviceEvidence, issues: report.issues } };
	const publish = (stage: PreparationStage, currentPath?: string) => {
		const now = performance.now();
		if (stage !== progress.stage) {
			progress.completedStages.push({ stage: progress.stage, elapsedMs: Math.round(now - stageStarted) });
			progress.stage = stage;
			stageStarted = now;
		}
		progress.currentPath = currentPath;
		progress.elapsedMs = Math.round(now - started);
		progress.stageElapsedMs = Math.round(now - stageStarted);
		Object.assign(progress.partial, { workspaceFolder: report.workspaceFolder, elf: report.elf, devices: report.devices,
			deviceEvidence: report.deviceEvidence, selectedDevice: report.selectedDevice, svd: report.svd });
		environment.onProgress?.(progress);
	};
	publish('workspace');
	const workspace = options.workspaceFolder ?? (workspaceFolders.length === 1 ? workspaceFolders[0] : undefined);
	if (!workspace) {
		report.issues.push({ code: 'WORKSPACE_REQUIRED', message: 'Select one open local workspaceFolder; none was selected automatically.' });
		publish('complete');
		return report;
	}
	if (!path.isAbsolute(workspace) || !workspaceFolders.some(root => path.relative(root, workspace) === '')) {
		throw new DebugMcpError('INVALID_WORKSPACE', 'workspaceFolder must be the absolute path of an open local workspace folder.');
	}
	report.workspaceFolder = workspace;
	if (options.program) {
		publish('elf-validation', options.program);
		report.elf.candidates.push(await inspectElf(options.program, workspace, signal));
		report.elf.complete = true;
	} else {
		publish('elf-scan', workspace);
		report.elf = await scanElfs(workspace, signal, (scan, filename) => { report.elf = scan; publish('elf-scan', filename); });
	}
	report.issues.push(...report.elf.issues);
	const valid = report.elf.candidates.filter(candidate => candidate.valid);
	let selected = report.elf.complete && valid.length === 1 ? valid[0] : undefined;
	if (!selected) {
		report.issues.push({ code: 'PROGRAM_REQUIRED', message: 'Select an explicit valid TriCore ELF; no unique candidate in a complete search was established.' });
	}
	signal.throwIfAborted();
	publish('device-enumeration', path.join(environment.extensionPath, 'bin', 'lsmcdd.exe'));
	try {
		report.devices = await (environment.listDevices ?? (inner => listDasDevices(environment.extensionPath, inner)))(signal);
		report.deviceEvidence = 'lsmcdd';
	} catch (error) {
		signal.throwIfAborted();
		throw new DebugMcpError('DEVICE_DISCOVERY_FAILED', message(error));
	}
	signal.throwIfAborted();
	const matching = options.targetDevice ? report.devices.filter(device => device.name === options.targetDevice) : report.devices;
	if (matching.length !== 1) {
		report.issues.push({ code: 'TARGET_REQUIRED', message: 'Select the exact DAS device name. No unique detected device matches; numeric IDs and board/family aliases are not accepted.' });
	} else {
		report.selectedDevice = matching[0];
		publish('svd-matching');
		const svd = await getAutomaticSvd(environment.extensionPath, matching[0].name);
		signal.throwIfAborted();
		if (!svd) {
			report.issues.push({ code: 'SVD_REQUIRED', message: 'No unique bundled SVD matches this DAS model. Configure the SVD through the existing Debugger UI.' });
		} else {
			progress.partial.svdPath = svd;
			publish('svd-read', svd);
			try {
				const catalog = await validateSvdInWorker(svd, signal, stage => publish(stage, svd));
				signal.throwIfAborted();
				const families = svdDeviceFamilies(matching[0].name);
				if (families.size !== 1 || !families.has(`${catalog.device.slice(0, 4)}X`)) { throw new Error('SVD contents do not match the detected device family.'); }
				report.svd = { path: svd, device: catalog.device, registerCount: catalog.registerCount,
					evidence: 'device-family-map-and-SVD', contentValidated: true };
			} catch (error) {
				signal.throwIfAborted();
				report.issues.push({ code: 'SVD_INVALID', message: message(error), path: svd });
			}
		}
	}
	signal.throwIfAborted();
	if (selected) {
		publish('elf-hash', selected.program);
		const fresh = await inspectElf(selected.program, workspace, signal, true);
		if (!fresh.valid || fresh.size !== selected.size || fresh.modifiedAt !== selected.modifiedAt) {
			const unavailable = fresh.unavailable ?? 'ELF changed after discovery.';
			report.issues.push({ code: 'ELF_CHANGED', message: unavailable, path: selected.program });
			Object.assign(selected, fresh, { valid: false, failureKind: 'unavailable', unavailable });
			delete selected.sha256;
			selected = undefined;
		} else {
			Object.assign(selected, fresh);
			report.selectedProgram = selected.program;
		}
	}
	if (selected && report.selectedDevice && report.svd && report.issues.length === 0) {
		const launch = launchOptionsSchema.safeParse({ workspaceFolder: workspace, program: selected.program,
			targetDevice: report.selectedDevice.name, core: report.core.index });
		if (launch.success) {
			report.launchArguments = launch.data;
			report.status = 'prepared';
		} else {
			report.issues.push({ code: 'INVALID_LAUNCH_SELECTORS', message: `Selected values are not accepted by debug_start: ${launch.error.message}` });
		}
	}
	publish('complete');
	return report;
}
