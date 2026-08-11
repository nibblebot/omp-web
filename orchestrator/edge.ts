/**
 * Orchestrator edge (Phase 3): the browser-facing half of the aggregate UI.
 *
 * Mounted by orchestrator/server.ts on the same loopback Bun.serve as the
 * /ctl control API:
 *
 *   - `/ws` is the browser WebSocket edge. Every browser socket gets an
 *     immediate roster unicast; registry mutations broadcast a fresh roster;
 *     connector status transitions broadcast `daemon_status`. Browser
 *     commands are either handled here (list_projects / spawn /
 *     spawn_resume / stop / attach) or forwarded VERBATIM to the daemon
 *     over the browser's proxy pipe; anything outside the browser-command
 *     allowlist is rejected with an error frame.
 *   - PROXY ATTACH: one daemon socket PER BROWSER (ompd auto-attaches and
 *     primes every new socket, so history/state/available_commands come from
 *     the daemon itself). The pipe opens with the Bearer token, sends the
 *     hello handshake, swallows hello_ok, and forwards every other daemon
 *     frame, STAMPING the daemonId as sessionId on every session-scoped
 *     frame (ompd no longer sends one) and rewriting `attached`'s guard
 *     token the same way.
 *     connector.retain on pipe open / release on close feeds the idle
 *     policy. Asleep daemons are woken first (respawn for spawned entries,
 *     connector redial otherwise) and awaited to ready (60s) before piping.
 *   - Backpressure: a browser socket buffering more than 4 MiB has the
 *     frame dropped and receives one error frame marking the drop
 *     (drop-and-mark).
 *   - Aggregated daemons: every daemon connection (the connector's control
 *     socket and each proxy pipe) is tapped for {type:"daemons"} broker
 *     rosters. The latest roster per daemonId is cached (full-replace),
 *     merged across daemons, and broadcast as ONE {type:"daemons"} frame to
 *     every edge socket — also on browser open. Per-daemon daemons frames
 *     are stripped from proxy pipes (the merged frame is the only one
 *     browsers see), and removing a daemon from the registry evicts its
 *     cache (see daemons-aggregator.ts).
 *   - Static dist/ is served from the process cwd like ompd, with a tiny
 *     placeholder page when the file is missing.
 *
 * Roster serialization never leaks tokens/endpoints to browsers (see
 * toRosterEntry).
 */

import type { Server, ServerWebSocket } from "bun";
import { OMPD_PROTO } from "../src/protocol";
import type { ClientCommand, DaemonEntry, DaemonInfo, ServerFrame, SessionScopedFrame } from "../src/protocol";
import type { OrchestratorConfig } from "./config";
import { listProjects, validateProjectPath } from "./discovery";
import type { DaemonConnector } from "./connector";
import { daemonWsUrl, startSocketKeepalive, DEFAULT_PING_INTERVAL_MS, DEFAULT_PONG_TIMEOUT_MS } from "./connector";
import { DaemonsAggregator } from "./daemons-aggregator";
import type { Registry, RegistryEntry } from "./registry";
import type { SpawnSupervisor } from "./supervisor";

/** Backpressure cap for browser sockets: frames are dropped above this. */
export const DEFAULT_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/** How long a proxy attach waits for the daemon to become ready (contract: 60s). */
const ATTACH_WAIT_READY_MS = 60_000;

const WS_OPEN = 1;

/** k=v labels accepted on spawn (contract: `^[^=]+=.*$`). */
const LABEL_RE = /^[^=]+=.*$/;

/**
 * Validate a spawn command's `labels` field: undefined (absent) passes, an
 * array of k=v strings passes, anything else throws with a user-safe message
 * (the caller answers an error frame).
 */
function parseSpawnLabels(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((label) => typeof label === "string" && LABEL_RE.test(label))) {
		throw new Error("spawn: labels must be an array of k=v strings");
	}
	return value as string[];
}

const STDERR_ROUTE = /^\/ctl\/daemons\/([^/]+)\/stderr$/;

/**
 * Error frame for any browser command outside the allowlist. Phase 6: the
 * mux-era commands and `detach` are gone from ClientCommand, so a stale
 * client sending them (or plain garbage) must not reach the daemon — the
 * edge rejects it with this instead.
 */
