import * as path from 'path';
import { promises as fs, createReadStream } from 'fs';
import { gunzipSync, createGunzip } from 'zlib';
import { createHash } from 'crypto';
import { parser as saxParser } from 'sax';
import { pipeline } from 'stream/promises';
import { StringDecoder } from 'string_decoder';
import { getAutomaticSvd, svdDeviceFamilies } from './svdCatalog';
import { svdInteger as integer, svdDimensions as dimensions, readSvdFile, extractSvdRegisterCatalog, SvdRegisterCatalog,
	maximumSvdBytes, svdSizeLimitMessage } from './svdRegisterCatalog';

export const peripheralProfileName = 'tc375-gtm-atom0-ch4' as const;
export const automaticPeripheralProfileName = 'svd-safe-config-v1' as const;
class PeripheralPolicyUnavailable extends Error {}
export type PeripheralDefinition = { name: string; address: number; size: 4; group?: string; register?: string };
export type PeripheralProfile = {
	name: typeof peripheralProfileName | typeof automaticPeripheralProfileName;
	registers: PeripheralDefinition[];
	device?: string;
	excluded?: number;
};
const registerNames = ['SR0', 'SR1', 'CM0', 'CM1'];
type XmlFrame = { tag: string; text: string; props: Record<string, string>; readAction: boolean };
type SvdElement = { tag: string; text: string; attributes: Record<string, string>; children: SvdElement[] };
type PresentationRegister = { name: string; path: SvdElement[] };
const presentations = new WeakMap<PeripheralProfile, PresentationRegister[]>();
const structuralTags = new Set(['device', 'peripherals', 'peripheral', 'registers', 'cluster', 'register']);
const dimensionTags = new Set(['dim', 'dimIncrement', 'dimIndex', 'dimName', 'dimArrayIndex']);

function xmlEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlElement(tag: string, text = '', children: SvdElement[] = []): SvdElement {
	return { tag, text, children, attributes: {} };
}

function renderElement(node: SvdElement): string {
	const chunks: string[] = [];
	let bytes = 0;
	const append = (text: string) => {
		bytes += Buffer.byteLength(text);
		if (bytes > 16 * 1024 * 1024) { throw new Error('Viewer SVD exceeds the 16 MiB presentation limit.'); }
		chunks.push(text);
	};
	const visit = (element: SvdElement) => {
		const attributes = Object.entries(element.attributes).map(([key, value]) => ` ${key}="${xmlEscape(value)}"`).join('');
		append(`<${element.tag}${attributes}>${xmlEscape(element.text)}`);
		element.children.forEach(visit);
		append(`</${element.tag}>`);
	};
	visit(node);
	return chunks.join('');
}

function readOnlyElement(node: SvdElement): SvdElement {
	// Do not turn physically write-only fields into apparently readable fields.
	const text = node.tag === 'access' && ['read-write', 'read-writeOnce'].includes(node.text) ? 'read-only' : node.text;
	return { ...node, text, children: node.children.map(readOnlyElement) };
}

