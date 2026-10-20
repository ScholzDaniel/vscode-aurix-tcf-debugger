import * as fs from 'fs';

type ResolvePath = (value: unknown) => string | undefined;

function configuredPath(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function collectFlashHexFiles(
	config: Readonly<Record<string, unknown>>,
	resolvePath: ResolvePath = configuredPath,
): string[] {
	const files: string[] = [];
	const errors: string[] = [];
	const addHex = (label: string, elf: string): void => {
		if (!/\.elf$/i.test(elf)) {
			errors.push(`${label}: Flash Hex requires an ELF path ending in .elf: ${elf}`);
			return;
		}
		const hex = elf.replace(/\.elf$/i, '.hex');
		if (!fs.existsSync(hex) || !fs.statSync(hex).isFile()) {
			errors.push(`${label}: HEX file not found: ${hex}`);
		} else {
			files.push(hex);
		}
	};
	if (config.ppuFlashHex === true) {
		const elf = resolvePath(config.ppuElfPath);
		if (!elf) {
			errors.push('PPU: Flash Hex is enabled but no ELF file is specified.');
		} else {
			addHex('PPU', elf);
		}
	}
	if (config.cdspFlashHex === true) {
		const paths: unknown[] = Array.isArray(config.cdspElfPaths) ? config.cdspElfPaths : [];
		let anyCdsp = false;
		paths.forEach((value, index) => {
			const elf = resolvePath(value);
			if (elf) {
				anyCdsp = true;
				addHex(`CDSP${index}`, elf);
			}
		});
		if (!anyCdsp) {
			errors.push('CDSP: Flash Hex is enabled but no ELF files are specified.');
		}
	}
	if (errors.length > 0) {
		throw new Error(errors.join('\n'));
	}
	return files;
}

export function createFlashingPlan(
	config: Readonly<Record<string, unknown>>,
	resolvePath: ResolvePath = configuredPath,
): { elfPath: string; hexFiles: string[] } | undefined {
	const hexFiles = collectFlashHexFiles(config, resolvePath);
	if (config.enableFlashing !== true) {
		return undefined;
	}
	const elfPath = resolvePath(config.program);
	if (!elfPath) {
		throw new Error('Enable flashing is set but no program/ELF path is configured.');
	}
	if (!fs.existsSync(elfPath) || !fs.statSync(elfPath).isFile()) {
		throw new Error(`ELF file not found: ${elfPath}`);
	}
	return { elfPath, hexFiles };
}

export function buildFlasherArgs(elfPath: string, hexFiles: readonly string[], deviceId: string): string[] {
	const args = ['-gui', 'off', '-elf', elfPath];
	for (const hex of hexFiles) {
		args.push('-hex', hex);
	}
	return [...args, '-start', 'off', '-ver', 'on', '-id', deviceId];
}

export function selectFlasherDeviceId(
	devices: readonly { id: string; name: string; family: string }[],
	device: string | undefined,
): string {
	const raw = (device ?? '').trim();
	if (/^\d+$/.test(raw)) {
		throw new Error('targetDevice must be a device name (not a numeric id).');
	}
	if (devices.length === 0) {
		throw new Error('No devices detected by lsmcdd.exe');
	}
	if (raw === '' && devices.length === 1) {
		return devices[0].id;
	}
	const names = devices.map(d => d.name).join('; ');
	if (raw === '') {
		throw new Error(`Multiple devices detected; please set targetDevice. Available: ${names}`);
	}
	const lower = raw.toLowerCase();
	const exact = devices.find(d => d.name === raw) ?? devices.find(d => d.name.toLowerCase() === lower);
	if (exact) {
		return exact.id;
	}
	const families = devices.filter(d => d.family.toLowerCase() === lower);
	if (families.length === 1) {
		return families[0].id;
	}
	if (families.length > 1) {
		throw new Error(`Device '${raw}' matches multiple devices (by family). Matches: ${families.map(d => d.name).join('; ')}`);
	}
	throw new Error(`Device '${raw}' not found. Available: ${names}`);
}
