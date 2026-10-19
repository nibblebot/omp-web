import type { DaemonEntry, ServerFrame } from "#lib/wire/protocol";
import { OMP_PROTO, SSE_EVENT_NAME } from "#lib/wire/protocol";
import { SSE_PING_BLOCK, encodeSseEvent } from "#lib/wire/sse";
import { rosterAppDaemons } from "./roster";

/**
 * The App screen's /events stream and the commands answered on it. App calls
 * the real connect(), so it needs a live SSE stream that looks like the fleet
 * edge: a `roster` frame before `hello_ok`. POST /command replies are
 * unicast frames on that stream, matched by command id. Frames published while
 * no stream is open are kept (bounded) and replayed on the next open. Attach
 * answers like the edge: `attach_result`, then the proxied `attached`; the
 * session's transcript is restored in the page (app-view.tsx). `call()`
 * answers for stories come from the page instead (daemon.ts).
 */

type Sink = (chunk: string) => void;

const KEEPALIVE_MS = 15_000;
const BACKLOG_LIMIT = 64;
const sinks = new Set<Sink>();
const backlog: string[] = [];
let seq = 0;
/** The App's roster; asleep entries turn ready when woken. Reset on every stream open (a page load). */
let roster: DaemonEntry[] = structuredClone(rosterAppDaemons);

const accepted = (): Response => new Response(null, { status: 202 });

function publish(frame: ServerFrame): void {
	const chunk = encodeSseEvent(SSE_EVENT_NAME, frame, ++seq);
	if (sinks.size === 0) {
		backlog.push(chunk);
		if (backlog.length > BACKLOG_LIMIT) backlog.shift();
		return;
	}
	for (const sink of sinks) sink(chunk);
}

/** Wake an asleep daemon the way spawn_resume does, and broadcast the new roster. */
function wake(daemonId: string): void {
	const entry = roster.find((d) => d.daemonId === daemonId);
	if (entry === undefined || entry.status !== "asleep") return;
	const now = Date.now();
	roster = roster.map((d) =>
		d === entry ? { ...d, status: "ready", desiredState: "running", readyAt: now, uptime: 0 } : d,
	);
	publish({ type: "roster", daemons: roster });
}

/** The entry after its daemon process stops: asleep, with no live process fields. */
function asleep(entry: DaemonEntry): DaemonEntry {
	const { readyAt: _readyAt, uptime: _uptime, pid: _pid, ...rest } = entry;
	return { ...rest, status: "asleep", desiredState: "stopped" };
}

/** GET /events: a live SSE stream for the design daemon. */
export function eventsResponse(): Response {
	roster = structuredClone(rosterAppDaemons);
	const encoder = new TextEncoder();
	let detach: () => void = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const write: Sink = (chunk) => controller.enqueue(encoder.encode(chunk));
			sinks.add(write);
			const keepalive = setInterval(() => write(SSE_PING_BLOCK), KEEPALIVE_MS);
			detach = () => {
				sinks.delete(write);
				clearInterval(keepalive);
			};
			write(
				encodeSseEvent(
					SSE_EVENT_NAME,
					{ type: "roster", daemons: roster } satisfies ServerFrame,
					++seq,
				),
			);
			write(
				encodeSseEvent(
					SSE_EVENT_NAME,
					{
						type: "hello_ok",
						proto: OMP_PROTO,
						name: "design-fixtures",
						cwd: "/home/joshua/Repos/omp-web",
						pid: 4242,
						version: "design-system",
					} satisfies ServerFrame,
					++seq,
				),
			);
			for (const chunk of backlog.splice(0)) write(chunk);
		},
		cancel() {
			detach();
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
	});
}

/**
 * POST /command: answer the commands this bus owns. Returns 202 when the
 * answer was queued on the stream, or null so the caller can fall through.
 */
export function answerCommand(body: unknown): Response | null {
	if (typeof body !== "object" || body === null) return null;
	const cmd: { id?: unknown; type?: unknown; sessionId?: unknown; daemonId?: unknown } = body;
	if (typeof cmd.id !== "string") return null;
	if (cmd.type === "spawn_resume") {
		if (typeof cmd.daemonId === "string") wake(cmd.daemonId);
		return accepted();
	}
	if (cmd.type === "stop" || cmd.type === "remove") {
		const daemonId = typeof cmd.daemonId === "string" ? cmd.daemonId : "";
		if (!roster.some((d) => d.daemonId === daemonId)) {
			publish({ type: "error", error: `unknown daemon: ${daemonId}` });
			return accepted();
		}
		// Local only: the roster changes, no process is touched. The broadcast
		// drives the web's own reconcile (a stopped or removed attached
		// daemon clears the chat column), as the edge's registry change does.
		if (cmd.type === "stop") {
			roster = roster.map((d) => (d.daemonId === daemonId ? asleep(d) : d));
			const row = roster.find((d) => d.daemonId === daemonId);
			publish({ type: "roster_delta", upserted: row ? [row] : [], removed: [] });
		} else {
			roster = roster.filter((d) => d.daemonId !== daemonId);
			publish({ type: "roster_delta", upserted: [], removed: [daemonId] });
		}
		return accepted();
	}
	if (cmd.type === "attach") {
		const sessionId = typeof cmd.sessionId === "string" ? cmd.sessionId : undefined;
		if (sessionId === undefined || !roster.some((d) => d.daemonId === sessionId)) {
			publish({
				type: "attach_result",
				id: cmd.id,
				ok: false,
				error: `unknown daemon: ${sessionId}`,
			});
			return accepted();
		}
		// The edge wakes a stopped daemon before answering its attach.
		wake(sessionId);
		publish({ type: "attach_result", id: cmd.id, ok: true, sessionId });
		publish({ type: "attached", sessionId });
		return accepted();
	}
	return null;
}