export function peripheralViewerSvd(profile: PeripheralProfile): string {
	const presentation = presentations.get(profile);
	if (!presentation) { throw new Error('Original SVD presentation metadata is unavailable.'); }
	const peripherals = xmlElement('peripherals');
	const containers = new Map<string, SvdElement>();
	const bufferSizes = new Map<string, SvdElement>();
	for (const register of presentation) {
		let parent = peripherals, key = '';
		for (const node of register.path) {
			key += `/${node.children.find(child => child.tag === 'name')!.text}`;
			if (node.tag === 'register') { parent.children.push(readOnlyElement(node)); continue; }
			let children = containers.get(key);
			if (!children) {
				const container = readOnlyElement(node);
				parent.children.push(container);
				children = container.tag === 'peripheral' ? xmlElement('registers') : container;
				if (container.tag === 'peripheral') {
					// Viewer 1.6.5 allocates its buffer only from addressBlock, not from register ranges.
					const size = xmlElement('size', '0');
					const block = xmlElement('addressBlock', '', [xmlElement('offset', '0'), size, xmlElement('usage', 'registers')]);
					const interrupt = container.children.findIndex(child => child.tag === 'interrupt');
					container.children.splice(interrupt < 0 ? container.children.length : interrupt, 0, block);
					container.children.push(children);
					bufferSizes.set(key, size);
				}
				containers.set(key, children);
			}
			parent = children;
		}
		const peripheralKey = `/${register.path[0].children.find(child => child.tag === 'name')!.text}`;
		const size = bufferSizes.get(peripheralKey)!;
		const end = register.path.slice(1).reduce((offset, node) =>
			offset + integer(node.children.find(child => child.tag === 'addressOffset')?.text), 4);
		size.text = String(Math.max(integer(size.text), end));
	}
	return '<?xml version="1.0" encoding="utf-8"?>\n<device schemaVersion="1.3">' +
		`<name>${xmlEscape(profile.device ?? 'TC37X')}</name><version>1</version>` +
		'<description>Read-only approved subset with original SVD hierarchy and fields; not a complete device SVD.</description>' +
		'<addressUnitBits>8</addressUnitBits><width>32</width><size>32</size><access>read-only</access>' +
		`${renderElement(peripherals)}</device>\n`;
}

export function extractPwmProfile(xml: string): PeripheralProfile {
	if (Buffer.byteLength(xml) > 64 * 1024 * 1024) { throw new Error('SVD exceeds 64 MiB.'); }
	const stack: XmlFrame[] = [];
	const registers: PeripheralDefinition[] = [];
	const parser = saxParser(true);
	parser.onerror = error => { throw error; };
	parser.ondoctype = () => { throw new Error('SVD DTDs are not supported.'); };
	parser.onopentag = node => {
		if (stack.length >= 32 || node.attributes.derivedFrom !== undefined) {
			throw new Error('This safety profile requires a bounded, fully expanded vendor SVD.');
		}
		stack.push({ tag: node.name, text: '', props: {}, readAction: false });
	};
	parser.ontext = text => {
		const current = stack[stack.length - 1];
		if (current) {
			if (current.text.length + text.length > 65536) { throw new Error('Oversized SVD text element.'); }
			current.text += text;
		}
	};
	parser.onclosetag = () => {
		const node = stack.pop()!;
		const parent = stack[stack.length - 1];
		if (parent) {
			parent.props[node.tag] = node.text.trim();
			parent.readAction ||= node.tag === 'readAction' || node.readAction;
		}
		if (node.tag !== 'register' || !registerNames.includes(node.props.name)) { return; }
		const peripheral = stack.find(frame => frame.tag === 'peripheral');
		const cluster = stack.find(frame => frame.tag === 'cluster');
		if (peripheral?.props.name !== 'GTM' || cluster?.props.name !== 'ATOM0_CH[%s]') { return; }
		const device = stack.find(frame => frame.tag === 'device');
		if (device?.props.name !== 'TC37X' || integer(cluster.props.dim) !== 8 ||
			(cluster.props.dimIndex !== undefined && cluster.props.dimIndex !== '0-7') ||
			integer(node.props.size) !== 32 || !['read-only', 'read-write'].includes(node.props.access) ||
			node.readAction) { throw new Error('GTM PWM SVD metadata does not match the reviewed TC37X profile.'); }
		const address = integer(peripheral.props.baseAddress) + integer(cluster.props.addressOffset) +
			4 * integer(cluster.props.dimIncrement) + integer(node.props.addressOffset);
		if (!Number.isSafeInteger(address) || address < 0xf0000000 || address + 4 > 0x100000000 || address % 4 !== 0) {
			throw new Error('Invalid PWM register address in SVD.');
		}
		registers.push({ name: `GTM_ATOM0_CH4_${node.props.name}`, address, size: 4 });
	};
	parser.write(xml).close();
	if (registers.length !== 4 || new Set(registers.map(register => register.name)).size !== 4 ||
		new Set(registers.map(register => register.address)).size !== 4) {
		throw new Error('The vendor SVD did not provide exactly four reviewed PWM registers.');
	}
	const profile: PeripheralProfile = { name: peripheralProfileName, registers: registers.sort((a, b) => a.address - b.address) };
	const automatic = extractAutomaticPeripheralProfile(xml);
	presentations.set(profile, presentations.get(automatic)!.filter(item => registers.some(register => register.name === item.name)));
	return profile;
}

