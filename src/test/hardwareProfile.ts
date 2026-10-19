import * as fs from 'fs';
import * as path from 'path';

export interface SourcePoint {
	source: string;
	line: number;
	function: string;
}

export interface StepFixture {
	from: SourcePoint;
	to: SourcePoint;
}

export interface HardwareProfile {
	program: string;
	workspace: string;
	targetDevice: string;
	agentPath: string;
	svdFile?: string;
	autoStartAgent: boolean;
	host: string;
	port: number;
	core: number;
	threadPatterns: string[];
	entry: SourcePoint;
	coreEntry?: SourcePoint;
	beforeEntry: SourcePoint;
	loopBreakpoint: SourcePoint;
	coreBreakpoints?: SourcePoint[];
	startupBreakpoint?: { core: number; point: SourcePoint };
	steps: Record<'stepIn' | 'next' | 'stepOut', StepFixture>;
	timeoutMs: number;
	launchTimeoutMs: number;
	fixtureVersion: string;
	compilerVersion: string;
	agentVersion: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (value.trim().startsWith('REPLACE_WITH_')) {
		throw new Error(`${label} still contains an example placeholder`);
	}
	return value.trim();
}

export function positiveInteger(value: unknown, label: string, maximum = 10000): number {
	const number = typeof value === 'string' && value.trim() ? Number(value) : value;
	if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
		throw new Error(`${label} must be an integer between 1 and ${maximum}`);
	}
	return number;
}

export function parseHardwareProfile(value: unknown, baseDirectory: string): HardwareProfile {
	const data = object(value, 'Hardware profile');
	const resolvePath = (value: unknown, label: string) => path.resolve(baseDirectory, text(value, label));
	const point = (value: unknown, label: string): SourcePoint => {
		const data = object(value, label);
		return {
			source: resolvePath(data.source, `${label}.source`),
			line: positiveInteger(data.line, `${label}.line`, 1000000),
			function: text(data.function, `${label}.function`)
		};
	};
	if (!Array.isArray(data.threadPatterns) || data.threadPatterns.length === 0) {
		throw new Error('threadPatterns must describe every expected core');
	}
	const threadPatterns = data.threadPatterns.map((value, index) => {
		const pattern = text(value, `threadPatterns[${index}]`);
		new RegExp(pattern, 'i');
		return pattern;
	});
	const coreIndex = (value: unknown, label: string): number => {
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= threadPatterns.length) {
			throw new Error(`${label} must index threadPatterns`);
		}
		return value;
	};
	const core = coreIndex(data.core, 'core');
	if (data.autoStartAgent !== undefined && typeof data.autoStartAgent !== 'boolean') {
		throw new Error('autoStartAgent must be a boolean');
	}
	const steps = object(data.steps, 'steps');
	const step = (name: string): StepFixture => {
		const fixture = object(steps[name], `steps.${name}`);
		return { from: point(fixture.from, `steps.${name}.from`), to: point(fixture.to, `steps.${name}.to`) };
	};
	let coreBreakpoints: SourcePoint[] | undefined;
	if (data.coreBreakpoints !== undefined) {
		if (!Array.isArray(data.coreBreakpoints) || data.coreBreakpoints.length !== threadPatterns.length) {
			throw new Error('coreBreakpoints must contain one source point per thread pattern');
		}
		coreBreakpoints = data.coreBreakpoints.map((value, index) => point(value, `coreBreakpoints[${index}]`));
	}
	const startup = data.startupBreakpoint === undefined ? undefined : object(data.startupBreakpoint, 'startupBreakpoint');
	return {
		program: resolvePath(data.program, 'program'),
		workspace: resolvePath(data.workspace, 'workspace'),
		targetDevice: text(data.targetDevice, 'targetDevice'),
		agentPath: resolvePath(data.agentPath, 'agentPath'),
		svdFile: data.autoStartAgent === false && data.svdFile === undefined
			? undefined : resolvePath(data.svdFile, 'svdFile'),
		autoStartAgent: data.autoStartAgent !== false,
		host: data.host === undefined ? '127.0.0.1' : text(data.host, 'host'),
		port: positiveInteger(data.port ?? 1534, 'port', 65535),
		core,
		threadPatterns,
		entry: point(data.entry, 'entry'),
		coreEntry: data.coreEntry === undefined ? undefined : point(data.coreEntry, 'coreEntry'),
		beforeEntry: point(data.beforeEntry, 'beforeEntry'),
		loopBreakpoint: point(data.loopBreakpoint, 'loopBreakpoint'),
		coreBreakpoints,
		startupBreakpoint: startup ? {
			core: coreIndex(startup.core, 'startupBreakpoint.core'),
			point: point(startup.point, 'startupBreakpoint.point')
		} : undefined,
		steps: { stepIn: step('stepIn'), next: step('next'), stepOut: step('stepOut') },
		timeoutMs: positiveInteger(data.timeoutMs ?? 20000, 'timeoutMs', 300000),
		launchTimeoutMs: positiveInteger(data.launchTimeoutMs ?? 90000, 'launchTimeoutMs', 600000),
		fixtureVersion: text(data.fixtureVersion, 'fixtureVersion'),
		compilerVersion: text(data.compilerVersion, 'compilerVersion'),
		agentVersion: text(data.agentVersion, 'agentVersion')
	};
}

export function loadHardwareProfile(environment: NodeJS.ProcessEnv = process.env): HardwareProfile | undefined {
	if (environment.AURIX_TEST_HARDWARE !== '1') {
		return undefined;
	}
	const file = text(environment.AURIX_TEST_PROFILE, 'AURIX_TEST_PROFILE');
	const profile = parseHardwareProfile(JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(path.resolve(file)));
	const sources = [profile.entry, profile.beforeEntry, profile.loopBreakpoint,
		...(profile.coreEntry ? [profile.coreEntry] : []),
		...(profile.startupBreakpoint ? [profile.startupBreakpoint.point] : []),
		...(profile.coreBreakpoints ?? []),
		...Object.values(profile.steps).flatMap(step => [step.from, step.to])];
	for (const source of sources) {
		const lines = fs.readFileSync(source.source, 'utf8').split(/\r?\n/);
		if (source.line > lines.length || !lines[source.line - 1].trim()) {
			throw new Error(`Missing source code at ${source.source}:${source.line}`);
		}
	}
	if (!fs.statSync(profile.workspace).isDirectory()) {
		throw new Error('workspace must be a directory');
	}
	if (profile.autoStartAgent && !fs.statSync(profile.agentPath).isFile()) {
		throw new Error('agentPath must be a file');
	}
	if (profile.svdFile && !fs.statSync(profile.svdFile).isFile()) {
		throw new Error('svdFile must be a file');
	}
	const descriptor = fs.openSync(profile.program, 'r');
	try {
		const magic = Buffer.alloc(4);
		if (fs.readSync(descriptor, magic, 0, 4, 0) !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
			throw new Error('program must be an ELF file, not a project directory or HEX file');
		}
	} finally {
		fs.closeSync(descriptor);
	}
	return profile;
}