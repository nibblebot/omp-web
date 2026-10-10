import type { ServerFrame } from "#lib/wire/protocol";
import { OMP_PROTO, SSE_EVENT_NAME } from "#lib/wire/protocol";
import { SSE_PING_BLOCK, encodeSseEvent } from "#lib/wire/sse";
import { rosterDaemons } from "./roster";

/**
 * The App screen's /events stream and the commands answered on it. App calls
 * the real connect(), so it needs a live SSE stream that looks like the fleet
 * edge: a `roster` frame before `hello_ok` (a bare daemon never sends one, and
 * the client then shows the fleet-required notice). POST /command replies are
 * unicast frames on that stream, matched by command id. Frames published while
 * no stream is open are kept (bounded) and replayed on the next open. `call()`
 * answers for stories come from the page instead (daemon.ts).
 */

type Sink = (chunk: string) => void;

const KEEPALIVE_MS = 15_000;
const BACKLOG_LIMIT = 64;
const sinks = new Set<Sink>();
const backlog: string[] = [];
let seq = 0;

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

/** GET /events: a live SSE stream for the design daemon. */
export function eventsResponse(): Response {
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
					{ type: "roster", daemons: rosterDaemons } satisfies ServerFrame,
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
	const cmd: { id?: unknown; type?: unknown; sessionId?: unknown } = body;
	if (typeof cmd.id !== "string") return null;
	if (cmd.type === "attach") {
		const sessionId = typeof cmd.sessionId === "string" ? cmd.sessionId : undefined;
		publish({ type: "attach_result", id: cmd.id, ok: true, sessionId });
		return accepted();
	}
	return null;
}
