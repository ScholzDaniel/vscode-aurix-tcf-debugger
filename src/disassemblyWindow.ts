import type { DebugProtocol } from '@vscode/debugprotocol';
import type { DisassemblyLine } from './tcf/disassembly';

export function disassemblyWindow(
	lines: readonly DisassemblyLine[],
	baseAddress: number,
	instructionOffset: number,
	instructionCount: number
): DebugProtocol.DisassembledInstruction[] {
	if (!Number.isSafeInteger(baseAddress) || !Number.isSafeInteger(instructionOffset) ||
		!Number.isSafeInteger(instructionCount) || instructionCount < 0) {
		throw new Error('Invalid disassembly window');
	}
	const baseIndex = lines.findIndex(line => line.Address === baseAddress);
	const result: DebugProtocol.DisassembledInstruction[] = [];
	for (let position = 0; position < instructionCount; position++) {
		const index = baseIndex + instructionOffset + position;
		const line = baseIndex >= 0 && index >= 0 ? lines[index] : undefined;
		if (line) {
			const bytes = line.OpcodeValue ? Buffer.from(line.OpcodeValue, 'base64') : undefined;
			const instruction = (line.Instruction ?? []).map(part => part.Text).join('');
			result.push({
				address: `0x${line.Address.toString(16)}`,
				instruction: instruction || '<not decoded>',
				instructionBytes: bytes?.length ? Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ') : undefined,
				...(instruction ? {} : { presentationHint: 'invalid' as const })
			});
			continue;
		}
		// Unknown boundaries use TriCore's minimum instruction width for invalid display slots only.
		let address = baseAddress + (instructionOffset + position) * 2;
		if (baseIndex >= 0 && index < 0) {
			address = lines[0].Address + index * 2;
		} else if (baseIndex >= 0 && index >= lines.length) {
			const last = lines[lines.length - 1];
			if (!Number.isSafeInteger(last.Size) || last.Size <= 0) {
				throw new Error('Invalid decoded instruction size');
			}
			address = last.Address + last.Size + (index - lines.length) * 2;
		}
		if (!Number.isSafeInteger(address)) {
			throw new Error('Disassembly window address exceeds supported precision');
		}
		result.push({
			address: address < 0 ? String(address) : `0x${address.toString(16)}`,
			instruction: '<not decoded>',
			presentationHint: 'invalid'
		});
	}
	return result;
}
