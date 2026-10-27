import { promises as fs } from 'fs';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { parser as saxParser } from 'sax';

export type SvdRegister = {
	name: string; path: string[]; address: number; size: number;
	readable: boolean; writable: boolean; readAction: boolean;
};
export type SvdRegisterCatalog = { device: string; registers: SvdRegister[] };
type Node = { tag: string; props: Record<string, string>; children: Node[]; derived?: string; readAction: boolean };
const containers = new Set(['device', 'peripheral', 'cluster', 'register']);
// Bundled TC4DXA expands to 146.91 MiB; bound both the file and decoded XML with headroom.
export const maximumSvdBytes = 256 * 1024 * 1024;
export const svdSizeLimitMessage = 'SVD exceeds the 256 MiB file or decoded XML limit.';
const maximumDimension = 4096;

export function svdInteger(text: string | undefined): number {
	if (!text || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) { throw new Error('Missing or invalid SVD integer.'); }
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) { throw new Error('SVD integer exceeds uint32.'); }
	return value;
}

export function svdDimensions(props: Record<string, string>): { name: string; offset: number }[] {
	const name = props.name;
	if (!name || !/^[A-Za-z0-9_[\]%]+$/.test(name)) { throw new Error('Unsupported SVD name.'); }
	if (props.dim === undefined) { return [{ name, offset: 0 }]; }
	const count = svdInteger(props.dim), increment = svdInteger(props.dimIncrement);
	if (count < 1 || count > maximumDimension || !name.includes('%s')) { throw new Error(`Unsupported SVD dimension for ${name} (1..${maximumDimension} elements).`); }
	const range = props.dimIndex?.match(/^(\d+)-(\d+)$/);
	const indices = props.dimIndex === undefined ? Array.from({ length: count }, (_, index) => String(index)) :
		range ? Array.from({ length: Math.min(maximumDimension + 1, Number(range[2]) - Number(range[1]) + 1) }, (_, index) => String(Number(range[1]) + index)) :
			props.dimIndex.split(',').map(index => index.trim());
	if (indices.length !== count || new Set(indices).size !== count || indices.some(index => !/^[A-Za-z0-9]+$/.test(index))) {
		throw new Error('Invalid SVD dimension indices.');
	}
	return indices.map((index, ordinal) => ({ name: name.replace('%s', index), offset: ordinal * increment }));
}

export async function readSvdFile(filename: string): Promise<string> {
	const stat = await fs.stat(filename);
	if (!stat.isFile()) { throw new Error('SVD must be a regular file.'); }
	if (stat.size > maximumSvdBytes) { throw new Error(svdSizeLimitMessage); }
	const bytes = await fs.readFile(filename);
	let decoded: Buffer;
	try {
		decoded = filename.toLowerCase().endsWith('.gz') ?
			await promisify(gunzip)(bytes, { maxOutputLength: maximumSvdBytes }) : bytes;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
			throw new Error(svdSizeLimitMessage);
		}
		throw error;
	}
	if (decoded.length > maximumSvdBytes) { throw new Error(svdSizeLimitMessage); }
	return decoded.toString('utf8');
}

