import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export type DasDevice = { id: string; name: string; family: string };
export type DeviceEnumeration = (executable: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;

function csvFields(line: string): string[] {
	const fields: string[] = [];
	let value = '', quoted = false, closed = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') { value += '"'; i++; }
			else if (quoted) { quoted = false; closed = true; }
			else {
				if (closed || value.trim()) { throw new Error('Unexpected quote in lsmcdd CSV field.'); }
				quoted = true;
			}
		} else if (ch === ',' && !quoted) { fields.push(value.trim()); value = ''; closed = false; }
		else {
			if (closed && ch.trim()) { throw new Error('Unexpected text after a quoted lsmcdd CSV field.'); }
			value += ch;
		}
	}
	if (quoted) { throw new Error('Unterminated quoted field in lsmcdd output.'); }
	fields.push(value.trim());
	return fields;
}

export function parseDasDevices(output: string): DasDevice[] {
	if (Buffer.byteLength(output) > 5 * 1024 * 1024) { throw new Error('lsmcdd output exceeds 5 MiB.'); }
	const devices: DasDevice[] = [];
	const ids = new Set<string>();
	for (const line of output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
		const fields = csvFields(line);
		const [id, name] = fields;
		if (/^id$/i.test(id) && /^name$/i.test(name)) { continue; }
		if (!/^\d{1,16}$/.test(id ?? '') || !name || name.length > 256 || /[\x00-\x1f]/.test(name) ||
			(fields[3]?.length ?? 0) > 256 || /[\x00-\x1f]/.test(fields[3] ?? '') || ids.has(id)) {
			throw new Error('Invalid or duplicate device record in lsmcdd output; a partial device list will not be used.');
		}
		devices.push({ id, name, family: fields[3] ?? '' });
		ids.add(id);
		if (devices.length > 64) { throw new Error('lsmcdd returned more than 64 devices.'); }
	}
	return devices;
}

const executeEnumeration: DeviceEnumeration = (executable, signal) => new Promise((resolve, reject) => {
	execFile(executable, [], {
		cwd: path.dirname(executable), windowsHide: true, timeout: 10000, maxBuffer: 5 * 1024 * 1024, signal,
	}, (error, stdout, stderr) => {
		if (error) {
			reject(new Error(`lsmcdd device enumeration failed: ${error.message}. ${stderr.slice(0, 512)}`));
			return;
		}
		resolve({ stdout, stderr });
	});
});

export async function listDasDevices(extensionPath: string, signal?: AbortSignal,
	execute: DeviceEnumeration = executeEnumeration): Promise<DasDevice[]> {
	signal?.throwIfAborted();
	const executable = path.join(extensionPath, 'bin', 'lsmcdd.exe');
	if (!(await fs.stat(executable)).isFile()) { throw new Error(`lsmcdd.exe is not a regular file: ${executable}`); }
	signal?.throwIfAborted();
	const { stdout, stderr } = await execute(executable, signal);
	signal?.throwIfAborted();
	if (stdout.trim() && stderr.trim()) { throw new Error(`lsmcdd reported a diagnostic; device discovery is not confirmed: ${stderr.slice(0, 512)}`); }
	return parseDasDevices(stdout.trim() ? stdout : stderr);
}
