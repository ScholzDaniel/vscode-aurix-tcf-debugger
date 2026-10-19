import * as assert from 'assert';
import { AbstractTCFClient, SmallCommandStamper } from '../tcf';
import { GetStateRunControlCommand } from '../tcf/runcontrol';
import { SimpleCommand } from '../tcf/tcfutils';
import { DebugHarness } from './debugHarness';

export class StateObserver extends AbstractTCFClient {
	private readonly errors: string[];

	constructor(private readonly session: DebugHarness) {
		const errors: string[] = [];
		const log = (message: string) => session.recordEvidence('observer-wire', message);
		super({
			sent: log, received: log, log, stdout: log,
			error: message => { errors.push(message); log(message); }
		}, new SmallCommandStamper());
		this.errors = errors;
		this.setCommandTimeout(session.profile.timeoutMs);
	}

	protected onEvent(service: string, event: string, data: Buffer[]): void {
		this.session.recordEvidence('observer-event', { service, event, data: data.map(value => value.toString()) });
	}

	override sendCommand<T>(command: SimpleCommand<T>): Promise<T> {
		assert.ok(
			(command.service() === 'RunControl' && ['getChildren', 'getContext', 'getState'].includes(command.command())) ||
			(command.service() === 'ContextQuery' && command.command() === 'query'),
			`Read-only observer must not send ${command.service()}.${command.command()}`
		);
		return super.sendCommand(command);
	}

	async snapshot(label: string) {
		assert.deepStrictEqual(this.errors, [], 'Native observer reported an error');
		const contexts = this.session.profile.threadPatterns.map(pattern => {
			const matches = Object.values(this.contextInfo).filter(info =>
				info.HasState && new RegExp(pattern, 'i').test(info.Name || info.ID));
			assert.strictEqual(matches.length, 1, `Expected one native core matching ${pattern}`);
			return matches[0];
		});
		assert.strictEqual(new Set(contexts.map(info => info.ID)).size, contexts.length, 'Native core mapping is ambiguous');
		const states = await Promise.all(contexts.map(async info => ({
			context: info.ID, name: info.Name, state: await this.sendCommand(new GetStateRunControlCommand(info.ID))
		})));
		this.session.recordEvidence(label, states);
		assert.deepStrictEqual(this.errors, [], 'Native observer reported an error');
		return states;
	}
}
