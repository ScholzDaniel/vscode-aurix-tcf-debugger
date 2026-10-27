import * as fs from 'fs';
import { z } from 'zod';
import { GetMemoryCommand } from './tcf/memory';
import { SimpleCommand } from './tcf/tcfutils';

export const memoryReadSchema = z.object({
	address: z.string().regex(/^0x[0-9a-fA-F]{1,8}$/),
	count: z.number().int().min(1).max(4096),
}).strict();
export const memoryValueSchema = z.object({
	address: z.string().regex(/^0x[0-9a-f]{1,8}$/),
	count: z.number().int().min(1).max(4096),
	bytesHex: z.string().regex(/^(?:[0-9a-f]{2})+$/).max(8192),
	encoding: z.literal('raw-bytes'), evidence: z.literal('Memory.get'),
}).refine(value => value.bytesHex.length === value.count * 2, 'Incomplete memory value.');
export type AddressRange = { start: number; end: number };

export function mergeRanges(ranges: readonly AddressRange[]): AddressRange[] {
	const result: AddressRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const last = result[result.length - 1];
		if (last && range.start <= last.end) { last.end = Math.max(last.end, range.end); }
		else { result.push({ ...range }); }
	}
	return result;
}

export function elfLoadRanges(buf: Buffer, requiredFlag: number): AddressRange[] {
	if (buf.length < 64 || !buf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
		![1, 2].includes(buf[4]) || ![1, 2].includes(buf[5])) { throw new Error('Invalid ELF header.'); }
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const little = buf[5] === 1;
	const u16 = (offset: number) => view.getUint16(offset, little);
	const u32 = (offset: number) => view.getUint32(offset, little);
	const u64 = (offset: number) => {
		const value = Number(view.getBigUint64(offset, little));
		if (!Number.isSafeInteger(value)) { throw new Error('ELF address exceeds safe integer precision.'); }
		return value;
	};
	const elf32 = buf[4] === 1;
	const start = elf32 ? u32(28) : u64(32);
	const stride = u16(elf32 ? 42 : 54);
	const count = u16(elf32 ? 44 : 56);
	if (count === 0) { return []; }
	if (count > 4096 || stride < (elf32 ? 32 : 56) || start < (elf32 ? 52 : 64) ||
		!Number.isSafeInteger(start + stride * count) || start + stride * count > buf.length) {
		throw new Error('Invalid or oversized ELF program header table.');
	}
	const ranges: AddressRange[] = [];
	for (let index = 0; index < count; index++) {
		const offset = start + index * stride;
		const flags = u32(offset + (elf32 ? 24 : 4));
		if (u32(offset) !== 1 || (flags & requiredFlag) !== requiredFlag) { continue; }
		const address = elf32 ? u32(offset + 8) : u64(offset + 16);
		const size = elf32 ? u32(offset + 20) : u64(offset + 40);
		const end = address + size;
		if (!Number.isSafeInteger(end)) { throw new Error('Invalid ELF load range.'); }
		if (size > 0) { ranges.push({ start: address, end }); }
	}
	return mergeRanges(ranges);
}

export function readInspectionElf(program: string): Buffer {
	const stat = fs.statSync(program);
	if (!stat.isFile() || stat.size > 128 * 1024 * 1024) { throw new Error('Inspection ELF must be a file no larger than 128 MiB.'); }
	const bytes = fs.readFileSync(program);
	if (bytes.length !== stat.size) { throw new Error('Inspection ELF changed while being read.'); }
	return bytes;
}

export function readableElfRangesFromBuffer(bytes: Buffer): AddressRange[] {
	return elfLoadRanges(bytes, 4)
		// Only ELF-declared global RAM / cached program flash / LMU ranges in this first release.
		.map(range => ({ start: Math.max(range.start, 0x30000000), end: Math.min(range.end, 0xa0000000) }))
		.filter(range => range.start < range.end);
}

export function readableElfRanges(program: string): AddressRange[] {
	return readableElfRangesFromBuffer(readInspectionElf(program));
}

export async function readInspectedMemory(
	send: <T>(command: SimpleCommand<T>) => Promise<T>, contextId: string,
	ranges: readonly AddressRange[], raw: unknown, check: () => void,
) {
	const args = memoryReadSchema.parse(raw);
	const address = Number(args.address);
	const end = address + args.count;
	if (end > 0x100000000 || !ranges.some(range => address >= range.start && end <= range.end)) {
		throw new Error('Memory range is outside the readable ELF-backed RAM/flash allowlist. MMIO, aliases and unmapped gaps are not exposed.');
	}
	check();
	const value = await send(new GetMemoryCommand(contextId, address, 1, args.count, 0));
	check();
	if (value.errorAddresses?.length) {
		throw new Error('Memory.get reported unreadable bytes; the entire read is rejected without padding or returning partial data.');
	}
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) {
		throw new Error('Memory.get returned invalid base64.');
	}
	const bytes = Buffer.from(value.base64, 'base64');
	if (bytes.length !== args.count) { throw new Error('Memory.get returned an incomplete or oversized value; no padded data is returned.'); }
	return memoryValueSchema.parse({
		address: `0x${address.toString(16)}`, count: args.count, bytesHex: bytes.toString('hex'),
		encoding: 'raw-bytes', evidence: 'Memory.get',
	});
}