const UNKNOWN_COMMAND_MESSAGE = "orchestrator edge: use spawn/stop/roster";

/**
 * Browser-command allowlist, checked on the RAW parsed frame before any
 * dispatch: edge-handled commands plus the ClientCommand variants forwarded
 * verbatim over the browser's pipe. `hello` is deliberately absent — it is
 * orchestrator→ompd only (the pipe handshake is the edge's job). Anything
 * else is rejected with UNKNOWN_COMMAND_MESSAGE. Typed against ClientCommand
 * so a removed variant stops compiling instead of silently broadening the
 * allowlist.
 */
const BROWSER_COMMAND_LIST: ClientCommand["type"][] = [
	// Handled at the edge.
	"list_projects",
	"spawn",
	"spawn_resume",
	"stop",
	"attach",
	// Forwarded verbatim over the browser's pipe.
	"call",
	"login_code",
	"ui_response",
	"list_sessions",
	"list_files",
	"get_process_stats",
	"collab_start",
	"collab_stop",
	"daemon_logs",
	"daemon_stop",
	"daemon_restart",
];
const BROWSER_COMMAND_TYPES: Record<string, true> = Object.fromEntries(BROWSER_COMMAND_LIST.map((type) => [type, true]));

/**
 * Session-scoped frame types (protocol's SessionScopedFrame). ompd no
 * longer stamps a sessionId on these; the pipe forwarder adds the daemonId
 * unconditionally so roster-mode clients can guard daemon switches. `attached`
 * is handled alongside: its sessionId is REQUIRED ("s1" from ompd) and must
 * read as the daemonId when it comes through the edge.
 */
const SESSION_SCOPED_FRAME_LIST: SessionScopedFrame["type"][] = [
	"history",
	"state",
	"event",
	"bash_chunk",
	"python_chunk",
	"ephemeral_delta",
	"call_result",
	"available_commands",
	"settings_changed",
	"subagent_lifecycle",
	"subagent_progress",
	"subagent_event",
	"ui_request",
	"collab_status",
];
const SESSION_SCOPED_FRAME_TYPES: Record<string, true> = Object.fromEntries(SESSION_SCOPED_FRAME_LIST.map((type) => [type, true]));

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>omp-orchestrator</title>
  </head>
  <body style="background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;min-height:100vh;margin:0">
    <main style="text-align:center">
      <h1>omp-orchestrator</h1>
      <p>The aggregate UI has not been built into <code>dist/</code> yet.</p>
    </main>
  </body>
