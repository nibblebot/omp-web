/**
 * S1: large-history attach. A session resumed from a generated multi-megabyte
 * transcript is attached repeatedly by fresh browser connections; each attach
 * primes the whole history over H1 (fleet <- session over H2 first).
 *
 * Two variants share this code:
 * - `s1-history`: a sub-threshold fixture. The edge must never end an attach
 *   mid-priming here; a rep with any dropped attach is FAILED (kept in the
 *   summary, excluded from every aggregate, counted).
 * - `s1-history-large`: a fixture past the edge's backpressure cap. Drops are
 *   the point: the primary metric is the drop rate. Timings cover completed
 *   attaches only, so they are biased toward the lucky ones and labeled so.
 */
import { join } from "node:path";
import { DownlinkEnded, ProfileClient, type AttachTimings } from "../client";
import {
	ensureHistoryFixture,
	type HistoryShape,
	LARGE_HISTORY,
	materializeHistory,
	SUB_THRESHOLD_HISTORY,
} from "../fixture";
import { metric, type MetricReading } from "../types";
import { frameBreakdown, medianOf, reconnectMetrics } from "./common";
import type { RepOutcome, RunEnv, Scenario } from "./env";

interface Variant {
	id: string;
	title: string;
	shape: HistoryShape;
	/** Sub-threshold: any drop fails the rep. Otherwise drops are measured, not failures. */
	failOnDrop: boolean;
	/** Prefix of the timing metrics (`attach.` or `attach.completed.`). */
	prefix: string;
	describe: (wireMiB: string) => string;
}

const MIB = 1024 * 1024;
/** Approximate wire bytes of one history round of the fixture (measured: 9.37 MB / 800 rounds). */
const WIRE_BYTES_PER_ROUND = 11_700;

function wireMiB(shape: HistoryShape): string {
	return ((shape.turns * WIRE_BYTES_PER_ROUND) / MIB).toFixed(1);
}

/** A rep attaches at least this many times and keeps going until CPU ticks mean something. */
const MIN_ATTACHES_FULL = 30;
const MIN_ATTACHES_QUICK = 30;
const MIN_WINDOW_FULL_MS = 5000;
const MIN_WINDOW_QUICK_MS = 2000;
/** The large variant makes a fixed number of attempts: most drop at once, so a time window would not end. */
const LARGE_ATTEMPTS_FULL = 30;
const LARGE_ATTEMPTS_QUICK = 12;
/** An attach that neither primes nor ends within this long means the stack is hung, not dropping. */
const ATTACH_TIMEOUT_MS = 20_000;

