/* eslint-disable @typescript-eslint/naming-convention -- TCF wire-format property names. */
import * as assert from 'assert';
import { isStepOutReturnStop, StepOutTarget } from '../../stepOutStop';
import { ContextSuspendedData } from '../../tcf/runcontrol';
import { BreakpointStatus } from '../../tcf/breakpoints';

function stop(pc = 100, reason = 'Breakpoint', ids?: string[]): ContextSuspendedData {
	return { id: 'core0', pc, reason, data: ids ? { BPs: ids } : {} };
}

function target(breakpointStatuses: BreakpointStatus[] = []): StepOutTarget {
	return { returnAddress: 100, breakpointStatuses };
}

suite('Step Out return-stop classification (offline)', () => {
	test('recognizes only an anonymous return-address breakpoint for a pending Step Out', () => {
		assert.strictEqual(isStepOutReturnStop(stop(), target()), true);
		assert.strictEqual(isStepOutReturnStop(stop(), undefined), false);
		assert.strictEqual(isStepOutReturnStop(stop(104), target()), false);
		assert.strictEqual(isStepOutReturnStop(stop(100, 'Suspended'), target()), false);
	});

	test('preserves every explicit breakpoint ID, including unknown clients', () => {
		for (const id of ['aurix-1', 'other-client-breakpoint']) {
			assert.strictEqual(isStepOutReturnStop(stop(100, 'Breakpoint', [id]), target()), false);
		}
	});

	test('preserves resolved source and instruction breakpoints at the return address', () => {
		for (const address of [100, '100', '0x64']) {
			assert.strictEqual(isStepOutReturnStop(stop(), target([
				{ Instances: [{ Address: address, LocationContext: 'core0' }] }
			])), false);
		}
	});

	test('unrelated resolved user breakpoints do not hide completion', () => {
		assert.strictEqual(isStepOutReturnStop(stop(), target([
			{ Instances: [{ Address: 200, LocationContext: 'core0' }] }
		])), true);
	});

	test('checks every instance and every configured breakpoint', () => {
		assert.strictEqual(isStepOutReturnStop(stop(), target([
			{ Instances: [{ Address: 200 }] },
			{ Instances: [{ Address: 300 }, { Address: 100 }] }
		])), false);
	});

	test('does not infer completion from an invalid caller address', () => {
		for (const returnAddress of [NaN, Infinity, -1, 100.5]) {
			assert.strictEqual(isStepOutReturnStop(stop(returnAddress), { returnAddress, breakpointStatuses: [] }), false);
		}
	});

	test('preserves the agent reason if any user breakpoint is unresolved or erroneous', () => {
		for (const status of [
			{}, { Instances: [] }, { Error: 'unresolved' },
			{ Instances: [{}] }, { Instances: [{ Address: '' }] },
			{ Instances: [{ Address: 'unknown' }] },
			{ Instances: [{ Address: 200, Error: 'unbound' }] },
			{ Instances: [{ Address: 200, ConditionError: 'invalid expression' }] }
		]) {
			assert.strictEqual(isStepOutReturnStop(stop(), target([status])), false);
		}
	});
});
