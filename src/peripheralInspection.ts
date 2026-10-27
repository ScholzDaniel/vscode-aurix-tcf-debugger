/* eslint-disable @typescript-eslint/naming-convention -- TCF wire-format metadata. */
import { z } from 'zod';
import { GetChildrenRegistersCommand, GetContextRegistersCommand, GetRegistersCommand } from './tcf/registers';
import { SimpleCommand } from './tcf/tcfutils';
import { PeripheralDefinition, PeripheralProfile } from './peripheralProfile';
import { NativePeripheralAccess } from './nativePeripheralAccess';

export const peripheralNamesSchema = z.array(z.string().min(1).max(256)
	.refine(name => name.trim() === name && !/[\x00-\x1f\x7f]/.test(name)))
	.min(1).max(32).refine(names => new Set(names).size === names.length, 'Use distinct exact register names.');

export const peripheralPageSchema = z.object({
	start: z.number().int().min(0).max(131072).default(0),
	count: z.number().int().min(1).max(100).default(20),
	filter: z.string().max(128).default(''),
	exactNames: peripheralNamesSchema.optional(),
});

const nativeSchema = z.object({
	ID: z.string().min(1).max(4096), ParentID: z.string().max(4096).optional(),
	Name: z.string().max(256), Size: z.number().int().nonnegative().optional(),
	Readable: z.boolean().optional(), ReadOnce: z.boolean().optional(),
	BigEndian: z.boolean().optional(), MemoryAddress: z.number().int().min(0).max(0xffffffff).optional(),
	Bits: z.array(z.number()).optional(),
});
export const peripheralRegisterSchema = z.object({
	id: z.string().min(1).max(4096), name: z.string().min(1).max(256),
	address: z.string().regex(/^0x[0-9a-f]{1,8}$/), size: z.number().int().positive().max(0xffffffff),
	readable: z.boolean(), allowed: z.boolean(), writable: z.boolean().default(false),
	readAction: z.boolean().default(false), writeRequiresApproval: z.boolean().default(false),
	byteOrder: z.enum(['little-endian', 'big-endian', 'unknown']),
	policy: z.enum(['tc375-gtm-atom0-ch4', 'svd-safe-config-v1', 'svd-native-v1']), evidence: z.enum(['SVD', 'Registers.getContext']),
});
export const peripheralValueSchema = peripheralRegisterSchema.extend({
	byteOrder: z.enum(['little-endian', 'big-endian']), evidence: z.literal('Registers.getContext'),
	bytesHex: z.string().regex(/^(?:[0-9a-f]{2}){1,8}$/), encoding: z.literal('raw-bytes'),
}).refine(value => value.bytesHex.length === value.size * 2 && value.allowed && value.readable, 'Incomplete or disallowed peripheral value.');
export const peripheralWriteInfoSchema = z.object({
	token: z.string().uuid(), id: z.string(), name: z.string().min(1).max(256),
	address: z.string().regex(/^0x[0-9a-f]{1,8}$/), size: z.number().int().min(1).max(8),
	valueHex: z.string().regex(/^0x[0-9a-f]{2,16}$/), threadId: z.number().int().positive(),
	contextId: z.string().min(1).max(4096), epoch: z.number().int().nonnegative(), expiresAt: z.number().int(),
});
export const peripheralWriteResultSchema = z.object({
	id: z.string(), name: z.string(), address: z.string(), size: z.number().int().min(1).max(8),
	valueHex: z.string(), evidence: z.literal('Registers.set'), writes: z.literal(1),
	readBackPerformed: z.literal(false), inspectionEpoch: z.number().int().nonnegative(),
});