</html>`;

/** The live machinery the edge coordinates. */
export interface EdgeDeps {
	registry: Registry;
	connector: DaemonConnector;
	supervisor: SpawnSupervisor;
	config: OrchestratorConfig;
}

/** A browser socket on the edge (data is unused; sockets are tracked by identity). */
export type EdgeSocket = ServerWebSocket<unknown>;

/** One proxy pipe: a browser's dedicated WebSocket to a daemon. */
interface PipeState {
	daemonId: string;
	ws: WebSocket;
	retained: boolean;
	/** Intentional teardown (browser close / re-attach) — onclose must not double-release. */
	closed: boolean;
	/** Stops the shared socket keepalive (same LIVENESS contract as the connector). */
	keepaliveStop: (() => void) | null;
}

interface BrowserState {
	pipe: PipeState | null;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Backpressure guard: true when the outgoing buffer exceeds the cap. */
export function shouldDropFrame(bufferedAmount: number, capBytes: number): boolean {
	return bufferedAmount > capBytes;
}

/**
 * Roster serialization: the DaemonEntry fields of a registry entry (never
 * token/endpoint/template/registeredAt) plus a live uptime in seconds since
 * readyAt (or registeredAt when never ready) and pid.
 */
export function toRosterEntry(entry: RegistryEntry): DaemonEntry {
	const uptimeBase = entry.readyAt ?? entry.registeredAt;
	const roster: DaemonEntry = {
		daemonId: entry.daemonId,
		name: entry.name,
		cwd: entry.cwd,
		project: entry.project,
		labels: [...entry.labels],
		mode: entry.mode,
		status: entry.status,
		uptime: Math.max(0, Math.floor((Date.now() - uptimeBase) / 1000)),
	};
	if (entry.worktreeOf !== undefined) roster.worktreeOf = entry.worktreeOf;
	if (entry.lastSessionFile !== undefined) roster.lastSessionFile = entry.lastSessionFile;
	if (entry.readyAt !== undefined) roster.readyAt = entry.readyAt;
	if (entry.pid !== undefined) roster.pid = entry.pid;
	if (entry.error !== undefined) roster.error = entry.error;
	return roster;
}

export class OrchestratorEdge {
	readonly #registry: Registry;
	readonly #connector: DaemonConnector;
	readonly #supervisor: SpawnSupervisor;
	readonly #config: OrchestratorConfig;
	readonly #backpressureBytes: number;
	readonly #pingIntervalMs: number;
	readonly #pongTimeoutMs: number;
	readonly #browsers = new Map<EdgeSocket, BrowserState>();
	/** daemonIds mid-wake (respawn/redial); serializes spawn_resume + attach. */
	readonly #waking = new Set<string>();
	/** Cached broker rosters per daemonId, merged into the broadcast daemons frame. */
	readonly #daemonsAggregator = new DaemonsAggregator();
	/** Control-socket taps per daemonId (unsubscribe fns), reconciled on registry change. */
	readonly #daemonTaps = new Map<string, () => void>();

	/** Bound once so close() can unset registry.onChange without clobbering a replacement. */
	readonly #onRegistryChange = (): void => {
		// A wake ends when the daemon's status leaves "asleep" (spawn_resume's
		// respawn resolves before the fresh child starts dialing, so clearing
		// here — not in #wake — keeps back-to-back attach from double-respawning).
		for (const daemonId of this.#waking) {
			if (this.#registry.get(daemonId)?.status !== "asleep") this.#waking.delete(daemonId);
		}
		// New daemons get a daemons-frame tap; removed ones lose it and their
		// cached rosters are evicted (broadcast so browsers drop the entries).
		this.#reconcileDaemonTaps();
		this.#broadcastRoster();
	};

	constructor(
		deps: EdgeDeps,
		opts?: {
			backpressureBytes?: number;
			/** LIVENESS: ping interval for proxy pipes (default 15s, shared with the connector). */
			pingIntervalMs?: number;
			/** LIVENESS: silence deadline for proxy pipes (default 10s). */
			pongTimeoutMs?: number;
		},
	) {
		this.#registry = deps.registry;
		this.#connector = deps.connector;
		this.#supervisor = deps.supervisor;
		this.#config = deps.config;
		this.#backpressureBytes = opts?.backpressureBytes ?? DEFAULT_BACKPRESSURE_BYTES;
		this.#pingIntervalMs = opts?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
		this.#pongTimeoutMs = opts?.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
		deps.registry.onChange = this.#onRegistryChange;
		// Tap daemons that already exist at construction (state.json load).
		this.#reconcileDaemonTaps();
	}

	/**
	 * Edge HTTP surface. Returns a Response (route handled), undefined (a
	 * successful /ws upgrade — the caller's fetch handler must return
	 * undefined), or null (not an edge route; the control plane decides).
	 * Never throws.
	 */
	async handleFetch(req: Request, server: Server<undefined>): Promise<Response | null | undefined> {
		try {
			const url = new URL(req.url);
			const path = url.pathname;
			if (path === "/ws") {
				if (req.method !== "GET") return null; // control plane 405s
				if (server.upgrade(req)) return undefined;
				return json({ error: "websocket upgrade failed" }, 400);
			}
			if (req.method !== "GET") return null;
			if (path === "/ctl/templates") {
				return json(Object.keys(this.#config.templates));
			}
			const stderrMatch = STDERR_ROUTE.exec(path);
			if (stderrMatch) {
				return this.#handleStderr(stderrMatch[1]);
			}
			if (path.startsWith("/ctl/")) return null; // the rest of /ctl is the control plane's
			return await this.#serveStatic(path);
		} catch (err) {
			return json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
	}

	/** Bun websocket `open` handler for the edge's browser sockets. */
	onSocketOpen(ws: EdgeSocket): void {
		this.#browsers.set(ws, { pipe: null });
		// Roster unicast on open.
		this.#sendToBrowser(ws, { type: "roster", daemons: this.#registry.list().map(toRosterEntry) });
		// Aggregated daemons broadcast on open (the cached merged roster).
		this.#broadcastDaemons();
	}

	/** Bun websocket `message` handler: browser command dispatch. */
	onSocketMessage(ws: EdgeSocket, message: string | Buffer): void {
		const state = this.#browsers.get(ws);
		if (!state) return;
		let raw: unknown;
		try {
			raw = JSON.parse(String(message));
		} catch {
			return; // non-JSON noise
		}
		if (typeof raw !== "object" || raw === null) return;
		const cmd = raw as Record<string, unknown>;
		if (typeof cmd.type !== "string") return;
		const type = cmd.type;
		// Phase 6: the mux-era commands and detach are gone from
		// ClientCommand. Any type outside the browser allowlist — a stale
		// client's removed command or plain garbage — is rejected here so
		// the daemon never sees a command it no longer understands.
		if (BROWSER_COMMAND_TYPES[type] !== true) {
			this.#sendError(ws, UNKNOWN_COMMAND_MESSAGE);
			return;
		}
		switch (type) {
			case "list_projects":
				void this.#handleListProjects(ws);
				break;
			case "spawn": {
				const cwd = typeof cmd.cwd === "string" && cmd.cwd !== "" ? cmd.cwd : undefined;
				if (cwd === undefined) {
					this.#sendError(ws, "spawn: missing cwd");
					break;
				}
				const template = typeof cmd.template === "string" && cmd.template !== "" ? cmd.template : undefined;
				let labels: string[] | undefined;
				try {
					labels = parseSpawnLabels(cmd.labels);
				} catch (err) {
					this.#sendError(ws, err instanceof Error ? err.message : String(err));
					break;
				}
				void this.#handleSpawn(ws, cwd, template, labels);
				break;
			}
			case "spawn_resume": {
				const daemonId = typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(ws, "spawn_resume: missing daemonId");
					break;
				}
				void this.#handleSpawnResume(ws, daemonId);
				break;
			}
			case "stop": {
				const daemonId = typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(ws, "stop: missing daemonId");
					break;
				}
				void this.#handleStop(ws, daemonId);
				break;
			}
			case "attach": {
				const daemonId = typeof cmd.sessionId === "string" && cmd.sessionId !== "" ? cmd.sessionId : undefined;
				if (daemonId === undefined) {
					this.#sendError(ws, "attach: missing sessionId");
					break;
				}
				void this.#handleAttach(ws, state, daemonId);
				break;
			}
			default:
				this.#forwardCommand(ws, state, cmd);
				break;
		}
	}

	/** Bun websocket `close` handler: browser gone → close its pipe + release. */
	onSocketClose(ws: EdgeSocket): void {
		const state = this.#browsers.get(ws);
		if (!state) return;
		this.#browsers.delete(ws);
		this.#closePipe(state);
	}

	/** Connector status transition → daemon_status broadcast (wired by server.ts). */
	onDaemonStatus(entry: RegistryEntry): void {
		const frame: ServerFrame = {
			type: "daemon_status",
			daemonId: entry.daemonId,
			status: entry.status,
			...(entry.error !== undefined ? { error: entry.error } : {}),
		};
		for (const ws of [...this.#browsers.keys()]) {
			this.#sendToBrowser(ws, frame);
		}
	}

	/** Detach broadcast wiring and close every browser socket + pipe. */
	close(): void {
		if (this.#registry.onChange === this.#onRegistryChange) {
			this.#registry.onChange = null;
		}
		for (const unsubscribe of this.#daemonTaps.values()) unsubscribe();
		this.#daemonTaps.clear();
		for (const [ws, state] of [...this.#browsers]) {
			this.#closePipe(state);
			try {
				ws.close(1000, "orchestrator close");
			} catch {
				// Ignore; the socket is already gone.
			}
		}
		this.#browsers.clear();
	}

	// ---------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------

	async #handleListProjects(ws: EdgeSocket): Promise<void> {
		try {
			const projects = await listProjects(this.#config.roots);
			this.#sendToBrowser(ws, { type: "projects", projects });
		} catch (err) {
			this.#sendError(ws, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleSpawn(ws: EdgeSocket, cwd: string, template: string | undefined, labels: string[] | undefined): Promise<void> {
		try {
			const resolved = await validateProjectPath(cwd);
			if (resolved === null) {
				this.#sendError(ws, `not a directory: ${cwd}`);
				return;
			}
			// Progress surfaces via roster/daemon_status broadcasts.
			await this.#supervisor.spawn({ cwd: resolved, template, labels });
		} catch (err) {
			this.#sendError(ws, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleSpawnResume(ws: EdgeSocket, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(ws, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.status !== "asleep") {
				this.#sendError(ws, `daemon ${daemonId} is not asleep (status ${entry.status})`);
				return;
			}
			await this.#wake(entry);
		} catch (err) {
			this.#sendError(ws, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleStop(ws: EdgeSocket, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(ws, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.mode === "spawned") {
				await this.#supervisor.stop(daemonId);
			} else {
				this.#connector.disconnect(daemonId);
				this.#registry.setStatus(daemonId, "asleep");
			}
		} catch (err) {
			this.#sendError(ws, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleAttach(ws: EdgeSocket, state: BrowserState, daemonId: string): Promise<void> {
		const entry = this.#registry.get(daemonId);
		if (!entry) {
			this.#sendError(ws, `unknown daemon: ${daemonId}`);
			return;
		}
		// Re-attach (same or another daemon) closes the previous pipe first.
		this.#closePipe(state);
		try {
			await this.#wake(entry);
			await this.#connector.waitReady(daemonId, ATTACH_WAIT_READY_MS);
		} catch (err) {
			this.#sendError(ws, err instanceof Error ? err.message : String(err));
			return;
		}
		const current = this.#registry.get(daemonId);
		if (!current?.endpoint) {
			this.#sendError(ws, `daemon ${daemonId} has no endpoint`);
			return;
		}
		this.#openPipe(ws, state, current);
	}

	// ---------------------------------------------------------------------
	// Proxy pipes
	// ---------------------------------------------------------------------

	/**
	 * Wake an asleep daemon: spawned → supervisor.respawn, else connector
	 * redial. Serialized per daemon — the roster UI sends spawn_resume and
	 * attach back-to-back; a second wake (from the attach) while the first is
	 * in flight must not respawn the child again, it just awaits ready.
	 */
	async #wake(entry: RegistryEntry): Promise<void> {
		if (entry.status !== "asleep") return;
		const daemonId = entry.daemonId;
		if (this.#waking.has(daemonId)) return;
		this.#waking.add(daemonId);
		try {
			if (entry.mode === "spawned") {
				await this.#supervisor.respawn(entry);
			} else {
				this.#connector.connect(daemonId);
			}
		} catch (err) {
			// A failed respawn never transitions the status; drop the guard so
			// a later wake can retry. Success is cleared by #onRegistryChange
			// once the status leaves "asleep".
			this.#waking.delete(daemonId);
			throw err;
		}
	}

	/** Open this browser's dedicated pipe to the daemon (Authorization + hello). */
	#openPipe(browser: EdgeSocket, state: BrowserState, entry: RegistryEntry): void {
		// A racing attach may have replaced state.pipe while we waited; never leak it.
		this.#closePipe(state);
		// The browser may have closed while waitReady was pending; don't open
		// a pipe nobody will close (its retain would pin the connector socket).
		if (!this.#browsers.has(browser)) return;
		let pipeWs: WebSocket;
		try {
			// ompd only upgrades /ws; registered endpoints are pathless, so
			// normalize like the connector's own dial (daemonWsUrl).
			pipeWs = new WebSocket(daemonWsUrl(entry.endpoint!), {
				headers: { Authorization: `Bearer ${entry.token ?? ""}` },
			} as never);
		} catch (err) {
			this.#sendError(browser, `pipe open failed: ${(err as Error).message}`);
			return;
		}
		const pipe: PipeState = { daemonId: entry.daemonId, ws: pipeWs, retained: false, closed: false, keepaliveStop: null };
		state.pipe = pipe;
		pipeWs.onopen = () => {
			if (pipe.closed) {
				try {
					pipeWs.close(1000, "edge closed");
				} catch {
					// Ignore.
				}
				return;
			}
			pipe.retained = true;
			this.#connector.retain(pipe.daemonId);
			try {
				pipeWs.send(JSON.stringify({ type: "hello", proto: OMPD_PROTO, token: entry.token } satisfies ClientCommand));
			} catch {
				// Socket died between open and send; the close handler owns teardown.
			}
			// LIVENESS: the pipe shares the connector's keepalive helper; a
			// silent daemon pipe is terminated and reported lost (re-attach).
			pipe.keepaliveStop = startSocketKeepalive(pipeWs, {
				pingIntervalMs: this.#pingIntervalMs,
				pongTimeoutMs: this.#pongTimeoutMs,
			});
		};
		pipeWs.onmessage = (ev) => {
			if (pipe.closed) return;
			this.#onPipeFrame(browser, pipe, String(ev.data));
		};
		pipeWs.onerror = () => {
			// Bun fires onclose after onerror; the close handler owns teardown.
		};
		pipeWs.onclose = () => {
			if (pipe.closed) return; // intentional teardown already released
			pipe.closed = true;
			if (pipe.keepaliveStop) {
				pipe.keepaliveStop();
				pipe.keepaliveStop = null;
			}
			const browserState = this.#browsers.get(browser);
			if (browserState?.pipe === pipe) browserState.pipe = null;
			this.#releaseRetain(pipe);
			this.#sendError(browser, "daemon connection lost");
		};
	}

	/**
	 * Forward a daemon frame: swallow hello_ok and per-daemon broker
	 * rosters; STAMP sessionId = daemonId on every session-scoped frame
	 * (ompd no longer sends one) and on `attached` (its required "s1" must
	 * read as the daemonId through the edge). Global frames pass unchanged.
	 */
	#onPipeFrame(browser: EdgeSocket, pipe: PipeState, data: string): void {
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch {
			return; // non-JSON noise
		}
		if (typeof raw !== "object" || raw === null) return;
		const frame = raw as Record<string, unknown>;
		if (frame.type === "hello_ok") return; // swallow the handshake answer
		if (frame.type === "daemons") {
			// Broker rosters are tapped here (like the control socket) but
			// NEVER forwarded: browsers only ever see the edge's single
			// merged frame (#broadcastDaemons).
			if (Array.isArray(frame.daemons)) this.#ingestDaemons(pipe.daemonId, frame.daemons as DaemonInfo[]);
			return;
		}
		const stamped =
			SESSION_SCOPED_FRAME_TYPES[String(frame.type)] === true || frame.type === "attached"
				? { ...frame, sessionId: pipe.daemonId }
				: frame;
		this.#sendToBrowser(browser, stamped);
	}

	/** Intentional pipe teardown (browser close / re-attach): release + close. */
	#closePipe(state: BrowserState): void {
		const pipe = state.pipe;
		if (!pipe) return;
		state.pipe = null;
		pipe.closed = true;
		if (pipe.keepaliveStop) {
			pipe.keepaliveStop();
			pipe.keepaliveStop = null;
		}
		this.#releaseRetain(pipe);
		try {
			pipe.ws.close(1000, "edge close");
		} catch {
			// Ignore; the socket is already gone.
		}
	}

	#releaseRetain(pipe: PipeState): void {
		if (!pipe.retained) return;
		pipe.retained = false;
		this.#connector.release(pipe.daemonId);
	}

	/** Forward a non-edge command verbatim over the browser's pipe. */
	#forwardCommand(ws: EdgeSocket, state: BrowserState, cmd: Record<string, unknown>): void {
		const pipe = state.pipe;
		if (!pipe || pipe.ws.readyState !== WS_OPEN) {
			this.#sendError(ws, "not attached");
			return;
		}
		try {
			pipe.ws.send(JSON.stringify(cmd));
		} catch {
			this.#sendError(ws, "not attached");
		}
	}

	// ---------------------------------------------------------------------
	// Sending + broadcasting
	// ---------------------------------------------------------------------

	/** Drop-and-mark: frames over the backpressure cap are dropped, one error frame marks it. */
	#sendToBrowser(ws: EdgeSocket, frame: unknown): void {
		if (shouldDropFrame(ws.getBufferedAmount(), this.#backpressureBytes)) {
			this.#sendError(ws, "backpressure: output dropped — re-attach");
			return;
		}
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			// Socket dying; the close handler owns cleanup.
		}
	}

	#sendError(ws: EdgeSocket, error: string): void {
		try {
			ws.send(JSON.stringify({ type: "error", error }));
		} catch {
			// Socket dying; the close handler owns cleanup.
		}
	}

	#broadcastRoster(): void {
		const daemons = this.#registry.list().map(toRosterEntry);
		for (const ws of [...this.#browsers.keys()]) {
			this.#sendToBrowser(ws, { type: "roster", daemons });
		}
	}

	// ---------------------------------------------------------------------
	// Aggregated daemons panel
	// ---------------------------------------------------------------------

	/**
	 * Keep a control-socket tap on every registered daemon and drop taps for
	 * removed ones (evicting their cached rosters). Idempotent; runs on
	 * every registry change and once at construction.
	 */
	#reconcileDaemonTaps(): void {
		const live = new Set(this.#registry.list().map((entry) => entry.daemonId));
		let evicted = false;
		for (const [daemonId, unsubscribe] of this.#daemonTaps) {
			if (live.has(daemonId)) continue;
			unsubscribe();
			this.#daemonTaps.delete(daemonId);
			this.#daemonsAggregator.remove(daemonId);
			evicted = true;
		}
		for (const entry of this.#registry.list()) {
			if (this.#daemonTaps.has(entry.daemonId)) continue;
			this.#daemonTaps.set(
				entry.daemonId,
				this.#connector.onFrame(entry.daemonId, (frame) => {
					if (frame.type !== "daemons" || !Array.isArray(frame.daemons)) return;
					this.#ingestDaemons(entry.daemonId, frame.daemons);
				}),
			);
		}
		if (evicted) this.#broadcastDaemons();
	}

	/** Cache a daemon's latest broker roster and broadcast the merged frame. */
	#ingestDaemons(daemonId: string, entries: DaemonInfo[]): void {
		// Removed daemons' frames are ignored: eviction is final even when a
		// stale browser pipe keeps delivering (registry removal unsubscribes
		// the control tap; pipes are only closed on browser close/re-attach).
		const entry = this.#registry.get(daemonId);
		if (!entry) return;
		this.#daemonsAggregator.ingest(daemonId, entries, entry.cwd);
		this.#broadcastDaemons();
	}

	/** Broadcast ONE merged {type:"daemons"} frame to every edge socket. */
	#broadcastDaemons(): void {
		const frame: ServerFrame = { type: "daemons", daemons: this.#daemonsAggregator.merge() };
		for (const ws of [...this.#browsers.keys()]) {
			this.#sendToBrowser(ws, frame);
		}
	}

	// ---------------------------------------------------------------------
	// /ctl routes + static
	// ---------------------------------------------------------------------

	/** GET /ctl/daemons/{id}/stderr: 404 for unknown/non-spawned entries. */
	#handleStderr(daemonId: string): Response {
		const entry = this.#registry.get(daemonId);
		if (!entry || entry.mode !== "spawned") {
			return json({ error: "not found" }, 404);
		}
		return json({ text: this.#supervisor.stderrTail(daemonId) });
	}

	/** Static dist/ from the process cwd, with a tiny placeholder fallback. */
	async #serveStatic(pathname: string): Promise<Response> {
		const file = Bun.file(pathname === "/" ? "dist/index.html" : `dist${pathname}`);
		if (await file.exists()) {
			return new Response(file);
		}
		return new Response(PLACEHOLDER_HTML, {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
}