export function extractSvdRegisterCatalog(xml: string): SvdRegisterCatalog {
	if (Buffer.byteLength(xml) > maximumSvdBytes) { throw new Error(svdSizeLimitMessage); }
	const frames: { tag: string; text: string; node?: Node }[] = [];
	const nodes: Node[] = [];
	let root: Node | undefined;
	const parser = saxParser(true);
	parser.onerror = error => { throw error; };
	parser.ondoctype = () => { throw new Error('SVD DTDs are not supported.'); };
	parser.onopentag = element => {
		if (frames.length >= 32) { throw new Error('SVD nesting limit exceeded.'); }
		let node: Node | undefined;
		if (containers.has(element.name)) {
			if (nodes.length >= 65536) { throw new Error('SVD definition limit exceeded.'); }
			const derived = element.attributes.derivedFrom;
			if (derived !== undefined && typeof derived !== 'string') { throw new Error('Invalid SVD inheritance.'); }
			node = { tag: element.name, props: {}, children: [], derived, readAction: false };
			const parent = frames.map(frame => frame.node).filter(value => value !== undefined).pop();
			if (parent) { parent.children.push(node); } else { root = node; }
			nodes.push(node);
		}
		frames.push({ tag: element.name, text: '', node });
	};
	parser.ontext = parser.oncdata = text => {
		const frame = frames[frames.length - 1];
		if (frame) {
			if (frame.text.length + text.length > 65536) { throw new Error('Oversized SVD text element.'); }
			frame.text += text;
		}
	};
	parser.onclosetag = () => {
		const frame = frames.pop()!;
		const parent = frames[frames.length - 1];
		if (parent?.node && !frame.node) { parent.node.props[frame.tag] = frame.text.trim(); }
		if (frame.tag === 'readAction') {
			const register = frames.find(ancestor => ancestor.node?.tag === 'register')?.node;
			if (register) { register.readAction = true; }
		}
	};
	parser.write(xml).close();
	if (!root || root.tag !== 'device' || !root.props.name) { throw new Error('Missing SVD device.'); }
	const definitions = new Map<string, Node[]>();
	const paths = new Map<Node, string[]>();
	const index = (node: Node, parent: string[]) => {
		const names = node.tag === 'device' ? [] : [...parent, node.props.name];
		if (node.tag !== 'device') {
			const key = names.join('.');
			const aliases = definitions.get(key) ?? [];
			aliases.push(node);
			definitions.set(key, aliases);
			paths.set(node, names);
		}
		node.children.forEach(child => index(child, names));
	};
	index(root, []);
	const resolved = new Map<Node, Node>();
	const resolving = new Set<Node>();
	const resolve = (node: Node): Node => {
		const existing = resolved.get(node);
		if (existing) { return existing; }
		if (resolving.has(node)) { throw new Error('Cyclic SVD inheritance.'); }
		resolving.add(node);
		let value = node;
		if (node.derived) {
			const names = paths.get(node)!;
			const candidates = definitions.get(node.derived) ?? definitions.get([...names.slice(0, -1), node.derived].join('.'));
			if (candidates?.length !== 1 || candidates[0].tag !== node.tag) { throw new Error(`Unresolved or ambiguous SVD inheritance: ${node.derived}.`); }
			const base = candidates[0];
			const inherited = resolve(base);
			const overridden = new Set(node.children.map(child => child.props.name));
			value = { ...node, props: { ...inherited.props, ...node.props },
				children: [...inherited.children.filter(child => !overridden.has(child.props.name)), ...node.children],
				readAction: node.readAction || inherited.readAction };
		}
		resolving.delete(node);
		resolved.set(node, value);
		return value;
	};
	const registers: SvdRegister[] = [];
	let expandedNodes = 0;
	const expand = (raw: Node, parentPath: string[], address: number, inherited: Record<string, string>, depth: number) => {
		if (depth > 32) { throw new Error('Expanded SVD nesting limit exceeded.'); }
		const node = resolve(raw);
		const props = { ...inherited };
		for (const property of ['size', 'access', 'readAction']) {
			if (node.props[property] !== undefined) { props[property] = node.props[property]; }
		}
		for (const variant of svdDimensions(node.props)) {
			if (++expandedNodes > 262144) { throw new Error('Expanded SVD node limit exceeded.'); }
			const fullPath = [...parentPath, variant.name];
			const base = address + svdInteger(node.props[node.tag === 'peripheral' ? 'baseAddress' : 'addressOffset']) + variant.offset;
			if (node.tag !== 'register') {
				for (const child of node.children) { expand(child, fullPath, base, props, depth + 1); }
				continue;
			}
			const size = svdInteger(props.size) / 8, name = fullPath.join('_').replace(/[[\]]/g, '');
			if (!Number.isSafeInteger(base) || base < 0 || base > 0xffffffff || size < 1 || !Number.isInteger(size) || base + size > 0x100000000) {
				throw new Error(`Invalid SVD register address or size: ${name}.`);
			}
			registers.push({ name, path: fullPath, address: base, size,
				readable: ['read-only', 'read-write', 'read-writeOnce'].includes(props.access),
				writable: ['write-only', 'read-write', 'writeOnce', 'read-writeOnce'].includes(props.access),
				readAction: node.readAction || props.readAction !== undefined });
			if (registers.length > 131072) { throw new Error('Expanded SVD register limit exceeded.'); }
		}
	};
	for (const peripheral of root.children) { expand(peripheral, [], 0, { size: root.props.width ?? '32', access: 'read-write', ...root.props }, 0); }
	return { device: root.props.name, registers };
}
