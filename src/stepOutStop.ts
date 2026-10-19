import type { BreakpointStatus } from './tcf/breakpoints';
import type { ContextSuspendedData } from './tcf/runcontrol';

export interface StepOutTarget {
	returnAddress: number;
	breakpointStatuses: readonly BreakpointStatus[];
}

export function isStepOutReturnStop(info: ContextSuspendedData, target?: StepOutTarget): boolean {
	if (!target || !Number.isSafeInteger(target.returnAddress) || target.returnAddress < 0 ||
		info.pc !== target.returnAddress || !info.reason?.toLowerCase().includes('breakpoint') ||
		(info.data?.BPs?.length ?? 0) > 0) {
		return false;
	}
	for (const status of target.breakpointStatuses) {
		// An unresolved user breakpoint cannot safely be distinguished from the agent's return trap.
		if (status.Error || !status.Instances?.length) {
			return false;
		}
		for (const instance of status.Instances) {
			const address = typeof instance.Address === 'number' ? instance.Address :
				typeof instance.Address === 'string' && instance.Address.trim() ? Number(instance.Address) : NaN;
			if (instance.Error || instance.ConditionError || !Number.isSafeInteger(address) || address < 0 ||
				address === info.pc) {
				return false;
			}
		}
	}
	return true;
}
