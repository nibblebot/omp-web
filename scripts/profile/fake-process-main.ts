/**
 * Child entry: the fake model in its own process (see fake-process.ts for why).
 * Protocol on stdio, one line each way:
 *   stdout `{"ready":true,"url":...,"pid":...}` once listening;
 *   stdin  `flush` -> stdout `flushed`; stdin `close` -> stdout `closed`, exit 0.
 * argv: <sendLog path>
 */
import { startFakeModel } from "./fake-model/server";
import { LoopLagProbe } from "./loop-lag";

const sendLog = process.argv[2];
if (sendLog === undefined) throw new Error("usage: fake-process-main.ts <sendLog>");

const fake = await startFakeModel({ sendLog, hostname: "127.0.0.1" });
const lag = new LoopLagProbe();
lag.start();
const say = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};
say({ ready: true, url: fake.url, pid: process.pid });

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (line === "flush") {
			await fake.flush();
			say({ flushed: true });
		} else if (line === "close") {
			const stats = lag.stop();
			await fake.close();
			say({ closed: true, loopLag: stats });
			process.exit(0);
		}
	}
}
// stdin closed without `close`: the parent died; do not linger.
await fake.close();
process.exit(0);
