import { isMainThread, parentPort, workerData, Worker } from 'worker_threads';
import { z } from 'zod';
import { extractSvdRegisterCatalog, readSvdFile } from './svdRegisterCatalog';

const requestSchema = z.object({ kind: z.literal('aurix-svd-validation'), filename: z.string().min(1).max(4096) }).strict();
const resultSchema = z.object({ device: z.string().min(1).max(256), registerCount: z.number().int().positive() }).strict();
const messageSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('stage'), stage: z.enum(['svd-read', 'svd-parse']) }).strict(),
	z.object({ kind: z.literal('result'), result: resultSchema }).strict(),
	z.object({ kind: z.literal('error'), message: z.string().max(4096) }).strict(),
]);
export type SvdValidation = z.infer<typeof resultSchema>;
export type SvdValidationStage = 'svd-read' | 'svd-parse';

export async function validateSvdInWorker(filename: string, signal: AbortSignal,
	onStage: (stage: SvdValidationStage) => void = () => {}): Promise<SvdValidation> {
	signal.throwIfAborted();
	const request = requestSchema.parse({ kind: 'aurix-svd-validation', filename });
	return new Promise((resolve, reject) => {
		const worker = new Worker(__filename, { workerData: request });
		let result: SvdValidation | undefined;
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			void worker.terminate().catch(termination => {
				failure = new Error(`${failure?.message}; SVD worker termination failed: ${String(termination)}`);
			});
		};
		const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('SVD validation cancelled.'));
		worker.on('message', (raw: unknown) => {
			if (failure) { return; }
			try {
				const message = messageSchema.parse(raw);
				if (message.kind === 'stage') { onStage(message.stage); }
				else if (message.kind === 'error') { stop(new Error(message.message)); }
				else if (result) { stop(new Error('SVD worker returned more than one result.')); }
				else { result = message.result; }
			} catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
		});
		worker.on('error', error => { failure ??= error; });
		worker.on('exit', code => {
			signal.removeEventListener('abort', abort);
			if (failure) { reject(failure); }
			else if (code !== 0 || !result) { reject(new Error(`SVD validation worker exited without a result (code ${code}).`)); }
			else { resolve(result); }
		});
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) { abort(); }
	});
}

if (!isMainThread && parentPort && requestSchema.safeParse(workerData).success) {
	const port = parentPort;
	void (async () => {
		try {
			const input: unknown = workerData;
			const { filename } = requestSchema.parse(input);
			port.postMessage({ kind: 'stage', stage: 'svd-read' });
			const content = await readSvdFile(filename);
			port.postMessage({ kind: 'stage', stage: 'svd-parse' });
			const catalog = extractSvdRegisterCatalog(content);
			if (!catalog.registers.length) { throw new Error('Matched SVD contains no register definitions.'); }
			port.postMessage({ kind: 'result', result: resultSchema.parse({ device: catalog.device, registerCount: catalog.registers.length }) });
		} catch (error) {
			port.postMessage({ kind: 'error', message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) });
		} finally { port.close(); }
	})();
}
