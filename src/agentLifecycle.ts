import * as net from 'net';
import type { ChildProcess } from 'child_process';

export function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
	if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) { return Promise.resolve(); }
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timer);
			proc.off('exit', exited);
			proc.off('error', failed);
			if (error) { reject(error); } else { resolve(); }
		};
		const exited = () => finish();
		const failed = (error: Error) => finish(error);
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for TCF agent ${proc.pid} to exit`)), timeoutMs);
		proc.once('exit', exited);
		proc.once('error', failed);
	});
}

export function waitForTcpPortClosed(host: string, port: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let socket: net.Socket | undefined;
		let retryTimer: NodeJS.Timeout | undefined;
		let finished = false;
		const finish = (error?: Error) => {
			if (finished) { return; }
			finished = true;
			clearTimeout(timer);
			if (retryTimer) { clearTimeout(retryTimer); }
			socket?.destroy();
			if (error) { reject(error); } else { resolve(); }
		};
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${host}:${port} to close`)), timeoutMs);
		const tryOnce = () => {
			if (finished) { return; }
			const attempt = new net.Socket();
			socket = attempt;
			let settled = false;
			const retry = () => {
				if (settled || finished) { return; }
				settled = true;
				attempt.destroy();
				retryTimer = setTimeout(tryOnce, 150);
			};
			attempt.setTimeout(500);
			attempt.once('connect', retry);
			attempt.once('timeout', retry);
			attempt.once('error', (error: NodeJS.ErrnoException) => {
				if (settled || finished) { return; }
				settled = true;
				if (error.code === 'ECONNREFUSED') { finish(); }
				else { finish(error); }
			});
			attempt.connect(port, host);
		};
		tryOnce();
	});
}