function build(variant: Variant): Scenario {
	return {
		id: variant.id,
		title: variant.title,
		description: variant.describe(wireMiB(variant.shape)),
		async start(env: RunEnv) {
			const repo = await env.newRepo(variant.id);
			const { stack } = env;
			const handle = await stack.addSession({ label: "s1", slot: 0 }, repo, { start: false });
			const fixture = ensureHistoryFixture(join(env.outRoot, "fixtures"), variant.shape);
			const sessionFile = await materializeHistory(fixture, stack.sessionDirFor(repo), repo);
			const bootstrap = await ProfileClient.connect(env.adapter, stack.baseUrl);
			await bootstrap.send({
				type: "spawn_resume",
				id: crypto.randomUUID(),
				daemonId: handle.daemonId,
				sessionFile,
			});
			await stack.waitReady(handle, 120_000);
			await bootstrap.close();
			let last: ProfileClient | undefined;
			return {
				async rep(): Promise<RepOutcome> {
					const notes: string[] = [];
					const affinity = await env.verify([handle]);
					await last?.close();
					last = undefined;
					const clients: ProfileClient[] = [];
					const timings: AttachTimings[] = [];
					const window = await env.window(clients);
					const startedAt = performance.now();
					let drops = 0;
					let attempts = 0;
					const more = (): boolean =>
						variant.failOnDrop
							? timings.length + drops < (env.quick ? MIN_ATTACHES_QUICK : MIN_ATTACHES_FULL) ||
								performance.now() - startedAt <
									(env.quick ? MIN_WINDOW_QUICK_MS : MIN_WINDOW_FULL_MS)
							: attempts < (env.quick ? LARGE_ATTEMPTS_QUICK : LARGE_ATTEMPTS_FULL);
					while (more()) {
						await last?.close();
						const client = await ProfileClient.connect(env.adapter, stack.baseUrl, {
							resilient: false,
						});
						clients.push(client);
						last = client;
						attempts++;
						try {
							timings.push(await client.attach(handle.daemonId, handle.label, ATTACH_TIMEOUT_MS));
						} catch (err) {
							// The edge ended the browser stream mid-priming (backpressure drop-and-resume).
							if (!(err instanceof DownlinkEnded)) throw err;
							drops++;
						}
					}
					const closed = await window.close();
					const metrics: Record<string, MetricReading> = { ...closed.metrics };
					const dropRate = drops / attempts;
					metrics["attach.attempts"] = metric(attempts, "count", "info");
					metrics["attach.drops"] = metric(drops, "count", "lower");
					metrics["attach.drop-rate"] = metric(dropRate, "ratio", "lower");
					const pick = (f: (t: AttachTimings) => number): number[] => timings.map(f);
					const p = variant.prefix;
					if (timings.length > 0) {
						metrics[`${p}ttff.ms`] = metric(
							medianOf(pick((t) => t.ttffMs)),
							"ms",
							"lower",
							"clock-monotonic-ffi",
						);
						metrics[`${p}history.ms`] = metric(
							medianOf(pick((t) => t.historyMs)),
							"ms",
							"lower",
							"clock-monotonic-ffi",
						);
						metrics[`${p}primed.ms`] = metric(
							medianOf(pick((t) => t.primedMs)),
							"ms",
							"lower",
							"clock-monotonic-ffi",
						);
						metrics[`${p}primed.max.ms`] = metric(
							Math.max(...pick((t) => t.primedMs)),
							"ms",
							"lower",
							"clock-monotonic-ffi",
						);
						metrics[`${p}accept.ms`] = metric(
							medianOf(pick((t) => t.acceptMs)),
							"ms",
							"lower",
							"clock-monotonic-ffi",
						);
						metrics["attach.history.bytes"] = metric(
							Math.min(...pick((t) => t.historyBytes)),
							"bytes",
							"info",
						);
						metrics["attach.history.frames"] = metric(
							Math.min(...pick((t) => t.historyFrames)),
							"count",
							"info",
						);
						metrics["attach.priming.frames"] = metric(
							Math.min(...pick((t) => t.primingFrames)),
							"count",
							"info",
						);
						const reprimed = timings.filter((t) => t.attachedFrames > 1).length;
						metrics["attach.reprimed"] = metric(reprimed, "count", "lower");
						metrics["attach.reprime-rate"] = metric(reprimed / timings.length, "ratio", "lower");
						notes.push(
							`${timings.length} attaches completed; ${reprimed} were re-primed mid-attach (a second \`attached\` after a stream_reset), which adds a whole second history to that attach's time and bytes`,
						);
						notes.push(
							`first primed ${timings[0]?.primedMs.toFixed(0)} ms, last ${timings.at(-1)?.primedMs.toFixed(0)} ms; history bytes and frame counts are the minimum over attaches (a re-prime doubles them)`,
						);
					}
					notes.push(
						`${drops} of ${attempts} attach attempts (${(dropRate * 100).toFixed(1)}%) ended by the edge mid-priming (browser stream dropped at the 4 MiB backpressure cap)`,
					);
					let failed: string | undefined;
					const reprimedCount = timings.filter((t) => t.attachedFrames > 1).length;
					if (variant.failOnDrop && (drops > 0 || reprimedCount > 0)) {
						failed =
							`${drops} of ${attempts} attaches were dropped and ${reprimedCount} re-primed by the edge mid-priming on a fixture that must not do either ` +
							`(~${wireMiB(variant.shape)} MiB, ${variant.shape.turns} rounds): the rep is invalid`;
					} else if (timings.length === 0) {
						notes.push("every attach was dropped: no timing metrics this rep");
					} else if (!variant.failOnDrop) {
						notes.push(
							"timings cover COMPLETED attaches only (biased: attaches that were dropped are missing from them); the drop rate is the primary metric",
						);
					}
					const target = last;
					if (target !== undefined && drops === 0) {
						try {
							Object.assign(
								metrics,
								reconnectMetrics(await target.reconnect(handle.daemonId, handle.label)),
							);
						} catch (err) {
							if (!(err instanceof DownlinkEnded)) throw err;
							notes.push(
								"reconnect re-attach was dropped by the edge mid-priming (no reconnect.* metrics this rep)",
							);
						}
						notes.push(frameBreakdown(target.byType));
					}
					return { metrics, notes, affinity, ...(failed !== undefined ? { failed } : {}) };
				},
				async close() {
					await last?.close();
					await stack.removeSession(handle);
				},
			};
		},
	};
}

