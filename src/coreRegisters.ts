import { GetChildrenRegistersCommand, GetContextRegistersCommand, GetRegistersCommand, RegistersContextData } from './tcf/registers';
import { SimpleCommand } from './tcf/tcfutils';

const SAFE_CORE_REGISTER = /^(?:A(?:[0-9]|1[0-5])|D(?:[0-9]|1[0-5])|PC|PCXI|PSW|FCX|LCX|ISP|ICR|BIV|BTV|SYSCON|CPU_ID|CORE_ID)$/i;
export type CoreRegister = { id: string; name: string; size?: number; readable: boolean; readOnce?: boolean; allowed: boolean };

export class CoreRegisterReader {
	constructor(private readonly send: <T>(command: SimpleCommand<T>) => Promise<T>) {}

	async list(contextId: string, check: () => void): Promise<CoreRegister[]> {
		let budget = 256;
		const visited = new Set<string>();
		const send = async <T>(command: SimpleCommand<T>): Promise<T> => {
			check();
			if (--budget < 0) { throw new Error('Core register metadata exceeds the 256-command budget.'); }
			const value = await this.send(command);
			check();
			return value;
		};
		const children = async (id: string) => (await send(new GetChildrenRegistersCommand(id))) ?? [];
		const context = async (id: string): Promise<RegistersContextData> => {
			const data = await send(new GetContextRegistersCommand(id));
			if (!data || data.ID !== id) { throw new Error('Register context metadata is unavailable or mismatched.'); }
			return data;
		};
		const roots = await children(contextId);
		const descriptions = [];
		for (const id of roots) { descriptions.push(await context(id)); }
		let groups = descriptions.filter(data => /^(core|core registers)$/i.test(data.Name?.trim() ?? ''));
		if (!groups.length && descriptions.length === 1) {
			for (const id of await children(descriptions[0].ID)) {
				const data = await context(id);
				if (/^(core|core registers)$/i.test(data.Name?.trim() ?? '')) { groups.push(data); }
			}
		}
		if (!groups.length) { throw new Error('No explicit CORE register group found. Peripheral fallback is disabled.'); }
		const result: CoreRegister[] = [];
		const walk = async (data: RegistersContextData, depth: number): Promise<void> => {
			if (depth > 6 || visited.has(data.ID)) { throw new Error('Core register tree is cyclic or too deep.'); }
			visited.add(data.ID);
			const ids = await children(data.ID);
			if (ids.length) {
				for (const id of ids) {
					const child = await context(id);
					if (child.ParentID !== undefined && child.ParentID !== data.ID) { throw new Error('Register parent does not match the CORE tree.'); }
					await walk(child, depth + 1);
				}
			} else {
				const name = data.Name ?? data.ID;
				result.push({ id: data.ID, name, size: data.Size, readable: data.Readable === true, readOnce: data.ReadOnce,
					allowed: SAFE_CORE_REGISTER.test(name) && data.Readable === true && data.ReadOnce !== true && data.Size === 4 });
			}
		};
		for (const group of groups) { await walk(group, 0); }
		return result;
	}

	async read(contextId: string, registerIds: readonly string[], check: () => void) {
		if (registerIds.length < 1 || registerIds.length > 32 || new Set(registerIds).size !== registerIds.length) {
			throw new Error('Select 1..32 distinct core registers.');
		}
		const known = await this.list(contextId, check);
		const selected = registerIds.map(id => {
			const metadata = known.find(register => register.id === id);
			if (!metadata?.allowed) { throw new Error(`Register '${id}' is not an allowed readable 32-bit CORE register. ReadOnce and peripheral registers are blocked.`); }
			return metadata;
		});
		const registers = [];
		for (const metadata of selected) {
			check();
			const bytes = await this.send(new GetRegistersCommand(metadata.id));
			check();
			if (bytes.length !== metadata.size) { throw new Error(`Incomplete value for core register ${metadata.name}.`); }
			registers.push({ ...metadata, bytesHex: bytes.toString('hex'), encoding: 'raw-bytes' as const });
		}
		return registers;
	}
}
