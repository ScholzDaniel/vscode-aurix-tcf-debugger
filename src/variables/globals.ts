import { createHash } from 'crypto';
import { z } from 'zod';
import { FindByNameSymbolsCommand, GetContextSymbolsCommand, TCFSymbolClass, TCFTypeClass } from '../tcf/symbols';
import { SimpleCommand } from '../tcf/tcfutils';
import { readInspectionElf, readableElfRangesFromBuffer, readInspectedMemory } from '../memoryInspection';
import { InspectedVariable, InspectionCheck, InspectionVariableHelper, MAX_VARIABLE_BYTES } from './inspection';
import { FixedNameProvider } from './types';

export const globalLookupSchema = z.object({
	name: z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	source: z.string().min(1).max(4096).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)).optional(),
}).strict();
export const globalSymbolSchema = z.object({
	reference: z.number().int().nonnegative(), name: z.string().min(1).max(256),
	source: z.string().max(4096).nullable(), scope: z.enum(['global', 'file-static', 'namespace', 'unknown']),
	type: z.string().max(4096).nullable(), size: z.number().int().nonnegative().max(0xffffffff).nullable(),
	address: z.string().regex(/^0x[0-9a-f]{1,8}$/).nullable(),
	storage: z.enum(['memory', 'constant', 'unavailable']), readable: z.boolean(),
	expandable: z.boolean(),
	unavailable: z.string().max(4096).nullable(), evidence: z.literal('Symbols.getContext'),
});
export const globalValueSchema = z.object({
	name: z.string(), value: z.string(), type: z.string().optional(), variablesReference: z.number().int().nonnegative(),
	source: z.string().nullable(), address: z.string().nullable(), size: z.number().int().min(1).max(MAX_VARIABLE_BYTES),
	bytesHex: z.string().regex(/^(?:[0-9a-f]{2})+$/).max(MAX_VARIABLE_BYTES * 2),
	byteOrder: z.enum(['little-endian', 'big-endian']), encoding: z.literal('raw-bytes'),
	evidence: z.enum(['Memory.get', 'Symbols.getContext']), storage: z.enum(['memory', 'constant']),
	pointerDereferenceAllowed: z.literal(false),
}).refine(value => value.bytesHex.length === value.size * 2, 'Incomplete global variable bytes.');

/* eslint-disable @typescript-eslint/naming-convention -- Validate native TCF metadata without inventing fields. */
const symbolSchema = z.object({
	ID: z.string().min(1).max(4096), Name: z.string().max(4096).nullable().optional(),
	Class: z.nativeEnum(TCFSymbolClass), TypeClass: z.nativeEnum(TCFTypeClass).optional(),
	TypeID: z.string().min(1).max(4096).optional(), BaseTypeID: z.string().min(1).max(4096).nullable().optional(),
	ContainerID: z.string().min(1).max(4096).nullable().optional(), OwnerID: z.string().max(4096).optional(),
	Size: z.number().int().min(0).max(0xffffffff).optional(), Address: z.number().int().min(0).max(0xffffffff).optional(),
	Value: z.string().max(MAX_VARIABLE_BYTES * 2).optional(), BigEndian: z.boolean().optional(),
	Register: z.string().optional(), Flags: z.number().int().nonnegative().max(0xffffffff).optional(),
	Length: z.number().int().nonnegative().optional(), Offset: z.number().int().optional(),
	BitSize: z.number().optional(), BitOffset: z.number().optional(), BitStride: z.number().optional(),
});
/* eslint-enable */
type SymbolContext = z.infer<typeof symbolSchema>;
export type GlobalSelection = {
	query: z.infer<typeof globalLookupSchema>; contextId: string; elfSha256: string;
	symbol: SymbolContext; type?: SymbolContext; containers: SymbolContext[];
	metadata: z.infer<typeof globalSymbolSchema>;
};
export function globalSourceMatches(actual: string | null, requested: string | undefined): boolean {
	if (requested === undefined) { return true; }
	if (actual === null) { return false; }
	const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
	const name = normalize(actual), filter = normalize(requested);
	return name === filter || name.endsWith('/' + filter);
}

export class GlobalVariableInspector {
	private readonly elfBigEndian: boolean;
	private readonly ranges;
	readonly elfSha256: string;
	constructor(private readonly send: <T>(command: SimpleCommand<T>) => Promise<T>, program: string) {
		const image = readInspectionElf(program);
		this.ranges = readableElfRangesFromBuffer(image);
		this.elfSha256 = createHash('sha256').update(image).digest('hex');
		this.elfBigEndian = image[5] === 2;
	}