export const s1History: Scenario = build({
	id: "s1-history",
	title: "S1 large-history attach (sub-threshold fixture)",
	shape: SUB_THRESHOLD_HISTORY,
	failOnDrop: true,
	prefix: "attach.",
	describe: (mib) =>
		`A session (pin slot 0, route s1) is resumed from a generated transcript of ${SUB_THRESHOLD_HISTORY.turns} rounds ` +
		`(user, assistant+bash call, ${SUB_THRESHOLD_HISTORY.toolOutputBytes} B tool result, assistant), about ${mib} MiB on the wire, cached under ` +
		".profile-out/fixtures. This fixture is SUB-THRESHOLD: it stays under the size at which the edge ends a browser stream mid-priming " +
		"(4 MiB CLIENT_BACKPRESSURE_BYTES cap plus kernel socket buffers; measured: 150 to 350 rounds never dropped or re-primed over thousands of rapid attaches, " +
		"400 rounds already does; see s1-history-large), so the timings are for complete, undropped, single-priming attaches. " +
		"A rep in which any attach is dropped or re-primed mid-attach is marked FAILED and excluded from every aggregate (counted in the summary). " +
		"Each rep opens fresh browser connections and attaches repeatedly (at least 30 attempts and 2 s in quick mode, 5 s otherwise), timing from the attach " +
		"POST to the attached frame (TTFF), the last history chunk, and the end of the priming group; CPU and byte counters cover all attaches. " +
		"One extra drop + Last-Event-ID reconnect + re-attach per rep gives reconnect.* metrics.",
});

export const s1HistoryLarge: Scenario = build({
	id: "s1-history-large",
	title: "S1 large-history attach (past the drop threshold)",
	shape: LARGE_HISTORY,
	failOnDrop: false,
	prefix: "attach.completed.",
	describe: (mib) =>
		`Same shape as s1-history with a fixture of ${LARGE_HISTORY.turns} rounds, about ${mib} MiB on the wire, which is PAST the size at which ` +
		"the edge ends a browser stream mid-priming (4 MiB CLIENT_BACKPRESSURE_BYTES drop-and-resume cap plus the kernel socket buffers; a stalled client is cut at about 8 MiB, " +
		"and the harness's JSON-parsing client drops roughly 14% of attaches at 8.9 MiB and nearly all at 23 MiB). " +
		"The primary metric is attach.drop-rate (dropped attaches / attempts, over a fixed number of attempts per rep). " +
		"attach.completed.* timings cover COMPLETED attaches only and are therefore BIASED toward attaches that were not dropped; " +
		"read them next to the drop rate, never alone.",
});
