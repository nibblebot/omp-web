/**
 * The fake model as a separate, pinned process.
 *
 * In one process the model server, the synthetic client and the sampler share a
 * single JS thread. The server parses every request body (an S3 conversation
 * carries megabytes of tool results) and paces thousands of writes, so it
 * blocked the thread that stamps client receive times: stream latency in the
 * combined scenario read 60 ms p50 while the fleet idled. Run as a child on its
 * own cores, the server can no longer delay the client's clock reads.
 */
import type { FakeModel } from "./fake-model/server";
import type { LagStats } from "./loop-lag";

const MAIN = new URL("./fake-process-main.ts", import.meta.url).pathname;
const SPAWN_TIMEOUT_MS = 15_000;

export interface FakeModelProcess extends FakeModel {
	pid: number;
	/** Event-loop lag of the fake server itself, known after `close`. */
	loopLag: LagStats | undefined;
}

interface Message {
	ready?: boolean;
	url?: string;
	pid?: number;
	flushed?: boolean;
	closed?: boolean;
	loopLag?: LagStats;
}

/** Spawn the fake model under `taskset -c <cpus>` (unpinned when `cpus` is undefined). */
export async function startFakeModelProcess(opts: {
	sendLog: string;
	cpus?: string;
}): Promise<FakeModelProcess> {
	const argv = [
		...(opts.cpus === undefined ? [] : ["taskset", "-c", opts.cpus]),
		process.execPath,
		MAIN,
		opts.sendLog,
	];
	const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	const waiters: Array<{ want: keyof Message; resolve: (m: Message) => void }> = [];
	const seen: Message[] = [];
	const pump = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
				const message: Message = JSON.parse(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				const at = waiters.findIndex((w) => message[w.want] === true);
				if (at >= 0) waiters.splice(at, 1)[0]!.resolve(message);
				else seen.push(message);
			}
		}
	})();
	const next = (want: keyof Message, timeoutMs: number): Promise<Message> => {
		const early = seen.findIndex((m) => m[want] === true);
		if (early >= 0) return Promise.resolve(seen.splice(early, 1)[0]!);
		const { promise, resolve, reject } = Promise.withResolvers<Message>();
		const timer = setTimeout(
			() => reject(new Error(`fake model process: no "${want}" within ${timeoutMs} ms`)),
			timeoutMs,
		);
		waiters.push({
			want,
			resolve: (m) => {
				clearTimeout(timer);
				resolve(m);
			},
		});
		return promise;
	};
	const ready = await next("ready", SPAWN_TIMEOUT_MS);
	if (ready.url === undefined || ready.pid === undefined)
		throw new Error("fake model process: bad ready line");
	let closed = false;
	const model: FakeModelProcess = {
		url: ready.url,
		pid: ready.pid,
		loopLag: undefined,
		async flush() {
			child.stdin.write("flush\n");
			await child.stdin.flush();
			await next("flushed", 30_000);
		},
		async close() {
			if (closed) return;
			closed = true;
			child.stdin.write("close\n");
			await child.stdin.flush();
			try {
				// A child that died already answers with its exit, not a 30 s wait.
				const answer = await Promise.race([
					next("closed", 30_000),
					child.exited.then(() => undefined),
				]);
				model.loopLag = answer?.loopLag;
			} catch {
				child.kill("SIGKILL");
			}
			const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
			await child.exited;
			clearTimeout(killer);
			await pump.catch(() => undefined);
		},
	};
	return model;
}
