import { hardwareTest, withDebugSession } from '../debugHarness';
import { positiveInteger } from '../hardwareProfile';

suite('AURIX session stress (hardware)', () => {
	hardwareTest('[ACS 1-12-2] terminate and relaunch with exact entry location', async (profile, context) => {
		const runs = positiveInteger(process.env.AURIX_TEST_RUNS ?? '10', 'AURIX_TEST_RUNS');
		context.timeout(runs * (profile.launchTimeoutMs + 10 * profile.timeoutMs));
		for (let iteration = 1; iteration <= runs; iteration++) {
			await withDebugSession(profile, `ACS-1-12-2-${iteration}`, async session => {
				await session.assertLocation(profile.entry);
			});
		}
	});
});