export class FullPeripheralReader {
	constructor(private readonly native: NativePeripheralAccess) {}
	private metadata(id: string) {
		const definition = this.native.definition(id);
		return peripheralRegisterSchema.parse({ id, name: definition.name, address: `0x${definition.address.toString(16)}`,
			size: definition.size, readable: definition.readable, writable: definition.writable,
			readAction: definition.readAction, allowed: definition.readable && !definition.readAction && definition.size <= 8,
			writeRequiresApproval: definition.writable && definition.size <= 8, byteOrder: 'unknown', policy: 'svd-native-v1', evidence: 'SVD' });
	}
	catalog(raw: unknown, check: () => void) {
		check();
		const page = peripheralPageSchema.parse(raw);
		const matches = this.native.catalog.registers.map((register, index) => ({ register, id: `svd:${index}` }))
			.filter(({ register }) => register.name.toLowerCase().includes(page.filter.toLowerCase()) &&
				(page.exactNames === undefined || page.exactNames.includes(register.name)));
		return { start: page.start, total: matches.length, catalogTotal: this.native.catalog.registers.length, excludedDefinitions: 0,
			registers: matches.slice(page.start, page.start + page.count).map(({ id }) => this.metadata(id)) };
	}
	async read(contextId: string, ids: readonly string[], check: () => void) {
		return (await this.native.readIds(contextId, ids, check)).map((value, index) => peripheralValueSchema.parse({
			...this.metadata(ids[index]), evidence: 'Registers.getContext', byteOrder: value.bigEndian ? 'big-endian' : 'little-endian',
			bytesHex: value.bytes.toString('hex'), encoding: 'raw-bytes',
		}));
	}
	readViewerRange(contextId: string, address: number, count: number, check: () => void): Promise<Buffer> {
		return this.native.readRange(contextId, address, count, check);
	}
}
type NativeRegister = z.infer<typeof nativeSchema>;
type ResolvedRegister = { metadata: z.infer<typeof peripheralRegisterSchema>; nativeId: string };
const normalize = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class PeripheralRegisterReader {
	constructor(private readonly send: <T>(command: SimpleCommand<T>) => Promise<T>,
		private readonly profile: PeripheralProfile, private readonly native?: NativePeripheralAccess) {}

	catalog(raw: unknown, check: () => void) {
		check();
		const page = peripheralPageSchema.parse(raw);
		const matches = this.profile.registers.filter(register => register.name.toLowerCase().includes(page.filter.toLowerCase()) &&
			(page.exactNames === undefined || page.exactNames.includes(register.name)));
		return { start: page.start, total: matches.length, catalogTotal: this.profile.registers.length,
			excludedDefinitions: this.profile.excluded ?? 0,
			registers: matches.slice(page.start, page.start + page.count).map(register => peripheralRegisterSchema.parse({
				id: register.name, name: register.name, address: `0x${register.address.toString(16)}`, size: 4,
				readable: true, allowed: true, byteOrder: 'unknown', policy: this.profile.name, evidence: 'SVD',
			})) };
	}

	async list(contextId: string, check: () => void) {
		return (await this.resolve(contextId, this.profile.registers, check)).map(register => register.metadata);
	}

	private async resolve(contextId: string, selected: PeripheralDefinition[], check: () => void): Promise<ResolvedRegister[]> {
		let budget = 1024;
		const visited = new Set<string>();
		const found = new Map<string, NativeRegister>();
		const groups = new Set(this.profile.registers.map(register => register.group).filter(group => group !== undefined).map(normalize));
		const selectedGroups = new Set(selected.map(register => register.group).filter(group => group !== undefined).map(normalize));
		const send = async <T>(command: SimpleCommand<T>) => {
			check();
			if (--budget < 0) { throw new Error('Peripheral metadata exceeds 1024 commands; narrow the selection. No values were read.'); }
			const result = await this.send(command);
			check();
			return result;
		};
		const walk = async (parent: string, names: string[], depth: number): Promise<void> => {
			if (depth > 6) { throw new Error('Peripheral register tree is too deep.'); }
			const ids = await send(new GetChildrenRegistersCommand(parent)) ?? [];
			if (ids.length > 4096) { throw new Error('Peripheral register tree exceeds the safe-profile child limit.'); }
			for (const id of ids) {
				if (visited.has(id)) { throw new Error('Cyclic or duplicated peripheral register context.'); }
				visited.add(id);
				const data = nativeSchema.parse(await send(new GetContextRegistersCommand(id)));
				if (data.ID !== id || (data.ParentID !== undefined && data.ParentID !== parent)) {
					throw new Error('Peripheral context ID or parent mismatch.');
				}
				if (/^(CORE|CORE REGISTERS)$/i.test(data.Name.trim())) { continue; }
				const hierarchy = [...names, data.Name];
				const match = selected.find(register => hierarchy.some((_name, index) =>
					normalize(hierarchy.slice(index).join('_')) === normalize(register.group
						? `${register.group}_${register.register}` : register.name)));
				if (match) {
					if (found.has(match.name)) { throw new Error('Ambiguous native peripheral register identity.'); }
					if (data.Size !== 4 || data.Readable !== true || data.ReadOnce === true || data.Bits !== undefined ||
						(data.MemoryAddress !== undefined && data.MemoryAddress !== match.address)) {
						throw new Error(`Peripheral metadata rejects ${match.name}: size, readability, read side effects, bitfield or address mismatch.`);
					}
					found.set(match.name, data);
				} else if (data.Size === undefined || data.Size === 0) {
					if (groups.has(normalize(data.Name)) && !selectedGroups.has(normalize(data.Name))) { continue; }
					await walk(id, hierarchy, depth + 1);
				}
			}
		};
		await walk(contextId, [], 0);
		return selected.map(register => {
			const data = found.get(register.name);
			if (!data) { throw new Error(`Native register ${register.name} not found in the session's generated SVD; no Memory.get fallback is allowed.`); }
			return { nativeId: data.ID, metadata: peripheralRegisterSchema.parse({
				id: register.name, name: register.name, address: `0x${register.address.toString(16)}`, size: 4,
				readable: true, allowed: true, byteOrder: data.BigEndian ? 'big-endian' : 'little-endian',
				policy: this.profile.name, evidence: 'Registers.getContext',
			}) };
		});
	}

	async read(contextId: string, ids: readonly string[], check: () => void) {
		if (ids.length < 1 || ids.length > 32 || new Set(ids).size !== ids.length) {
			throw new Error('Select 1..32 distinct approved peripheral registers.');
		}
		const selected = ids.map(id => {
			const register = this.profile.registers.find(item => item.name === id);
			if (!register) { throw new Error('Peripheral register is not in the active read-only profile.'); }
			return register;
		});
		if (this.native) {
			for (const register of selected) {
				if (!this.native.matches(register.name, register.address, 4)) {
					throw new Error('Full SVD register does not match the MCP read-only address policy.');
				}
			}
			return (await this.native.read(contextId, selected.map(register => register.name), check)).map(value => {
				const register = selected.find(item => item.name === value.definition.name)!;
				return peripheralValueSchema.parse({
					id: register.name, name: register.name, address: `0x${register.address.toString(16)}`, size: 4,
					readable: true, allowed: true, byteOrder: value.bigEndian ? 'big-endian' : 'little-endian',
					policy: this.profile.name, evidence: 'Registers.getContext', bytesHex: value.bytes.toString('hex'), encoding: 'raw-bytes',
				});
			});
		}
		return this.readSelected(await this.resolve(contextId, selected, check), check);
	}

	private async readSelected(selected: ResolvedRegister[], check: () => void) {
		const result = [];
		for (const { metadata: register, nativeId } of selected) {
			check();
			const bytes = await this.send(new GetRegistersCommand(nativeId));
			check();
			if (bytes.length !== 4) { throw new Error(`Incomplete peripheral register ${register.name}; no padding is returned.`); }
			result.push(peripheralValueSchema.parse({ ...register, bytesHex: bytes.toString('hex'), encoding: 'raw-bytes' }));
		}
		return result;
	}

	async readViewerRange(contextId: string, address: number, count: number, check: () => void): Promise<Buffer> {
		if (!Number.isSafeInteger(address) || !Number.isInteger(count) || address % 4 !== 0 || count < 4 || count > 128 || count % 4 !== 0) {
			throw new Error('Peripheral Viewer reads must contain 1..32 complete aligned approved registers.');
		}
		const names: string[] = [];
		for (let offset = 0; offset < count; offset += 4) {
			const register = this.profile.registers.find(item => item.address === address + offset);
			if (!register) { throw new Error('Peripheral Viewer requested an unapproved register or gap. No Memory.get fallback is allowed.'); }
			names.push(register.name);
		}
		const values = await this.read(contextId, names, check);
		return Buffer.concat(values.map(value => {
			const bytes = Buffer.from(value.bytesHex, 'hex');
			return value.byteOrder === 'big-endian' ? bytes.reverse() : bytes;
		}));
	}
}
