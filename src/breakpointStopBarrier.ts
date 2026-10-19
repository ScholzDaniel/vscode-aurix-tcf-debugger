export interface CoreStopState {
	id: string;
	suspended: boolean;
}

export class BreakpointStopBarrier {
	private generation = 0;
	private readonly pending = new Set<string>();
	private readonly reported = new Set<string>();

	constructor(
		private readonly readStates: () => Promise<CoreStopState[]>,
		private readonly emit: (contextId: string, allStopped: boolean, refocus: boolean) => void,
		private readonly warn: (message: string) => void,
		private readonly timeoutMs = 1000
	) {}

	get version(): number { return this.generation; }
	get waiting(): boolean { return this.pending.size > 0; }

	has(contextId: string): boolean {
		return this.pending.has(contextId) || this.reported.has(contextId);
	}

	invalidate(): void {
		this.generation++;
		this.pending.clear();
		this.reported.clear();
	}

	async notify(contextId: string, expectedContexts: readonly string[], refocus = false): Promise<void> {
		if (this.pending.has(contextId) || (!refocus && this.reported.has(contextId))) {
			return;
		}
		const generation = this.generation;
		const expected = new Set([...expectedContexts, contextId]);
		const deadline = Date.now() + this.timeoutMs;
		this.pending.add(contextId);
		let states: CoreStopState[] = [];
		let failure: string | undefined;
		let allStopped = false;
		try {
			do {
				try {
					states = await this.readStates();
				} catch (error) {
					failure = `state query failed: ${String(error)}`;
					break;
				}
				if (generation !== this.generation) {
					return;
				}
				for (const state of states) {
					expected.add(state.id);
				}
				allStopped = [...expected].every(id => states.some(state => state.id === id && state.suspended));
				if (allStopped || Date.now() >= deadline) {
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 25));
				if (generation !== this.generation) {
					return;
				}
			} while (true);
			if (generation !== this.generation) {
				return;
			}
			if (!allStopped) {
				this.warn(`Cannot confirm all cores suspended for breakpoint on ${contextId}: ${
					failure ?? [...expected].filter(id => !states.some(state => state.id === id && state.suspended)).join(', ')
				}. Not advertising allThreadsStopped.`);
			}
			// A fresh running state supersedes the original breakpoint notification.
			if (!failure && states.some(state => state.id === contextId && !state.suspended)) {
				return;
			}
			this.reported.add(contextId);
			this.emit(contextId, allStopped, refocus);
		} finally {
			if (generation === this.generation) {
				this.pending.delete(contextId);
			}
		}
	}
}
