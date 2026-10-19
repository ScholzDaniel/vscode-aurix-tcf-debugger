import { hardwareTest, withDebugSession } from '../debugHarness';

suite('AURIX breakpoint vs stop-at-function (hardware)', () => {
	hardwareTest('[ACS 1-0-6] enabled pre-launch breakpoint wins over entry function', async profile => {
		await withDebugSession(profile, 'ACS-1-0-6', async session => {
			await session.assertLocation(profile.beforeEntry);
		}, {
			startupPoint: profile.beforeEntry,
			breakpoint: { point: profile.beforeEntry, enabled: true }
		});
	});

	hardwareTest('[ACS 1-0-7] disabled pre-launch breakpoint does not intercept entry', async profile => {
		await withDebugSession(profile, 'ACS-1-0-7', async session => {
			await session.assertLocation(profile.entry);
		}, { breakpoint: { point: profile.beforeEntry, enabled: false } });
	});
});
