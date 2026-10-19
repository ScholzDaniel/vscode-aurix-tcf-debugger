import * as assert from 'assert';
import { flashingUnavailableMessage, validateFlashingOptions } from '../../flashing';

suite('Removed bundled Flasher (offline)', () => {
	test('allows debug-only configurations without modifying them', () => {
		for (const config of [{}, { enableFlashing: false, ppuFlashHex: false, cdspFlashHex: false }]) {
			const before = { ...config };
			assert.doesNotThrow(() => validateFlashingOptions(config));
			assert.deepStrictEqual(config, before);
		}
	});

	test('rejects every enabled legacy flashing combination', () => {
		for (let mask = 1; mask < 8; mask++) {
			assert.throws(() => validateFlashingOptions({
				enableFlashing: Boolean(mask & 1),
				ppuFlashHex: Boolean(mask & 2),
				cdspFlashHex: Boolean(mask & 4)
			}), { message: flashingUnavailableMessage });
		}
	});
});