let bundledProfile: Promise<PeripheralProfile> | undefined;
export function loadPeripheralProfile(): Promise<PeripheralProfile> {
	if (!bundledProfile) {
		bundledProfile = fs.readFile(path.resolve(__dirname, '..', 'bin', 'svd', 'TC37XPD.svd.gz'))
			.then(bytes => extractPwmProfile(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')));
	}
	return bundledProfile;
}

export function peripheralAgentSvd(profile: PeripheralProfile): string {
	if (profile.name === automaticPeripheralProfileName) {
		const groups = new Map<string, PeripheralDefinition[]>();
		for (const register of profile.registers) {
			const group = register.group!;
			groups.set(group, [...(groups.get(group) ?? []), register]);
		}
		const peripherals = Array.from(groups, ([name, registers]) => {
			const base = registers[0].address;
			return `<peripheral><name>${name}</name><description>Read-only approved configuration registers</description>` +
				`<baseAddress>0x${base.toString(16)}</baseAddress><registers>` +
				registers.map(register => `<register><name>${register.register}</name><description>${register.name}</description>` +
					`<addressOffset>${register.address - base}</addressOffset><size>32</size><access>read-only</access></register>`).join('') +
				'</registers></peripheral>';
		}).join('');
		return '<?xml version="1.0" encoding="utf-8"?>\n<device schemaVersion="1.3">' +
			`<name>${profile.device}</name><version>1</version><description>Read-only configuration subset, not a complete device SVD</description>` +
			'<addressUnitBits>8</addressUnitBits><width>32</width><size>32</size><access>read-only</access>' +
			`<peripherals>${peripherals}</peripherals></device>\n`;
	}
	const base = profile.registers[0].address;
	const registers = profile.registers.map(register => `<register><name>${register.name.slice('GTM_ATOM0_CH4_'.length)}</name>` +
		`<description>Read-only inspection profile; value obtained through TCF Registers, not Memory.get.</description>` +
		`<addressOffset>0x${(register.address - base).toString(16)}</addressOffset><size>32</size><access>read-only</access></register>`).join('');
	return '<?xml version="1.0" encoding="utf-8"?>\n' +
		'<device schemaVersion="1.3"><name>TC37X</name><version>1</version>' +
		'<description>TC375 GTM ATOM0 CH4 read-only inspection subset, not a complete device SVD.</description>' +
		'<addressUnitBits>8</addressUnitBits><width>32</width><size>32</size><access>read-only</access><peripherals>' +
		`<peripheral><name>GTM_ATOM0_CH4</name><description>Approved PWM configuration registers only</description>` +
		`<baseAddress>0x${base.toString(16)}</baseAddress><registers>${registers}</registers></peripheral></peripherals></device>\n`;
}

function reviewedRegister(name: string): boolean {
	return /^(?:GTM_(?:ATOM|TOM)\d+_CH\d+_(?:SR[01]|CM[01])|P\d{2}_(?:OUT|IN|ID|IOCR(?:0|4|8|12)|PDR[01]|PDISC)|ASCLIN\d+_(?:CLC|ID|BITCON|FRAMECON|DATCON|BRG)|QSPI\d+_(?:CLC|ID|PISEL|GLOBALCON1?|SSOC|ECON[0-7])|I2C\d+_(?:CLC|ID|RUNCTRL|FDIVCFG|ADDRCFG|TIMCFG))$/.test(name);
}

function automaticProfileParser() {
	const stack: (XmlFrame & SvdElement & { derived: boolean; capture: boolean })[] = [];
	const registers: PeripheralDefinition[] = [];
	const presentation: PresentationRegister[] = [];
	let device = '', total = 0;
	const parser = saxParser(true);
	parser.onerror = error => { throw error; };
	parser.ondoctype = () => { throw new Error('SVD DTDs are not supported.'); };
	parser.onopentag = node => {
		if (stack.length >= 32) { throw new Error('SVD nesting limit exceeded.'); }
		const capture = stack[stack.length - 1]?.capture ?? true;
		const attributes: Record<string, string> = {};
		for (const [key, value] of capture ? Object.entries(node.attributes) : []) {
			if (typeof value !== 'string') { throw new Error('Unsupported SVD attribute.'); }
			attributes[key] = value;
		}
		stack.push({ tag: node.name, text: '', props: {}, readAction: false, attributes, children: [],
			derived: node.attributes.derivedFrom !== undefined, capture });
	};
	parser.ontext = parser.oncdata = text => {
		const current = stack[stack.length - 1];
		if (current) {
			if (current.text.length + text.length > 65536) { throw new Error('Oversized SVD text element.'); }
			current.text += text;
		}
	};
	parser.onclosetag = () => {
		const node = stack.pop()!;
		const parent = stack[stack.length - 1];
		if (parent) {
			parent.props[node.tag] = node.text.trim();
			parent.readAction ||= node.tag === 'readAction' || node.readAction;
			if (node.tag === 'name' && parent.tag === 'register') {
				const template = stack.filter(frame => ['peripheral', 'cluster', 'register'].includes(frame.tag))
					.map(frame => frame.props.name?.replace('%s', '0').replace(/[[\]]/g, '')).join('_');
				parent.capture &&= reviewedRegister(template);
				if (!parent.capture) { parent.children = []; }
			}
			if (parent.capture && !structuralTags.has(node.tag) && stack.some(frame => frame.tag === 'peripheral')) {
				if (parent.children.length >= 4096) { throw new Error('SVD presentation child limit exceeded.'); }
				parent.children.push({ tag: node.tag, text: node.text.trim(), attributes: node.attributes, children: node.children });
			}
		}
		if (node.tag === 'name' && parent?.tag === 'device' &&
			!/^TC(?:22X|23X|26XB|27XD|29XB|33X(?:EXT)?|35X|36X|37X(?:EXT)?|38X|39XB)$/.test(node.text.trim())) {
			throw new PeripheralPolicyUnavailable('No reviewed peripheral policy for this SVD device family.');
		}
		if (node.tag === 'device') { device = node.props.name; }
		if (node.tag !== 'register') { return; }
		const ancestry = stack.filter(frame => ['peripheral', 'cluster'].includes(frame.tag));
		const propertyNodes = [...stack.filter(frame => ['device', 'peripheral', 'cluster'].includes(frame.tag)), node];
		const inherited = (property: string) => propertyNodes.map(frame => frame.props[property]).filter(value => value !== undefined).pop();
		if (node.derived || ancestry.some(frame => frame.derived)) { total++; return; }
		const levels = [...ancestry, node];
		const template = levels.map(frame => frame.props.name?.replace('%s', '0').replace(/[[\]]/g, '')).join('_');
		if (!reviewedRegister(template) || node.readAction || inherited('readAction') !== undefined ||
			inherited('size') !== '32' || !['read-only', 'read-write'].includes(inherited('access') ?? '')) { total++; return; }
		let expanded: { names: string[]; address: number; path: SvdElement[] }[] = [{ names: [], address: 0, path: [] }];
		for (const frame of levels) {
			const variants = dimensions(frame.props);
			if (expanded.length * variants.length > 8192) { throw new Error('SVD expansion limit exceeded.'); }
			const base = integer(frame.props[frame.tag === 'peripheral' ? 'baseAddress' : 'addressOffset']);
			expanded = expanded.flatMap(item => variants.map(variant => ({
				names: [...item.names, variant.name.replace(/[[\]]/g, '')],
				address: item.address + base + variant.offset,
				path: [...item.path, xmlElement(frame.tag, '', frame.children
					// A full-module addressBlock must not enlarge the filtered Viewer's backing buffer.
					.filter(child => !dimensionTags.has(child.tag) && child.tag !== 'addressBlock')
					.map(child => {
						const replacement = child.tag === 'name' ? variant.name :
							child.tag === (frame.tag === 'peripheral' ? 'baseAddress' : 'addressOffset') ? `0x${(base + variant.offset).toString(16)}` :
								child.tag === 'access' ? 'read-only' : child.tag === 'size' ? '32' : undefined;
						return replacement === undefined ? child : { ...child, text: replacement };
					}))],
			})));
		}
		for (const item of expanded) {
			total++;
			const name = item.names.join('_');
			if (!reviewedRegister(name)) { continue; }
			if (!Number.isSafeInteger(item.address) || item.address < 0xf0000000 ||
				item.address + 4 > 0x100000000 || item.address % 4 !== 0) { throw new Error(`Invalid SVD address for ${name}.`); }
			const peripheralBase = integer(item.path[0].children.find(child => child.tag === 'baseAddress')?.text);
			if (item.address + 4 - peripheralBase > 8 * 1024 * 1024) { throw new Error('Peripheral Viewer span exceeds 8 MiB.'); }
			registers.push({ name, address: item.address, size: 4,
				group: item.names.slice(0, -1).join('_'), register: item.names[item.names.length - 1] });
			presentation.push({ name, path: item.path });
			if (registers.length > 8192) { throw new Error('Approved SVD register limit exceeded.'); }
		}
	};
	const finish = (): PeripheralProfile => {
		parser.close();
		if (!device) { throw new Error('Missing SVD device name.'); }
		if (new Set(registers.map(register => register.name)).size !== registers.length ||
			new Set(registers.map(register => register.address)).size !== registers.length) {
			throw new Error('Ambiguous or overlapping approved SVD registers.');
		}
		registers.sort((a, b) => a.address - b.address);
		// Keep the proven native Agent identities private; the Viewer uses the original SVD hierarchy.
		let previous: PeripheralDefinition | undefined, logicalGroup = '', blockGroup = '', blockCount = 0;
		for (const register of registers) {
			if (!previous || register.group !== logicalGroup || previous.address + 4 !== register.address || blockCount === 32) {
				logicalGroup = register.group!;
				blockGroup = `${logicalGroup}_B${register.address.toString(16).toUpperCase()}`;
				blockCount = 0;
			}
			register.group = blockGroup;
			blockCount++;
			previous = register;
		}
		const profile: PeripheralProfile = { name: automaticPeripheralProfileName, device, registers, excluded: total - registers.length };
		presentations.set(profile, presentation);
		return profile;
	};
	return { parser, finish };
}

export function extractAutomaticPeripheralProfile(xml: string): PeripheralProfile {
	if (Buffer.byteLength(xml) > maximumSvdBytes) { throw new PeripheralPolicyUnavailable(svdSizeLimitMessage); }
	const { parser, finish } = automaticProfileParser();
	parser.write(xml);
	return finish();
}

export async function loadAutomaticPeripheralProfile(source: string): Promise<PeripheralProfile> {
	const { parser, finish } = automaticProfileParser();
	const decoder = new StringDecoder('utf8');
	let bytes = 0;
	const consume = async (chunks: AsyncIterable<Uint8Array>) => {
		for await (const chunk of chunks) {
			bytes += chunk.byteLength;
			if (bytes > maximumSvdBytes) { throw new PeripheralPolicyUnavailable(svdSizeLimitMessage); }
			parser.write(decoder.write(chunk));
		}
		parser.write(decoder.end());
	};
	if (source.toLowerCase().endsWith('.gz')) {
		await pipeline(createReadStream(source), createGunzip(), consume);
	} else {
		await pipeline(createReadStream(source), consume);
	}
	return finish();
}

const preparedProfiles = new Map<string, PeripheralProfile>();
const preparedAgentFiles = new Map<string, string>();
const preparedCatalogs = new Map<string, SvdRegisterCatalog>();
export function preparedPeripheralProfile(svdFile: string | undefined): PeripheralProfile | undefined {
	return svdFile ? preparedProfiles.get(path.normalize(svdFile)) : undefined;
}

export function preparedPeripheralAgentSvd(svdFile: string | undefined): string | undefined {
	return svdFile ? preparedAgentFiles.get(path.normalize(svdFile)) : undefined;
}

export function preparedPeripheralCatalog(svdFile: string | undefined): SvdRegisterCatalog | undefined {
	return svdFile ? preparedCatalogs.get(path.normalize(svdFile)) : undefined;
}

export async function preparePeripheralLaunch(config: Record<string, unknown>, storagePath: string): Promise<void> {
	if (config.peripheralReadProfile !== undefined && config.peripheralReadProfile !== 'auto' && config.peripheralReadProfile !== 'disabled' &&
		config.peripheralReadProfile !== peripheralProfileName) { throw new Error('Unknown peripheral read profile.'); }
	// MCP prepares before reserving its immutable launch configuration; the normal resolver must be idempotent.
	if (typeof config.svdFile === 'string' && preparedPeripheralCatalog(config.svdFile)) { return; }
	if (config.peripheralReadProfile === peripheralProfileName &&
		(typeof config.targetDevice !== 'string' || !/\bTC375\b/i.test(config.targetDevice))) {
		throw new Error('The legacy peripheral read profile requires an explicitly selected TC375 DAS device.');
	}
	const source = [config.svdFile, config.svdPath, config.definitionPath].find(value => typeof value === 'string' && value.trim()) ??
		await getAutomaticSvd(path.resolve(__dirname, '..'), typeof config.targetDevice === 'string' ? config.targetDevice : '');
	if (typeof source !== 'string') {
		config.__aurixPeripheralNotice = 'Peripheral reads unavailable: no unambiguous SVD match for the DAS model. Select an SVD in the existing debug dialog.';
		return;
	}
	const content = await readSvdFile(source);
	const catalog = extractSvdRegisterCatalog(content);
	const targetFamilies = svdDeviceFamilies(String(config.targetDevice ?? ''));
	if (targetFamilies.size && (targetFamilies.size !== 1 || !targetFamilies.has(`${catalog.device.slice(0, 4)}X`))) {
		throw new Error('Selected SVD device family does not match the DAS model.');
	}
	let profile: PeripheralProfile | undefined;
	let mcpNotice = config.peripheralReadProfile === 'disabled' ? 'MCP peripheral access disabled.' :
		`MCP uses the full SVD catalog (${catalog.registers.length} registers); writes require individual user approval.`;
	if (config.peripheralReadProfile === peripheralProfileName) {
		profile = await loadPeripheralProfile();
	}
	if (profile) { mcpNotice = `Legacy MCP peripheral profile: ${profile.registers.length} read-only registers; remove peripheralReadProfile to use the full catalog and approved writes.`; }
	const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
	const directory = path.join(storagePath, 'inspection-profiles');
	const filename = path.join(directory, `full-${digest}-${profile?.name ?? (config.peripheralReadProfile === 'disabled' ? 'mcp-disabled' : 'svd-native-v1')}.svd`);
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(filename, content, 'utf8');
	if (profile) { preparedProfiles.set(path.normalize(filename), profile); }
	preparedAgentFiles.set(path.normalize(filename), filename);
	preparedCatalogs.set(path.normalize(filename), catalog);
	config.__aurixPeripheralNotice = `Peripheral Viewer: full ${path.basename(source)} (${catalog.registers.length} register definitions), ` +
		`original SVD access permissions; native TCF Registers read/write. ${mcpNotice}`;
	config.svdFile = filename;
	config.svdPath = filename;
	config.definitionPath = filename;
}
