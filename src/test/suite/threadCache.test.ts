import * as assert from 'assert';
import { SmallCommandStamper } from '../../tcf';
import { TCFClient } from '../../tcfclient';
import { SimpleCommand } from '../../tcf/tcfutils';

class ThreadClient extends TCFClient {
	suspended = true;
	stateReads = 0;
	beforeStateReply?: () => Promise<void>;

	constructor() {
		super({
			sent: () => undefined, received: () => undefined, log: () => undefined,
			stdout: () => undefined, error: message => { throw new Error(message); }
		}, new SmallCommandStamper());
	}

	override async loadRunControlChildren(): Promise<string[]> {
		return ['core0'];
	}

	override async sendCommand<T>(command: SimpleCommand<T>): Promise<T> {
		if (command.command() === 'getContext') {
			return command.resultPromise([Buffer.alloc(0), Buffer.from('{"ID":"core0","HasState":true}')]);
		}
		if (command.command() === 'getState') {
			this.stateReads++;
			const suspended = this.suspended;
			await this.beforeStateReply?.();
			return command.resultPromise([
				Buffer.alloc(0), ...[suspended, 0, null, null].map(value => Buffer.from(JSON.stringify(value)))
			]);
		}
		throw new Error(`Unexpected command: ${command.command()}`);
	}

	resumed(): void {
		this.suspended = false;
		this.onRunControlEvent('contextResumed', [Buffer.from('"core0"')]);
	}

	protected onBreakpoint(): void { throw new Error('Unexpected breakpoint'); }
	protected onBreakpointRemoved(): void { throw new Error('Unexpected breakpoint removal'); }
	protected onBreakpointAdded(): void { throw new Error('Unexpected breakpoint addition'); }
	protected onBreakpointChanged(): void { throw new Error('Unexpected breakpoint change'); }
}

suite('TCF thread state cache (offline)', () => {
	test('caches unchanged state but invalidates it before delivering resume events', async () => {
		const client = new ThreadClient();
		assert.strictEqual((await client.getThreads())[0].state.suspended, true);
		await client.getThreads();
		assert.strictEqual(client.stateReads, 1);
		client.resumed();
		assert.strictEqual((await client.getThreads())[0].state.suspended, false);
		assert.strictEqual(client.stateReads, 2);
	});

	test('explicit refresh verifies state even without a RunControl event', async () => {
		const client = new ThreadClient();
		await client.getThreads();
		client.suspended = false;
		assert.strictEqual((await client.getThreads(true))[0].state.suspended, false);
	});

	test('an in-flight snapshot cannot overwrite state invalidated by resume', async () => {
		const client = new ThreadClient();
		let release!: () => void;
		let started!: () => void;
		const fetching = new Promise<void>(resolve => { started = resolve; });
		client.beforeStateReply = () => new Promise<void>(resolve => {
			release = resolve;
			started();
		});
		const oldRead = client.getThreads();
		await fetching;
		const sharedRead = client.getThreads();
		client.resumed();
		client.beforeStateReply = undefined;
		assert.strictEqual((await client.getThreads())[0].state.suspended, false);
		release();
		assert.strictEqual((await oldRead)[0].state.suspended, false);
		assert.strictEqual((await sharedRead)[0].state.suspended, false);
		assert.strictEqual((await client.getThreads())[0].state.suspended, false);
		assert.strictEqual(client.stateReads, 2);
	});
});
