/* eslint-disable @typescript-eslint/naming-convention -- TCF wire-format metadata. */
import { z } from 'zod';
import { GetChildrenRegistersCommand, GetContextRegistersCommand, GetRegistersCommand, SetRegistersCommand } from './tcf/registers';
import { SimpleCommand } from './tcf/tcfutils';
import { SvdRegister, SvdRegisterCatalog } from './svdRegisterCatalog';

const metadataSchema = z.object({
	ID: z.string().min(1).max(4096), ParentID: z.string().optional(), Name: z.string().max(256),
	Size: z.number().int().nonnegative().optional(), Readable: z.boolean().optional(), Writeable: z.boolean().optional(),
	ReadOnce: z.boolean().optional(), BigEndian: z.boolean().optional(), Bits: z.array(z.number()).optional(),
	MemoryAddress: z.number().int().min(0).max(0xffffffff).optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
type MetadataChildren = { ids?: string[]; metadata: Metadata[]; pending?: Promise<Metadata[]> };
type PeripheralAccessCheck = (phase?: 'metadata' | 'values') => void;
const METADATA_CONCURRENCY = 8;
export type NativePeripheralWrite = Readonly<{
	id: string; name: string; address: string; size: number; valueHex: string;
	contextId: string; nativeId: string; bytesHex: string; bigEndian: boolean;
}>;
const normalize = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class NativePeripheralAccess {
	private readonly byName = new Map<string, SvdRegister[]>();
	private readonly byAddress = new Map<number, SvdRegister[]>();
	private readonly branches = new Set<string>();
	private readonly childrenCache = new Map<string, MetadataChildren>();
	private readonly metadataSlots = new Set<Promise<void>>();

	constructor(private readonly send: <T>(command: SimpleCommand<T>) => Promise<T>, readonly catalog: SvdRegisterCatalog) {
		for (const register of catalog.registers) {
			const names = this.byName.get(register.name) ?? [];
			names.push(register);
			this.byName.set(register.name, names);
			const aliases = this.byAddress.get(register.address) ?? [];
			aliases.push(register);
			this.byAddress.set(register.address, aliases);
			for (let end = 1; end < register.path.length; end++) { this.branches.add(normalize(register.path.slice(0, end).join('_'))); }
		}
	}

	invalidate(): void { this.childrenCache.clear(); }
	hasAddress(address: number): boolean { return this.byAddress.has(address); }
	definition(id: string): SvdRegister {
		if (!/^svd:(?:0|[1-9][0-9]*)$/.test(id)) { throw new Error('Invalid SVD register ID.'); }
		const definition = this.catalog.registers[Number(id.slice(4))];
		if (!definition) { throw new Error('SVD register ID is not in this session catalog.'); }
		return definition;
	}

	async readIds(contextId: string, ids: readonly string[], check: PeripheralAccessCheck) {
		if (!ids.length || ids.length > 32 || new Set(ids).size !== ids.length) { throw new Error('Select 1..32 distinct SVD registers.'); }
		return this.readDefinitions(contextId, ids.map(id => this.definition(id)), check);
	}
	matches(name: string, address: number, size: number): boolean {
		const definitions = this.byName.get(name);
		return definitions?.length === 1 && definitions[0].address === address && definitions[0].size === size;
	}

	private async command<T>(command: SimpleCommand<T>): Promise<T> {
		try {
			return await this.send(command);
		} catch (error) {
			const report = z.object({ Code: z.number(), Format: z.string().optional(), Params: z.array(z.unknown()).optional() }).safeParse(error);
			if (report.success) {
				throw new Error(`Registers.${command.command()} failed (TCF ${report.data.Code}): ` +
					`${report.data.Format ?? 'backend rejected the request'}${report.data.Params ? `; parameters=${JSON.stringify(report.data.Params)}` : ''}`);
			}
			throw error;
		}
	}

	private async metadataCommand<T>(command: SimpleCommand<T>, check: PeripheralAccessCheck): Promise<T> {
		while (this.metadataSlots.size >= METADATA_CONCURRENCY) {
			await Promise.race(this.metadataSlots);
			check('metadata');
		}
		check('metadata');
		let release!: () => void;
		const slot = new Promise<void>(resolve => { release = resolve; });
		this.metadataSlots.add(slot);
		try { return await this.command(command); }
		finally { this.metadataSlots.delete(slot); release(); }
	}

	private async resolve(contextId: string, selected: SvdRegister[], check: PeripheralAccessCheck): Promise<Metadata[]> {
		check('metadata');
		const found = new Map<SvdRegister, Metadata>();
		const visited = new Set<string>();
		const targets = selected.map(register => ({ register, name: normalize(register.name) }));
		let budget = 16384;
		const request = async <T>(command: SimpleCommand<T>): Promise<T> => {
			check('metadata');
			if (--budget < 0) { throw new Error('Peripheral metadata request limit exceeded; no values were accessed.'); }
			const result = await this.metadataCommand(command, check);
			check('metadata');
			return result;
		};
		const children = async (parent: string): Promise<Metadata[]> => {
			check();
			let entry = this.childrenCache.get(parent);
			if (!entry) {
				if (this.childrenCache.size >= 8192) { throw new Error('Peripheral metadata cache limit exceeded.'); }
				entry = { metadata: [] };
				this.childrenCache.set(parent, entry);
			}
			const cached = entry;
			const pending = cached.pending ??= (async () => {
				if (!cached.ids) {
					const ids = await request(new GetChildrenRegistersCommand(parent)) ?? [];
					if (ids.length > 8192 || new Set(ids).size !== ids.length) { throw new Error('Invalid or oversized native register children.'); }
					cached.ids = ids;
				}
				while (cached.metadata.length < cached.ids.length) {
					check('metadata');
					const ids = cached.ids.slice(cached.metadata.length, cached.metadata.length + METADATA_CONCURRENCY);
					// Drain the entire metadata batch on failure; never leave a background lookup running.
					const results = await Promise.allSettled(ids.map(async id => {
						const data = metadataSchema.parse(await request(new GetContextRegistersCommand(id)));
						if (data.ID !== id || (data.ParentID !== undefined && data.ParentID !== parent)) {
							throw new Error('Native register context ID or parent mismatch.');
						}
						return data;
					}));
					const batch: Metadata[] = [];
					for (const result of results) {
						if (result.status === 'rejected') { throw result.reason; }
						batch.push(result.value);
					}
					check('metadata');
					cached.metadata.push(...batch);
				}
				return cached.metadata;
			})();
			try {
				const result = await pending;
				check();
				return result;
			} finally {
				// Keep completed batches only in this cache generation; invalidate() drops the entry.
				if (cached.pending === pending) { cached.pending = undefined; }
			}
		};
		const walk = async (parent: string, path: string[], depth: number): Promise<void> => {
			if (depth > 16 || visited.has(parent)) { throw new Error('Cyclic or excessively deep native register hierarchy.'); }
			visited.add(parent);
			for (const data of await children(parent)) {
				const hierarchy = [...path, data.Name];
				const suffixes = hierarchy.map((_name, index) => normalize(hierarchy.slice(index).join('_')));
				const matches = data.Size ? targets.filter(target => suffixes.includes(target.name) &&
					(data.MemoryAddress === undefined || data.MemoryAddress === target.register.address)) : [];
				if (matches.length) {
					for (const { register } of matches) {
						if (found.has(register)) {
							throw new Error(`Ambiguous native register: ${register.name} (${found.get(register)!.ID}, ${data.ID}; ${hierarchy.join('.')}).`);
						}
						if (data.Size !== register.size || data.Bits !== undefined ||
							(data.MemoryAddress !== undefined && data.MemoryAddress !== register.address)) {
							throw new Error(`Native size/address/bitfield mismatch for ${register.name}.`);
						}
						found.set(register, data);
					}
				} else if (!data.Size) {
					const known = suffixes.filter(suffix => this.branches.has(suffix));
					if (known.length && !targets.some(target => known.some(prefix => target.name.startsWith(prefix)))) { continue; }
					// An explicit CORE group is separate from SVD peripherals unless the SVD selected it.
					if (/^(CORE|CORE REGISTERS)$/i.test(data.Name.trim()) && !known.length) { continue; }
					await walk(data.ID, hierarchy, depth + 1);
				}
			}
		};
		await walk(contextId, [], 0);
		return selected.map(register => {
			const native = found.get(register);
			if (!native) { throw new Error(`Native register ${register.name} not found in the selected SVD hierarchy; no memory fallback is allowed.`); }
			if ((this.byName.get(register.name)?.length ?? 0) > 1 && native.MemoryAddress === undefined) {
				throw new Error(`Native MemoryAddress is required to disambiguate ${register.name}.`);
			}
			return native;
		});
	}

	async read(contextId: string, names: readonly string[], check: PeripheralAccessCheck) {
		const selected = names.map(name => {
			const definitions = this.byName.get(name);
			if (definitions?.length !== 1) { throw new Error(`Unknown or ambiguous SVD register name: ${name}.`); }
			return definitions[0];
		});
		return this.readDefinitions(contextId, selected, check);
	}

	private async readDefinitions(contextId: string, selected: SvdRegister[], check: PeripheralAccessCheck) {
		for (const register of selected) {
			if (!register.readable || register.readAction || register.size > 8) { throw new Error(`SVD does not permit automatic reading of ${register.name} or its width is unsupported.`); }
		}
		const metadata = await this.resolve(contextId, selected, check);
		for (const data of metadata) {
			if (data.Readable !== true || data.ReadOnce === true) { throw new Error(`Backend does not permit automatic reading of ${data.Name}.`); }
		}
		const results = [];
		for (let index = 0; index < metadata.length; index++) {
			check('values');
			const data = metadata[index], definition = selected[index];
			const bytes = await this.command(new GetRegistersCommand(data.ID));
			check('values');
			if (bytes.length !== definition.size) { throw new Error(`Incomplete native peripheral register ${definition.name}; no padding is returned.`); }
			results.push({ definition, bytes, bigEndian: data.BigEndian === true });
		}
		return results;
	}

	async readRange(contextId: string, address: number, count: number, check: PeripheralAccessCheck): Promise<Buffer> {
		if (!Number.isSafeInteger(address) || !Number.isSafeInteger(count) || count < 1 || count > 4096 || address + count > 0x100000000) {
			throw new Error('Invalid peripheral read range (1..4096 bytes).');
		}
		const selected: SvdRegister[] = [];
		for (let next = address; next < address + count;) {
			const aliases = this.byAddress.get(next);
			if (!aliases || aliases.length !== 1) { throw new Error('Peripheral range contains an unknown address, gap or ambiguous alias.'); }
			const register = aliases[0];
			if (register.size > 8 || register.address + register.size > address + count) {
				throw new Error('Peripheral reads must contain complete registers of at most 8 bytes.');
			}
			selected.push(register);
			next += register.size;
		}
		return Buffer.concat((await this.readDefinitions(contextId, selected, check))
			.map(value => value.bigEndian ? Buffer.from(value.bytes).reverse() : value.bytes));
	}

	async writeRegister(contextId: string, address: number, bytes: Buffer, check: PeripheralAccessCheck): Promise<void> {
		const aliases = this.byAddress.get(address);
		if (!aliases || aliases.length !== 1) { throw new Error('Unknown or ambiguous SVD register address for write.'); }
		const register = aliases[0];
		if (!register.writable || bytes.length !== register.size || bytes.length > 8) {
			throw new Error('SVD register is not writable or write size does not match the complete register.');
		}
		const [metadata] = await this.resolve(contextId, [register], check);
		if (metadata.Writeable !== true) { throw new Error(`Backend does not permit writing ${register.name}.`); }
		check('values');
		// Pass exactly the user's register payload; never add reads, RMW, retries or verification reads.
		await this.command(new SetRegistersCommand(metadata.ID, metadata.BigEndian ? Buffer.from(bytes).reverse() : bytes));
		check();
	}

	async prepareWrite(contextId: string, id: string, value: string, check: PeripheralAccessCheck): Promise<NativePeripheralWrite> {
		const register = this.definition(id);
		if (!register.writable || register.size > 8) { throw new Error('SVD register is not writable or its width is unsupported.'); }
		if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) || value.length > 128) { throw new Error('Write value must be an unsigned decimal or hexadecimal string.'); }
		const integer = BigInt(value);
		if (integer >= (1n << BigInt(register.size * 8))) { throw new Error('Write value exceeds the register width.'); }
		this.invalidate();
		const [metadata] = await this.resolve(contextId, [register], check);
		if (metadata.Writeable !== true) { throw new Error(`Backend does not permit writing ${register.name}.`); }
		const hex = integer.toString(16).padStart(register.size * 2, '0');
		const bytes = Buffer.from(hex, 'hex');
		if (!metadata.BigEndian) { bytes.reverse(); }
		check();
		return Object.freeze({ id, name: register.name, address: `0x${register.address.toString(16)}`, size: register.size,
			valueHex: `0x${hex}`, contextId, nativeId: metadata.ID, bytesHex: bytes.toString('hex'), bigEndian: metadata.BigEndian === true });
	}

	async commitWrite(approved: NativePeripheralWrite, check: PeripheralAccessCheck): Promise<void> {
		const current = await this.prepareWrite(approved.contextId, approved.id, approved.valueHex, check);
		if (JSON.stringify(current) !== JSON.stringify(approved)) { throw new Error('Peripheral write metadata changed after approval; no write was sent.'); }
		check('values');
		await this.command(new SetRegistersCommand(current.nativeId, Buffer.from(current.bytesHex, 'hex')));
		check();
	}
}