	private async command<T>(request: SimpleCommand<T>, check?: InspectionCheck): Promise<T> {
		check?.();
		try {
			const result = await this.send(request);
			check?.();
			return result;
		} catch (error) {
			check?.();
			const native = z.object({ Code: z.number(), Format: z.string().optional() }).safeParse(error);
			if (native.success) {
				throw new Error(`${request.service()}.${request.command()} failed (TCF ${native.data.Code}): ${native.data.Format ?? 'No backend description'}. ` +
					'No expression or guessed-address fallback was attempted.');
			}
			throw error;
		}
	}

	async lookup(contextId: string, raw: unknown, check: InspectionCheck): Promise<GlobalSelection[]> {
		const query = globalLookupSchema.parse(raw);
		let commands = 0;
		const command = async <T>(request: SimpleCommand<T>): Promise<T> => {
			check();
			if (++commands > 512) { throw new Error('GLOBAL_METADATA_LIMIT: Symbol lookup exceeded 512 metadata commands.'); }
			return this.command(request, check);
		};
		const ids = z.array(z.string().min(1).max(4096)).max(64).nullable()
			.parse(await command(new FindByNameSymbolsCommand(contextId, query.name))) ?? [];
		if (new Set(ids).size !== ids.length) { throw new Error('GLOBAL_DUPLICATE_ID: Backend returned duplicate symbol IDs.'); }
		if (!ids.length) { throw new Error(`GLOBAL_SYMBOL_NOT_FOUND: No symbol named ${query.name}. It may be absent from this ELF or optimized out; no value was read.`); }
		const cache = new Map<string, SymbolContext>();
		const context = async (id: string) => {
			let result = cache.get(id);
			if (!result) {
				result = symbolSchema.parse(await command(new GetContextSymbolsCommand(id)));
				if (result.ID !== id) { throw new Error('GLOBAL_SYMBOL_ID_MISMATCH: Native symbol identity changed.'); }
				cache.set(id, result);
			}
			return result;
		};
		const selections: GlobalSelection[] = [];
		for (const id of ids) {
			const symbol = await context(id), containers: SymbolContext[] = [];
			if (symbol.Name !== query.name) { throw new Error('GLOBAL_NAME_MISMATCH: Native symbol name does not match the exact requested identifier.'); }
			const visited = new Set([id]);
			let parent = symbol.ContainerID;
			while (parent) {
				if (containers.length >= 16 || visited.has(parent)) { throw new Error('GLOBAL_SCOPE_INVALID: Cyclic or overly deep symbol scope.'); }
				visited.add(parent);
				const owner = await context(parent);
				containers.push(owner);
				if (owner.Class === TCFSymbolClass.comp_unit) { break; }
				parent = owner.ContainerID;
			}
			const unit = containers.find(container => container.Class === TCFSymbolClass.comp_unit);
			const source = unit?.Name ?? null;
			if (!globalSourceMatches(source, query.source)) { continue; }
			let type: SymbolContext | undefined;
			if (symbol.TypeID) {
				type = await context(symbol.TypeID);
				const types = new Set<string>();
				while ((type.TypeClass === undefined || type.TypeClass === TCFTypeClass.unknown) && type.BaseTypeID) {
					if (types.size >= 16 || types.has(type.ID)) { throw new Error('GLOBAL_TYPE_INVALID: Cyclic or overly deep type aliases.'); }
					types.add(type.ID);
					type = await context(type.BaseTypeID);
				}
			}
			const size = symbol.Size ?? type?.Size ?? null;
			const storage = symbol.Address !== undefined ? 'memory' : symbol.Value !== undefined ? 'constant' : 'unavailable';
			const scope = containers.some(container => container.Class !== TCFSymbolClass.comp_unit && container.Class !== TCFSymbolClass.namespace)
				? 'unknown' : containers.some(container => container.Class === TCFSymbolClass.namespace) ? 'namespace' :
					(symbol.Flags ?? 0) & 0x8000 ? 'global' : unit ? (symbol.Flags === undefined ? 'unknown' : 'file-static') : 'unknown';
			let unavailable: string | null = null;
			if (![TCFSymbolClass.reference, TCFSymbolClass.value].includes(symbol.Class)) {
				unavailable = 'GLOBAL_NOT_DATA: The name identifies a function, type or other non-data symbol.';
			} else if (containers.some(container => container.Class !== TCFSymbolClass.comp_unit && container.Class !== TCFSymbolClass.namespace)) {
				unavailable = 'GLOBAL_NOT_FILE_SCOPE: A function-local or member symbol is not a global/file-static variable.';
			} else if (symbol.Register !== undefined || ((symbol.Flags ?? 0) & 0x08000000) !== 0 ||
				symbol.BitSize !== undefined || symbol.BitOffset !== undefined || symbol.BitStride !== undefined) {
				unavailable = 'GLOBAL_STORAGE_UNSUPPORTED: Register-backed, indirect or bitfield storage is not supported.';
			} else if (!type || type.Class !== TCFSymbolClass.type || type.TypeClass === undefined || type.TypeClass === TCFTypeClass.unknown ||
				![TCFTypeClass.cardinal, TCFTypeClass.integer, TCFTypeClass.real, TCFTypeClass.pointer, TCFTypeClass.array,
					TCFTypeClass.composite, TCFTypeClass.enumeration].includes(type.TypeClass)) {
				unavailable = 'GLOBAL_TYPE_UNAVAILABLE: Native debug type metadata is missing or unsupported; no guessed type is used.';
			} else if (!size || size > MAX_VARIABLE_BYTES || (type.Size !== undefined && type.Size !== size)) {
				unavailable = 'GLOBAL_SIZE_UNSUPPORTED: Variable/type size mismatch or size outside 1..4096 bytes.';
			} else if (storage === 'memory' && !this.ranges.some(range => symbol.Address! >= range.start && symbol.Address! + size <= range.end)) {
				unavailable = 'GLOBAL_ADDRESS_UNSAFE: Symbol is outside readable ELF-backed RAM/flash; MMIO and aliases are not exposed.';
			} else if (storage === 'unavailable') {
				unavailable = 'GLOBAL_LOCATION_UNAVAILABLE: No native address or constant value. The variable may be optimized out.';
			}
			const metadata = globalSymbolSchema.parse({ reference: 0, name: query.name, source, scope, type: type?.Name ?? null,
				size, address: symbol.Address === undefined ? null : `0x${symbol.Address.toString(16)}`, storage, readable: unavailable === null,
				expandable: type?.TypeClass === TCFTypeClass.composite || type?.TypeClass === TCFTypeClass.array,
				unavailable, evidence: 'Symbols.getContext' });
			selections.push({ query, contextId, elfSha256: this.elfSha256, symbol, type, containers, metadata });
		}
		check();
		if (!selections.length) { throw new Error('GLOBAL_SOURCE_NOT_FOUND: No exact-name symbol with the requested compilation-unit name/path suffix. List without source to inspect candidates.'); }
		return selections;
	}

