export const flashingUnavailableMessage =
	'Integrated flashing is unavailable: the bundled AURIX Flasher has been removed. ' +
	'Flash the matching firmware externally and disable enableFlashing, ppuFlashHex and cdspFlashHex. ' +
	'A replacement flasher with Windows/Linux support is planned but not yet available.';

export function validateFlashingOptions(config: Readonly<Record<string, unknown>>): void {
	if (config.enableFlashing === true || config.ppuFlashHex === true || config.cdspFlashHex === true) {
		throw new Error(flashingUnavailableMessage);
	}
}
