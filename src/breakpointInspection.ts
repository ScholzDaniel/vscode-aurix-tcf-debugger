import { z } from 'zod';
import { GetStatusBreakpointsCommand } from './tcf/breakpoints';
import { MapToSourceLineNumbersCommand, TCFCodeAreaLineNumbers } from './tcf/linenumbers';
import { SimpleCommand } from './tcf/tcfutils';

const text = z.string().max(4096);
const addressText = z.string().regex(/^0x[0-9a-f]{1,8}$/);
const sourceLocation = z.object({
	source: text, line: z.number().int().positive(), column: z.number().int().nonnegative().optional(),
});
const instanceSchema = z.object({
	locationContext: text.optional(), memoryContext: text.optional(), breakpointType: text.optional(),
	reportedAddress: z.union([z.number(), z.string().max(128)]).optional(),
	address: addressText.optional(),
	reportedHitCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	error: text.optional(), conditionError: text.optional(),
	installation: z.enum(['installed', 'unresolved', 'error']),
	sourceStatus: z.enum(['mapped', 'unavailable', 'error']),
	sourceError: text.optional(),
	sources: z.array(sourceLocation).max(8),
});

export const breakpointEvidenceSchema = z.object({
	nativeId: text,
	evidence: z.literal('Breakpoints.getStatus'),
	resolution: z.enum(['resolved', 'partial', 'unresolved', 'error']),
	error: text.optional(),
	agentLocation: z.object({
		file: text.optional(), line: z.number().int().positive().optional(),
		column: z.number().int().nonnegative().optional(),
	}),
	instances: z.array(instanceSchema).max(32),
});

export function targetAddress(value: number | string | undefined): number | undefined {
	if (typeof value === 'string' && !/^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value)) { return undefined; }
	const number = typeof value === 'string' ? Number(value) : value;
	return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : undefined;
}

export class BreakpointInspector {
	constructor(private readonly send: <T>(command: SimpleCommand<T>) => Promise<T>,
		private readonly sourcePath: (area: TCFCodeAreaLineNumbers) => string | undefined) {}

	async read(nativeId: string, check: () => void): Promise<z.infer<typeof breakpointEvidenceSchema>> {
		check();
		const status = await this.send(new GetStatusBreakpointsCommand(nativeId));
		check();
		if ((status.Instances?.length ?? 0) > 32) { throw new Error('Breakpoint status exceeds the 32-instance limit.'); }
		const instances: z.infer<typeof instanceSchema>[] = [];
		for (const instance of status.Instances ?? []) {
			check();
			const address = targetAddress(instance.Address);
			const failed = status.Error !== undefined || instance.Error !== undefined || instance.ConditionError !== undefined;
			const result: z.infer<typeof instanceSchema> = {
				locationContext: instance.LocationContext, memoryContext: instance.MemoryContext,
				breakpointType: instance.BreakpointType, reportedAddress: instance.Address,
				address: address === undefined ? undefined : `0x${address.toString(16)}`,
				reportedHitCount: instance.HitCount, error: instance.Error, conditionError: instance.ConditionError,
				installation: failed ? 'error' : address === undefined ? 'unresolved' : 'installed',
				sourceStatus: 'unavailable', sources: [],
			};
			if (failed) {
				result.sourceError = 'Installation or condition error; no resolved source is claimed.';
			} else if (address === undefined) {
				result.sourceError = 'Missing or invalid 32-bit instance address; it was not rounded or truncated.';
			} else {
				const context = instance.LocationContext || instance.MemoryContext;
				if (!context) {
					result.sourceError = 'Agent did not report a context for address-to-source lookup.';
				} else {
					let areas: TCFCodeAreaLineNumbers[] | null = null;
					try { areas = await this.send(new MapToSourceLineNumbersCommand(context, address, address + 1)); }
					catch (error) {
						check();
						result.sourceStatus = 'error';
						result.sourceError = `LineNumbers.mapToSource failed: ${error instanceof Error ? error.message : String(error)}`;
					}
					check();
					if ((areas?.length ?? 0) > 64) { throw new Error('Breakpoint source mapping exceeds the 64-area limit.'); }
					for (const area of areas ?? []) {
						// A returned line alone is not evidence that it covers the installed address.
						if (area.SAddr === undefined || area.EAddr === undefined ||
							!Number.isSafeInteger(area.SAddr) || !Number.isSafeInteger(area.EAddr) ||
							area.SAddr < 0 || area.EAddr > 0x100000000 ||
							area.SAddr > address || area.EAddr <= address || !area.SLine) { continue; }
						const source = this.sourcePath(area);
						if (source) { result.sources.push({ source, line: area.SLine, column: area.SCol }); }
					}
					if (result.sources.length) { result.sourceStatus = 'mapped'; }
					else if (result.sourceStatus !== 'error') {
						result.sourceError = 'No source area covering the installed address was returned.';
					}
				}
			}
			instances.push(result);
		}
		const installed = instances.filter(instance => instance.installation === 'installed').length;
		const errors = status.Error !== undefined || instances.some(instance => instance.installation === 'error');
		check();
		return breakpointEvidenceSchema.parse({
			nativeId, evidence: 'Breakpoints.getStatus',
			resolution: status.Error !== undefined ? 'error' :
				installed === instances.length && installed > 0 ? 'resolved' :
					installed > 0 ? 'partial' : errors ? 'error' : 'unresolved',
			error: status.Error,
			agentLocation: { file: status.File, line: status.Line, column: status.Column },
			instances,
		});
	}
}
