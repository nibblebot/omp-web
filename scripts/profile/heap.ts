/**
 * Opt-in end-of-rep JS heap measurement of the fleet and the session processes
 * without touching production code: the process is started with Bun's
 * inspector (`--inspect=127.0.0.1:<port>/heap`) and the harness speaks the
 * WebKit inspector protocol over a WebSocket after the rep.
 *
 * Verified on Bun 1.4.2:
 * - `--inspect=host:port/<path>` serves `ws://host:port/<path>` only; without
 *   a path Bun invents a random UUID path and prints it to stderr, which a
 *   harness cannot read for session processes. A fixed path makes the endpoint
 *   predictable (`/` and other paths are refused).
 * - Supported: `Heap.gc` (full collection, works without `Heap.enable`) and
 *   `Runtime.evaluate` (sync expressions; `awaitPromise` is ignored, and
 *   `require` is undefined, so the bun:jsc module is reached through
 *   `process.getBuiltinModule("bun:jsc")`). `Heap.snapshot` works too but
 *   takes ~1 s for a 15 MB heap and returns hundreds of MB for a real
 *   session, so it is not used.
 * - NOT supported: `Runtime.getHeapUsage`, the `Memory` domain, `Console.getLoadedHeapSize`.
 * - So the reading is: `Heap.gc`, then evaluate `heapStats()` of bun:jsc in the
 *   target. `usedBytes` = `heapSize` (live + not yet swept JSC heap bytes after
 *   the forced collection), `totalBytes` = `heapCapacity`, `externalBytes` =
 *   `extraMemorySize` (typed arrays, strings and other off-heap owned memory).
 *
 * PERTURBATION (measured: 40k JSON round trips pinned to one E-core, median
 * of 6 runs): plain 268 ms, `--inspect` unconnected 270 ms (noise), inspector
 * connected + `Heap.enable` 280 ms (+4%). Memory: +~5 MB RSS for the inspector
 * thread and endpoint, +~0.1 MB JS heap once connected. `readHeap` connects
 * only after the rep, so the connected-state cost never lands in a measured
 * window; the unconnected `--inspect` cost (~5 MB RSS) is in every rep of
 * every process started with these flags. The forced full GC pauses the
 * target (tens to hundreds of ms on a real session). Reps run with
 * `inspectFlags` MUST be labelled as heap-instrumented (`HEAP_RUN_LABEL`) and
 * their RSS, latency and CPU numbers are not comparable to uninstrumented reps.
 */

/** Endpoint path every instrumented process serves. */
const INSPECT_PATH = "heap";
const READ_TIMEOUT_MS = 5_000;

/** Label for reps / summaries produced with `inspectFlags` active. */
export const HEAP_RUN_LABEL = "inspect-heap";

export interface HeapReading {
	/** JSC `heapSize` after a forced full GC (or without it when `gcForced` is false). */
	usedBytes: number;
	/** JSC `heapCapacity`. */
	totalBytes: number;
	/** JSC `extraMemorySize`: owned memory outside the JS heap (buffers, string bodies). */
	externalBytes: number;
	/** `Heap.gc` answered without error before the reading. */
	gcForced: boolean;
}

/** `bun` argv fragment: start the inspector on `127.0.0.1:<port>`, path fixed so `readHeap(port)` can find it. */
export function inspectFlags(port: number): string[] {
	return [`--inspect=127.0.0.1:${port}/${INSPECT_PATH}`];
}

/** A currently free loopback port (probe-and-release; a rare race remains until the process binds it). */
export async function pickInspectPort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port;
	await probe.stop(true);
	if (port === undefined) throw new Error("no free port");
	return port;
}

/** Expression evaluated in the target; returns a JSON string (`returnByValue` of a bare object is empty for bun:jsc results). */
const HEAP_EXPRESSION =
	'(() => { const s = process.getBuiltinModule("bun:jsc").heapStats(); return JSON.stringify({ heapSize: s.heapSize, heapCapacity: s.heapCapacity, extra: s.extraMemorySize }); })()';

interface InspectorReply {
	id: number;
	error?: { message?: unknown };
	result?: unknown;
}

function isReply(v: unknown): v is InspectorReply {
	return typeof v === "object" && v !== null && "id" in v && typeof v.id === "number";
}

function evaluatedString(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || !("result" in result)) return undefined;
	const inner = result.result;
	if (typeof inner !== "object" || inner === null || !("value" in inner)) return undefined;
	return typeof inner.value === "string" ? inner.value : undefined;
}

function parseHeapStats(
	text: string,
): { heapSize: number; heapCapacity: number; extra: number } | undefined {
	const parsed: unknown = JSON.parse(text);
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"heapSize" in parsed &&
		typeof parsed.heapSize === "number" &&
		"heapCapacity" in parsed &&
		typeof parsed.heapCapacity === "number" &&
		"extra" in parsed &&
		typeof parsed.extra === "number"
	) {
		return { heapSize: parsed.heapSize, heapCapacity: parsed.heapCapacity, extra: parsed.extra };
	}
	return undefined;
}

/**
 * Force a GC in the process listening on `127.0.0.1:<port>` (started with
 * `inspectFlags(port)`) and read its JS heap. Never throws: any failure
 * (refused, timeout, unexpected reply) returns `undefined` and appends the
 * reason to `notes`.
 */
export async function readHeap(
	port: number,
	notes: string[] = [],
): Promise<HeapReading | undefined> {
	const url = `ws://127.0.0.1:${port}/${INSPECT_PATH}`;
	let ws: WebSocket | undefined;
	try {
		const opened = Promise.withResolvers<void>();
		const socket = new WebSocket(url);
		ws = socket;
		socket.onopen = () => opened.resolve();
		socket.onerror = () => opened.reject(new Error("connection failed"));
		const pending = new Map<number, PromiseWithResolvers<InspectorReply>>();
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			try {
				const reply: unknown = JSON.parse(event.data);
				if (isReply(reply)) pending.get(reply.id)?.resolve(reply);
			} catch {
				// not a JSON frame: ignore
			}
		};
		socket.onclose = () => {
			for (const waiter of pending.values()) waiter.reject(new Error("inspector socket closed"));
		};
		let nextId = 0;
		const call = (method: string, params?: Record<string, unknown>): Promise<InspectorReply> => {
			const id = ++nextId;
			const waiter = Promise.withResolvers<InspectorReply>();
			pending.set(id, waiter);
			socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
			return waiter.promise;
		};
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => deadline.reject(new Error(`no answer within ${READ_TIMEOUT_MS} ms`)),
			READ_TIMEOUT_MS,
		);
		try {
			return await Promise.race([
				(async () => {
					await opened.promise;
					const gc = await call("Heap.gc");
					const gcForced = gc.error === undefined;
					if (!gcForced) notes.push(`heap ${port}: Heap.gc failed: ${String(gc.error?.message)}`);
					const evaluated = await call("Runtime.evaluate", {
						expression: HEAP_EXPRESSION,
						returnByValue: true,
					});
					const text = evaluatedString(evaluated.result);
					const stats = text === undefined ? undefined : parseHeapStats(text);
					if (stats === undefined) {
						notes.push(
							`heap ${port}: unexpected Runtime.evaluate reply ${JSON.stringify(evaluated).slice(0, 200)}`,
						);
						return undefined;
					}
					return {
						usedBytes: stats.heapSize,
						totalBytes: stats.heapCapacity,
						externalBytes: stats.extra,
						gcForced,
					};
				})(),
				deadline.promise,
			]);
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		notes.push(`heap ${port}: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	} finally {
		ws?.close();
	}
}
