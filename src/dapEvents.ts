import type { DebugProtocol } from '@vscode/debugprotocol';

type EventPredicate = (event: DebugProtocol.Event) => boolean;

interface RecordedEvent {
	sequence: number;
	message: DebugProtocol.Event;
}

interface EventWaiter {
	accept: (event: RecordedEvent) => void;
	reject: (error: Error) => void;
}

export class DapEvents {
	private sequence = 0;
	private readonly history: RecordedEvent[] = [];
	private readonly waiters = new Set<EventWaiter>();
	private closed?: Error;

	constructor(private readonly historyLimit = 1000) {}

	mark(): number {
		return this.sequence;
	}

	since(after: number, name: string): DebugProtocol.Event[] {
		return this.history.filter(event => event.sequence > after && event.message.event === name).map(event => event.message);
	}

	get pendingCount(): number {
		return this.waiters.size;
	}

	record(message: DebugProtocol.Event): void {
		if (this.closed) {
			return;
		}
		const event = { sequence: ++this.sequence, message };
		this.history.push(event);
		if (this.history.length > this.historyLimit) {
			this.history.shift();
		}
		for (const waiter of [...this.waiters]) {
			waiter.accept(event);
		}
	}

	waitFor(
		name: string,
		after: number,
		timeoutMs: number,
		predicate: EventPredicate = () => true,
		signal?: AbortSignal
	): Promise<DebugProtocol.Event> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			if (this.closed) {
				reject(this.closed);
				return;
			}
			const matches = (event: RecordedEvent) =>
				event.sequence > after && event.message.event === name && predicate(event.message);
			const existing = this.history.find(matches);
			if (existing) {
				resolve(existing.message);
				return;
			}
			const finish = (error?: Error, event?: DebugProtocol.Event) => {
				clearTimeout(timer);
				this.waiters.delete(waiter);
				signal?.removeEventListener('abort', abort);
				if (error) {
					reject(error);
				} else {
					resolve(event!);
				}
			};
			const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Event wait cancelled'));
			const waiter: EventWaiter = {
				accept: (event) => {
					try {
						if (matches(event)) {
							finish(undefined, event.message);
						}
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				},
				reject: (error) => finish(error)
			};
			const timer = setTimeout(() => finish(new Error(`Timed out waiting for DAP '${name}' after ${timeoutMs}ms`)), timeoutMs);
			this.waiters.add(waiter);
			signal?.addEventListener('abort', abort, { once: true });
		});
	}

	close(error = new Error('Debug session ended')): void {
		this.closed = error;
		for (const waiter of [...this.waiters]) {
			waiter.reject(error);
		}
		this.history.length = 0;
	}
}