	async read(selection: GlobalSelection, check: InspectionCheck) {
		if (selection.elfSha256 !== this.elfSha256) { throw new Error('GLOBAL_ELF_CHANGED: ELF changed since lookup. Obtain a new symbol handle.'); }
		const current = (await this.lookup(selection.contextId, selection.query, check)).find(candidate => candidate.symbol.ID === selection.symbol.ID);
		if (!current || JSON.stringify(current) !== JSON.stringify(selection)) { throw new Error('GLOBAL_SYMBOL_CHANGED: Symbol storage, type or scope changed since lookup. Obtain a new handle.'); }
		if (!current.metadata.readable || !current.type || !current.metadata.size) { throw new Error(current.metadata.unavailable ?? 'Global variable is unavailable.'); }
		const symbol = current.symbol, type = current.type, size = current.metadata.size;
		let bytes: Buffer, bigEndian: boolean;
		const constant = current.metadata.storage === 'constant';
		if (constant) {
			if (symbol.Value === undefined || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(symbol.Value)) {
				throw new Error('GLOBAL_CONSTANT_INVALID: Native constant bytes are not valid base64.');
			}
			bytes = Buffer.from(symbol.Value, 'base64');
			bigEndian = symbol.BigEndian === true;
		} else {
			const endianFlags = ((symbol.Flags ?? 0) | (type.Flags ?? 0)) & 0x3000;
			if (endianFlags === 0x3000) { throw new Error('GLOBAL_ENDIAN_CONFLICT: Native symbol/type byte order conflicts.'); }
			bigEndian = endianFlags ? endianFlags === 0x1000 : this.elfBigEndian;
			const value = await readInspectedMemory(request => this.command(request, check), selection.contextId, this.ranges, { address: current.metadata.address, count: size }, check);
			bytes = Buffer.from(value.bytesHex, 'hex');
		}
		check();
		if (bytes.length !== size) { throw new Error('GLOBAL_VALUE_INCOMPLETE: Native bytes do not match variable size; no padding is returned.'); }
		const helper = new InspectionVariableHelper(request => this.command(request), check);
		const variable = helper.createVariable(type, symbol, new FixedNameProvider(current.metadata.name),
			{ value: async () => bytes, isBigEndian: () => bigEndian });
		if (!(variable instanceof InspectedVariable)) { throw new Error('GLOBAL_TYPE_UNAVAILABLE: Cannot render this global variable type.'); }
		const value = await variable.displayValue();
		check();
		return { variable, value: globalValueSchema.parse({
			name: current.metadata.name, value, type: type.Name ?? undefined, variablesReference: 0,
			source: current.metadata.source, address: current.metadata.address, size, bytesHex: bytes.toString('hex'),
			byteOrder: bigEndian ? 'big-endian' : 'little-endian', encoding: 'raw-bytes',
			evidence: constant ? 'Symbols.getContext' : 'Memory.get', storage: constant ? 'constant' : 'memory', pointerDereferenceAllowed: false,
		}) };
	}
}
