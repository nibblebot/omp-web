/**
 * Fleet edge (Phase 3): the browser-facing half of the aggregate UI.
 *
 * Mounted by fleet/server.ts on the same loopback Bun.serve as the
 * /ctl control API:
 *
 *   - GET /events is the browser SSE downlink. Every open stream gets an
 *     immediate roster + merged-daemons + registered-projects priming
 *     (edge-local seqs 1..k, k < SSE_DELTA_SEQ_START); live `roster` /
 *     `daemon_status` / `daemons` / `registered_projects` broadcasts and
 *     proxied daemon frames follow as SSE events with
 *     edge-local monotonic seqs from SSE_DELTA_SEQ_START, kept in a
 *     per-client SseRing (cap SSE_RING_CAP, byte budget SSE_RING_BYTES) for
 *     Last-Event-ID resume: N ≥ SSE_DELTA_SEQ_START replays ring.after(N)
 *     after priming, anything below skips replay (priming already carries
 *     full current state). Only daemon DELTA types are ringed (mirror of the
 *     daemon's RING_DELTAS, finding #5): priming frames (history,
 *     available_commands) and unicast answers (call_result) ride the live
 *     stream with a seq but no ring entry — re-derivable by re-attach
 *     priming / re-POST, exactly like the daemon.
 *   - POST /command is the browser uplink: one ClientCommand per request,
 *     202 {commandId} on accept, answers ride /events only. Commands are
 *     routed to a browser by the X-Omp-Client-Id header (the browser binds
 *     its stream at /events open with ?client=<id>); a missing or unknown
 *     id is a 400. Fleet-level commands (list_projects / spawn /
 *     spawn_resume / stop / remove / attach) are handled here;
 *     attached-session commands (call / login_code / ui_response /
 *     collab_* / daemon_* / list_*) proxy to the
 *     attached daemon's POST /command with the bearer token. Anything
 *     outside the browser-command allowlist is rejected with an error
 *     frame.
 *   - PROXY ATTACH: one daemon /events stream PER BROWSER (the daemon
 *     primes every new stream, so hello_ok → attached → history → state →
 *     available_commands → ready come from the session itself). The pipe
 *     opens with the Bearer token, proto-gates hello_ok then FORWARDS it
 *     (finding #61: the browser's own proto check runs in roster mode too),
 *     ingests per-daemon broker rosters, and forwards every other session
 *     frame, STAMPING the
 *     daemonId as sessionId on every session-scoped frame (omp-session no
 *     longer sends one) and rewriting `attached`'s guard token the same
 *     way. connector.retain on pipe open / release on terminal pipe end
 *     feeds the idle policy. Asleep sessions are woken first (respawn for
 *     spawned entries, connector redial otherwise) and awaited to ready
 *     (60s) before piping. Pipe resume (finding #4): a non-intentional
 *     pipe end (error, silence past silenceDeadlineMs, or clean close) is
 *     NOT terminal — the edge redials /events with Last-Event-ID (the last
 *     forwarded daemon seq, delta-era only) on jittered bounded backoff,
 *     so the browser stays attached across a dropped stream. Only a
 *     terminal outcome — 401, proto mismatch, no endpoint, or the redial
 *     budget exhausted — releases the retain and emits the "daemon
 *     connection lost" error frame. Attach is answered with an id-keyed
 *     attach_result frame (finding #28) so unrelated global error frames
 *     never settle a browser's in-flight attach.
 *   - Backpressure: a browser stream buffering more than the cap (default
 *     SSE_BACKPRESSURE_BYTES) is terminated (drop-and-resume): the browser
 *     reconnects with Last-Event-ID and the edge replays its ring. One slow
 *     browser never stalls the daemon stream or other browsers.
 *   - Real-time daemon activity: the control-socket tap derives per-daemon
 *     {streaming, blocked} from state / ui_request / ui_request_end and
 *     broadcasts an edge-generated {type:"daemon_activity"} frame ONLY on
 *     change (never ringed — re-derivable from the next open's priming).
 *     While ≥1 browser stream is open, every READY daemon is retained +
 *     dialed so its activity stays live — which counts as an attached
 *     client and SUSPENDS those daemons' idle auto-exit until the last
 *     browser disconnects (then release → 60s idle-drop resumes). See
 *     docs/architecture.md. daemon_activity is stripped from proxy pipes
 *     like `daemons` broker rosters.
 *   - Aggregated daemons: every daemon connection (the connector's control
 *     stream and each proxy pipe) is tapped for {type:"daemons"} broker
 *     rosters. The latest roster per daemonId is cached (full-replace),
 *     merged across daemons, and broadcast as ONE {type:"daemons"} frame to
 *     every edge stream — also on browser open. Per-daemon daemons frames
 *     are stripped from proxy pipes (the merged frame is the only one
 *     browsers see), and removing a daemon from the registry evicts its
 *     cache (see daemons-aggregator.ts).
 *   - Static dist/ is served from the process cwd like omp-session, with a
 *     tiny placeholder page when the file is missing.
 *
 * Roster serialization never leaks tokens/endpoints to browsers (see
 * toRosterEntry).
 */

import { randomUUID } from "node:crypto";
import {
	OMP_PROTO,
	SSE_BACKPRESSURE_BYTES,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	SSE_KEEPALIVE_MS,
	SSE_RING_CAP,
	SSE_RING_BYTES,
	SSE_SILENCE_DEADLINE_MS,
	type ClientCommand,
	type DaemonEntry,
	type DaemonInfo,
	type PublicProviderProfile,
	type RegisteredProject,
	type ServerFrame,
	type SessionScopedFrame,
} from "../shared/protocol";
import {
	encodeSseEvent,
	parseSseUnits,
	SSE_PING_BLOCK,
	SSE_PING_EVENT,
	SseRing,
} from "../shared/sse";
import { EMBEDDED_DIST } from "../server/embedded-dist";
import { CALLBACK_CONTROL_STREAM_ID } from "../shared/callback-protocol";
import type { CallbackEnvelope } from "../shared/callback-protocol";
import type { FleetConfig } from "./config";
import { validateProjectPath } from "./discovery";
import { BrowseError, browseDirectories } from "./fs-browse";
import type { DaemonConnector } from "./connector";
import { backoffDelay, daemonHttpBase } from "./connector";
import { DaemonsAggregator } from "./daemons-aggregator";
import type { DaemonTransportRegistry, VirtualStreamSink } from "./daemon-transport";
import {
	listCloneDaemonSessions,
	listDaemonSessions,
	type CloneSessionStore,
} from "./daemon-sessions";
import { headOf } from "./stored-sessions";
import type { Registry, RegistryEntry } from "./registry";
import type { SpawnSupervisor } from "./supervisor";
import type { FleetEventLog, FleetFacts } from "./events";
import {
	createWorktree,
	deleteWorktree,
	isPathUnder,
	listProjectBranches,
	mergeUnregisteredWorktrees,
	projectIdForCwd,
	realpathOf,
	registerProjectMainEntry,
	registerWorktreeEntry,
	validateUnregisteredWorktree,
	worktreeDeleteInfo,
	type CreateWorktreeResult,
} from "./worktrees";

/** How long a proxy attach waits for the daemon to become ready (contract: 60s). */
const ATTACH_WAIT_READY_MS = 60_000;

/** Reclaim grace for a disconnected browser's ring (Last-Event-ID resume window). */
const CLIENT_RECLAIM_MS = 60_000;

/** Roster-dropdown listing size: the last N sessions of a daemon's worktree. */
const DROPDOWN_SESSION_LIMIT = 10;

/**
 * Roster enrichment TTL (S2). The clone stored-history read walks the log
 * store; the roster projects on every broadcast, so the result is memoized for
 * this window. Short enough that a just-stored session's title appears
 * promptly, long enough that a burst of roster broadcasts costs one store walk
 * per clone per window.
 */
const CLONE_HISTORY_TTL_MS = 30_000;

/**
 * Per-daemon realtime activity, derived by the edge from the raw tapped
 * daemon frames (state → isStreaming; ui_request / ui_request_end → the
 * open-dialog set that drives `blocked`). Starts UNKNOWN per daemon
 * (`known: false`, nothing derived) until the first derivable frame
 * arrives. Never carries tokens/endpoints.
 */
interface DaemonActivity {
	/** True once at least one derivable frame has been observed (unknown→known is itself a change). */
	known: boolean;
	streaming: boolean;
	blocked: boolean;
	/** ui_request ids currently open on the daemon; `blocked` = size > 0. */
	openDialogIds: Set<string>;
}

/**
 * Proxy-pipe redial backoff bounds (finding #4). The pipe mirrors the
 * connector's resume semantics: a non-intentional stream end schedules a
 * jittered exponential redial (these bounds, connector-style) that carries
 * Last-Event-ID so the daemon replays only what the pipe missed. A
 * connected pipe that delivers ANY unit resets the budget; only
 * consecutive failures (dial refusals or streams that never deliver a unit)
 * count toward PIPE_MAX_REDIALS, after which the pipe is reported lost.
 */
const PIPE_BACKOFF_MIN_MS = 1_000;
const PIPE_BACKOFF_MAX_MS = 30_000;
const PIPE_MAX_REDIALS = 20;

/** Encode SSE blocks once per edge (the queue strategy sizes in bytes). */
const SSE_ENCODER = new TextEncoder();

/** k=v labels accepted on spawn (contract: `^[^=]+=.*$`). */
const LABEL_RE = /^[^=]+=.*$/;

/**
 * Validate a spawn command's `labels` field: undefined (absent) passes, an
 * array of k=v strings passes, anything else throws with a user-safe message
 * (the caller answers an error frame).
 */
function parseSpawnLabels(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		!value.every((label) => typeof label === "string" && LABEL_RE.test(label))
	) {
		throw new Error("spawn: labels must be an array of k=v strings");
	}
	return value as string[];
}

const STDERR_ROUTE = /^\/ctl\/sessions\/([^/]+)\/stderr$/;
/** Fleet-proxied session-file download (P3.4): clone files ride the callback bulk channel; direct daemons proxy their /download endpoint. */
const DOWNLOAD_ROUTE = /^\/ctl\/sessions\/([^/]+)\/download$/;

/**
 * Error frame for any browser command outside the allowlist. Phase 6: the
 * mux-era commands and `detach` are gone from ClientCommand, so a stale
 * client sending them (or plain garbage) must not reach the daemon — the
 * edge rejects it with this instead.
 */
const UNKNOWN_COMMAND_MESSAGE = "fleet edge: use spawn/stop/roster";

/**
 * Browser-command allowlist, checked on the RAW parsed frame before any
 * dispatch: edge-handled commands plus the ClientCommand variants forwarded
 * to the attached daemon. `hello` is gone from the protocol (OMP_PROTO 2:
 * daemon auth is HTTP-level, the bearer header). Anything else is rejected
 * with UNKNOWN_COMMAND_MESSAGE. Typed against ClientCommand so a removed
 * variant stops compiling instead of silently broadening the allowlist.
 */
const BROWSER_COMMAND_LIST = [
	// Handled at the edge.
	"list_projects",
	"list_project_branches",
	"list_daemon_sessions",
	"spawn",
	"spawn_resume",
	"stop",
	"remove",
	// Clone creation (P8.1): handled at the edge via the injected lifecycle hooks.
	"create_clone",
	"add_project",
	"remove_project",
	"attach",
	// Worktree lifecycle (Phase 4): create/add/delete + delete-info evidence.
	"create_worktree",
	"add_worktree",
	"delete_worktree",
	"worktree_delete_info",
	// Forwarded to the attached daemon's POST /command.
	"call",
	"login_code",
	"ui_response",
	"list_sessions",
	"list_files",
	"collab_start",
	"collab_stop",
	"daemon_logs",
	"daemon_stop",
	"daemon_restart",
] as const satisfies readonly ClientCommand["type"][];
// Exhaustiveness pin (finding #63): `as const satisfies` catches REMOVED
// variants (a literal no longer in the union fails), and this assignment
// fails tsc on ADDED ones — a variant added to the union without an
// allowlist row would otherwise compile and silently stop being proxied.
// `(typeof BROWSER_COMMAND_LIST)[number]` is the list's literal union only
// because of the `as const`; with a plain annotated array it would be the
// whole ClientCommand union and the pin would be a no-op.
const _browserCommandAllowlistExhaustive: Record<
	Exclude<ClientCommand["type"], (typeof BROWSER_COMMAND_LIST)[number]>,
	never
> = {};
const BROWSER_COMMAND_TYPES: Record<string, true> = Object.fromEntries(
	BROWSER_COMMAND_LIST.map((type) => [type, true]),
);

/**
 * Session-scoped frame types (protocol's SessionScopedFrame). omp-session
 * no longer stamps a sessionId on these; the pipe forwarder adds the
 * daemonId unconditionally so roster-mode clients can guard daemon
 * switches. `attached` is handled alongside: its sessionId is REQUIRED
 * ("s1" from omp-session) and must read as the daemonId when it comes
 * through the edge.
 */
const SESSION_SCOPED_FRAME_LIST = [
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
	// Finding #16: the dialog's settle marker rides the session scope like the
	// request, so a daemon switch guard applies the same way.
	"ui_request_end",
	"collab_status",
] as const satisfies readonly SessionScopedFrame["type"][];
// Exhaustiveness pin (finding #63): same addition-direction guard as the
// browser-command allowlist — a session-scoped frame added to the union
// without a row here would otherwise be forwarded UNSTAMPED (no daemonId),
// which the client's stale-frame guard would drop on a daemon switch.
const _sessionScopedFrameListExhaustive: Record<
	Exclude<SessionScopedFrame["type"], (typeof SESSION_SCOPED_FRAME_LIST)[number]>,
	never
> = {};
const SESSION_SCOPED_FRAME_TYPES: Record<string, true> = Object.fromEntries(
	SESSION_SCOPED_FRAME_LIST.map((type) => [type, true]),
);

/**
 * Daemon frame types the edge RINGS per client (finding #5). MUST mirror
 * server/index.ts RING_DELTAS: a frame the daemon does not ring (priming:
 * hello_ok/attached/history/available_commands; unicast answers:
 * call_result; per-stream lifecycle: stream_reset) is forwarded live but
 * never ringed — it is re-derivable by re-attach priming or re-POSTing the
 * command. Ringed deltas are the frames a Last-Event-ID resume actually
 * needs; everything else merely consumes a seq, exactly like the daemon's
 * delta counter, so ring replay has the same deliberate gaps and a
 * resuming consumer tolerates them (after() returns only ringed entries
 * newer than the id).
 */
const EDGE_RING_DELTAS: Record<string, true> = {
	state: true,
	event: true,
	bash_chunk: true,
	python_chunk: true,
	ephemeral_delta: true,
	settings_changed: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	subagent_event: true,
	ui_request: true,
	// Finding #16: the dialog's settle marker is ringed like the request, so
	// a resume replays request → end (dismissed), never a stale dialog.
	ui_request_end: true,
	collab_status: true,
	ready: true,
	daemons: true,
	error: true,
};

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>omp-web</title>
  </head>
  <body style="background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;min-height:100vh;margin:0">
    <main style="text-align:center">
      <h1>omp-web</h1>
      <p>The aggregate UI has not been built into <code>dist/</code> yet.</p>
    </main>
  </body>
</html>`;

/**
 * Clone lifecycle service injected into the edge (P6/P7 boundary). The edge
 * NEVER stops/removes/deletes a clone workspace through the supervisor,
 * connector, git worktree guards, or registry.remove directly — every clone
 * lifecycle mutation goes through these hooks so the provider lifecycle,
 * admission, and the verify-at-deletion gate cannot be bypassed from the
 * browser surface. All methods throw typed errors whose messages are safe
 * to surface in an error frame. Implemented by fleet/workspace-lifecycle.ts
 * (structural conformance — the edge holds no import on it).
 */
export interface EdgeLifecycleHooks {
	/** Create + optionally start a clone workspace (P1/P8.1); the roster broadcast carries the result. */
	createClone(input: CreateCloneInput): Promise<RegistryEntry>;
	/**
	 * Start + wake: resolves once the provider confirms compute running and
	 * enrollment is persisted; pair readiness rides the lifecycleStage roster
	 * broadcasts (runtime → callback → ready). Idempotent; safe to call for
	 * both start and wake.
	 *
	 * `resumeSessionId` (optional) is the store-validated session id from a
	 * dropdown pick; the lifecycle materializes cold transcripts and resumes
	 * that session on wake. Omitted = plain wake (lifecycle resumes the
	 * newest session, or boots fresh when none exists).
	 */
	ensureCloneRunning(daemonId: string, opts?: { resumeSessionId?: string }): Promise<void>;
	/** Ordinary stop: proof-bearing provider stop, desiredState stopped, data retained. */
	stopClone(daemonId: string): Promise<void>;
	/** Verified delete (P7 gate): refuses active work, verifies the fleet store, then deletes provider resources. */
	deleteClone(daemonId: string): Promise<{ verified: string[] }>;
	/** Clone-safe roster remove: routes through the SAME verified gate as deleteClone. */
	removeClone(daemonId: string): Promise<void>;
}

/** Frozen create_clone command payload (docs/clone-contracts.md, "Browser and CLI workspace creation"). */
export interface CreateCloneInput {
	projectId: string;
	name: string;
	profileId: string;
	/** Exactly one member when given; omitted = the registered project's local path. */
	source?: { local?: string; remote?: string };
	revision?: string;
	branch?: string;
	start?: boolean;
}

/** The live machinery the edge coordinates. */
export interface EdgeDeps {
	registry: Registry;
	connector: DaemonConnector;
	supervisor: SpawnSupervisor;
	config: FleetConfig;
	/** Fleet lifecycle-event ring, surfaced verbatim by /ctl/debug. */
	eventLog: FleetEventLog;
	/** Fleet-wide facts (port/startedAt/state paths) surfaced by /ctl/debug. */
	fleet: FleetFacts;
	/**
	 * Callback transport (P3): present whenever the fleet enrolled daemons
	 * can dial back. Clone-kind attach/commands/downloads ride it; direct and
	 * worktree daemons never touch it. Absent (legacy/test construction) =
	 * clone rows report typed unavailability instead of dialing.
	 */
	transport?: DaemonTransportRegistry;
	/** Clone lifecycle service (create/start/wake/stop/remove/delete). Absent = clone commands answer typed unavailability. */
	lifecycle?: EdgeLifecycleHooks;
	/** Boot-static secret-free provider catalog (P1.3), published on registered_projects. Omitted entirely when not configured. */
	providerProfiles?: PublicProviderProfile[];
	/** Fleet transcript store (P3.8) for clone session listing/resume membership. Absent = clone rows list no sessions. */
	logStore?: CloneSessionStore;
}

/**
 * One browser /events consumer on the edge, keyed by the browser's
 * page-scoped clientId. The ring + seq counter live here so a reconnecting
 * browser (same clientId) resumes from its Last-Event-ID across stream
 * replacement; the state is reclaimed after a grace period with no stream.
 */
interface BrowserClient {
	/** Page-scoped id from ?client= (null for anonymous streams — not command-addressable). */
	clientId: string | null;
	/** Edge-local replay ring of this browser's ringed deltas (cap SSE_RING_CAP, byte budget SSE_RING_BYTES). */
	ring: SseRing<string>;
	/** Next edge-local delta seq for this browser (≥ SSE_DELTA_SEQ_START). */
	nextSeq: number;
	/** Live stream, or null while disconnected (the ring is kept for resume). */
	stream: BrowserStream | null;
	/** Reclaim timer: drops the client state when no stream rebinds in time. */
	gcTimer: ReturnType<typeof setTimeout> | null;
}

/** One live GET /events stream on the edge. */
interface BrowserStream {
	controller: ReadableStreamDefaultController<Uint8Array>;
	/**
	 * Bytes enqueued while no reader is attached (desiredSize is null then).
	 * Reset once a reader becomes visible and desiredSize reports the truth.
	 */
	unreadEstimate: number;
	/** The client this stream belongs to (ring/seq live there). */
	client: BrowserClient;
	/** This browser's dedicated daemon channel: a direct proxy pipe (worktree/direct)
	 * or a callback virtual stream (clone, P3.4). Null while unattached. */
	pipe: PipeState | null;
}

/**
 * One proxy pipe: a browser's dedicated direct /events stream to a daemon
 * (direct/worktree daemons — the legacy transport, unchanged).
 */
interface DirectPipeState {
	mode: "direct";
	daemonId: string;
	/** AbortController for the daemon /events fetch — the pipe handle. */
	abort: AbortController;
	/** Intentional teardown (browser close / re-attach) — the pipe-end handler must not double-release. */
	closed: boolean;
	/** Retain fed to the connector's idle policy; released on pipe end. */
	retained: boolean;
	/** Resets on every SSE unit (event or comment); on fire the pipe is treated as lost. */
	silenceTimer: ReturnType<typeof setTimeout> | null;
	/** Last daemon seq forwarded; the redial's Last-Event-ID (delta-era only). */
	lastSeq: number;
	/** Consecutive failed redials since the last unit; bounds the retry budget. */
	redialAttempt: number;
	/** Pending redial (jittered backoff); cleared on intentional teardown/terminal loss. */
	reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * One callback virtual stream: a browser's dedicated "browser/<connId>" pair
 * to a clone daemon (P3.4 — no inbound dial ever exists for these). The
 * daemon primes + replays per stream; the edge only forwards envelopes and
 * re-sends stream_open after every pair replacement. Never redials: pair
 * liveness is the transport's job; a dropped pair surfaces as a
 * "daemon connection lost" error frame exactly like a terminal direct pipe.
 */
interface CallbackPipeState {
	mode: "callback";
	daemonId: string;
	/** Edge-chosen browser connection id — the "browser/<connId>" stream's suffix. */
	connId: string;
	/** Intentional teardown (browser close / re-attach / clone stopped/removed). */
	closed: boolean;
	/** Last daemon envelope seq consumed on this stream (stream_open.lastSeq). */
	lastSeq: number;
	/** The pair connectionId this stream was primed against; a change re-primes from 0. */
	pairConnectionId: string | null;
	/** Unbind the transport virtual stream; idempotent, safe after close(). */
	detach: () => void;
	/** Unsubscribe the pair-change observer; idempotent, safe after close(). */
	unsubscribePair: () => void;
}

type PipeState = DirectPipeState | CallbackPipeState;

/** Narrow: this browser channel is a direct proxy pipe (direct/worktree daemons). */
function isDirectPipe(pipe: PipeState | null): pipe is DirectPipeState {
	return pipe !== null && pipe.mode === "direct";
}

function newClient(clientId: string | null, ringBytes: number): BrowserClient {
	return {
		clientId,
		ring: new SseRing<string>(SSE_RING_CAP, ringBytes),
		nextSeq: SSE_DELTA_SEQ_START,
		stream: null,
		gcTimer: null,
	};
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
 * Roster-facing clone stored-history summary (S2): the title shown on the row
 * and whether the row must read as empty.
 */
export interface CloneHistoryInfo {
	/** Stored-history session title; undefined when none is derivable. */
	title?: string;
	/** True when the row must read as empty ("New session") — no title. */
	empty: boolean;
}

/**
 * Derive a clone row's stored-history title/emptiness from the fleet log store.
 * The store is the same read model `/ctl/stored/sessions` serves (join key =
 * the entry's daemonId), and the head is parsed with `stored-sessions.headOf`
 * so the roster title matches the dropdown/transcript surface. Never throws: a
 * missing/unreadable store, workspace, session, or head degrades to
 * `{ empty: true }` — the row shows a plain "New session" instead of failing
 * the roster broadcast.
 *
 * Cost: one `listStoredSessions` (readdir of `logs/<workspaceId>` + a
 * per-session subtree stat walk) plus one bounded 64 KiB head read. That is
 * affordable for every roster broadcast ONLY because FleetEdge memoizes the
 * result for a short TTL (see #cloneHistoryFor); a caller that runs per
 * broadcast MUST cache.
 */
export function cloneStoredHistory(
	store: CloneSessionStore | undefined,
	workspaceId: string,
): CloneHistoryInfo {
	if (store === undefined) return { empty: true };
	try {
		const sessions = store.listStoredSessions(workspaceId);
		// Newest stored session wins — the same newest-first order the
		// dropdown lists its rows in.
		let newest: (typeof sessions)[number] | undefined;
		for (const session of sessions) {
			if (newest === undefined || session.mtimeMs > newest.mtimeMs) newest = session;
		}
		const relpath = newest?.mainRelpath;
		if (newest === undefined || relpath === undefined) return { empty: true };
		const title = headOf(store, workspaceId, newest.sessionId, relpath)?.title;
		return typeof title === "string" && title.length > 0
			? { title, empty: false }
			: { empty: true };
	} catch {
		return { empty: true };
	}
}

/**
 * Roster serialization: the DaemonEntry fields of a registry entry (never
 * token/endpoint/template/registeredAt) plus a live uptime in seconds since
 * readyAt (or registeredAt when never ready) and pid. `workspaceDir` (the
 * fleet managed-worktree root) computes `managed`: true when the entry's cwd
 * realpath is under it — the roster signal the close-out UI uses to offer
 * worktree deletion.
 *
 * P1.4 clone-workspace projection: the roster surfaces the PUBLIC subset of
 * the fleet-private WorkspaceRecord — kind→workspaceKind,
 * desiredState→desiredState, profileId→providerProfileId — plus the
 * ephemeral lifecycle liveness facts (lifecycleStage/lifecycleError, the
 * same liveness class as status/pid/readyAt). The record's private
 * remainder (providerHandle, cleanup/archive state, clone sources) NEVER
 * crosses this boundary, exactly as RegistryEntry's token/endpoint/template
 * never do: roster frames and registered_projects frames stay free of
 * tokens, private endpoints, provider handles, and secret material. Any
 * future workspace field must be mapped here explicitly (or added to the
 * RegisteredProject shape) before it can appear on the wire.
 *
 * S2: clone rows carry no probed `lastSessionFile` (its absence is
 * load-bearing elsewhere), so their sessionTitle/sessionEmpty cannot come from
 * the supervisor probe. `cloneHistory` (when supplied) resolves them from the
 * fleet log store for clone entries; a resolved title overrides the row and a
 * resolved empty flag keeps the client's "New session" affordance. No new wire
 * field is introduced — the existing sessionTitle/sessionEmpty fields are
 * reused.
 */
export function toRosterEntry(
	entry: RegistryEntry,
	workspaceDir?: string,
	cloneHistory?: (daemonId: string) => CloneHistoryInfo | undefined,
): DaemonEntry {
	const roster: DaemonEntry = {
		daemonId: entry.daemonId,
		name: entry.name,
		cwd: entry.cwd,
		project: entry.project,
		labels: [...entry.labels],
		mode: entry.mode,
		status: entry.status,
		// An asleep daemon has no live process: omit the uptime rather than let
		// the registeredAt fallback show a growing uptime for a dead daemon.
		...(entry.status === "asleep"
			? {}
			: {
					uptime: Math.max(
						0,
						Math.floor((Date.now() - (entry.readyAt ?? entry.registeredAt)) / 1000),
					),
				}),
	};
	if (entry.worktreeOf !== undefined) roster.worktreeOf = entry.worktreeOf;
	if (entry.projectId !== undefined) roster.projectId = entry.projectId;
	if (workspaceDir !== undefined && workspaceDir !== "" && entry.cwd !== "") {
		if (isPathUnder(realpathOf(entry.cwd), realpathOf(workspaceDir))) roster.managed = true;
	}
	if (entry.branch !== undefined) roster.branch = entry.branch;
	if (entry.git !== undefined) roster.git = { ...entry.git };
	if (entry.lastSessionFile !== undefined) roster.lastSessionFile = entry.lastSessionFile;
	if (entry.sessionTitle !== undefined) roster.sessionTitle = entry.sessionTitle;
	// The empty flag is meaningful only when true; a false/undefined is the same,
	// so it stays off the wire (mirrors the title-cleared rule above).
	if (entry.sessionEmpty === true) roster.sessionEmpty = true;
	// Liveness facts are meaningless for an asleep daemon; keep them off the
	// roster even if the registry entry transiently carries stale ones (e.g.
	// mid-respawn, when the supervisor writes the pid before the child readies).
	if (entry.status !== "asleep") {
		if (entry.readyAt !== undefined) roster.readyAt = entry.readyAt;
		if (entry.pid !== undefined) roster.pid = entry.pid;
	}
	if (entry.error !== undefined) roster.error = entry.error;
	// Clone workspace projection (P1.4): pass through the PUBLIC workspace
	// fields only — kind/desiredState/profileId from the fleet-private record
	// (legacy entries carry an in-memory inferred workspace after load), and
	// the ephemeral lifecycle liveness facts straight off the entry. The
	// record's providerHandle and everything else private stays off the wire.
	const workspace = entry.workspace;
	if (workspace !== undefined) {
		roster.workspaceKind = workspace.kind;
		roster.desiredState = workspace.desiredState;
		if (workspace.profileId !== undefined) roster.providerProfileId = workspace.profileId;
	}
	// S2: a clone's title/emptiness come from its fleet-stored history, not
	// from a probed lastSessionFile (which clones never persist). The resolver
	// always answers for clones (an absent store degrades to empty), so a clone
	// row is authoritative: a resolved title/empty replaces whatever the entry
	// carried. Non-clone entries keep the supervisor-probed fields above.
	if (workspace?.kind === "clone" && cloneHistory !== undefined) {
		const history = cloneHistory(entry.daemonId);
		if (history !== undefined) {
			if (history.title !== undefined) roster.sessionTitle = history.title;
			else delete roster.sessionTitle;
			if (history.empty) roster.sessionEmpty = true;
			else delete roster.sessionEmpty;
		}
	}
	if (entry.lifecycleStage !== undefined) roster.lifecycleStage = entry.lifecycleStage;
	if (entry.lifecycleError !== undefined) roster.lifecycleError = entry.lifecycleError;
	return roster;
}

export class FleetEdge {
	readonly #registry: Registry;
	readonly #connector: DaemonConnector;
	readonly #supervisor: SpawnSupervisor;
	readonly #config: FleetConfig;
	readonly #eventLog: FleetEventLog;
	readonly #fleet: FleetFacts;
	/** Callback transport (P3): clone attach/commands/downloads ride it; undefined = clone rows answer typed unavailability. */
	readonly #transport: DaemonTransportRegistry | undefined;
	/** Clone lifecycle service (P6/P7): every clone mutation goes through it, never a kind-blind edge path. */
	readonly #lifecycle: EdgeLifecycleHooks | undefined;
	/** Boot-static secret-free provider catalog, published on registered_projects (P1.3). */
	readonly #providerProfiles: PublicProviderProfile[] | undefined;
	/** Fleet transcript store for clone session listing/resume membership (P3.8). */
	readonly #logStore: CloneSessionStore | undefined;
	/** TTL cache backing the clone stored-history roster titles (S2). */
	readonly #cloneHistory = new Map<string, { at: number; info: CloneHistoryInfo }>();
	readonly #backpressureBytes: number;
	/** Per-client ring byte budget (default SSE_RING_BYTES; finding #5). */
	readonly #ringBytes: number;
	readonly #silenceDeadlineMs: number;
	/** Proxy-pipe redial backoff bounds + retry budget (finding #4). */
	readonly #pipeBackoffMinMs: number;
	readonly #pipeBackoffMaxMs: number;
	readonly #pipeMaxRedials: number;
	/** Live browser streams (broadcasts + backpressure). */
	readonly #browsers = new Set<BrowserStream>();
	/** Command-addressable browsers by clientId (ring survives stream replacement). */
	readonly #clients = new Map<string, BrowserClient>();
	/** daemonIds mid-wake (respawn/redial); serializes spawn_resume + attach. */
	readonly #waking = new Set<string>();
	/** Cached broker rosters per daemonId, merged into the broadcast daemons frame. */
	readonly #daemonsAggregator = new DaemonsAggregator();
	/** Control-socket taps per daemonId (unsubscribe fns), reconciled on registry change. */
	readonly #daemonTaps = new Map<string, () => void>();
	/** Per-daemon realtime activity, derived in the control-socket tap (browser-gated). */
	readonly #daemonActivity = new Map<string, DaemonActivity>();
	/** Ready daemons the edge holds via connector.retain() while ≥1 browser stream is open. */
	readonly #watchedReady = new Set<string>();
	/** Keepalive ping events on every open browser stream every SSE_KEEPALIVE_MS. */
	#keepaliveTimer: ReturnType<typeof setInterval> | null = null;

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
		// Ready daemons that just went live (or just left live) re-pin their
		// retain/dial while browsers are open; leavers are released exactly once.
		this.#reconcileActivityRetention();
		this.#broadcastRoster();
	};

	/** Project-set mutations only; the frame is re-derivable from priming, so it is never ringed. */
	readonly #onProjectsChange = (): void => {
		this.#broadcastRegisteredProjects();
	};

	constructor(
		deps: EdgeDeps,
		opts?: {
			/** Backpressure cap for browser streams (default SSE_BACKPRESSURE_BYTES). */
			backpressureBytes?: number;
			/** Per-client replay-ring byte budget (default SSE_RING_BYTES). */
			ringBytes?: number;
			/** LIVENESS: total silence on a daemon pipe (no event, no comment) before it is treated as lost (default SSE_SILENCE_DEADLINE_MS). */
			silenceDeadlineMs?: number;
			/** Proxy-pipe redial backoff floor (default PIPE_BACKOFF_MIN_MS). */
			pipeBackoffMinMs?: number;
			/** Proxy-pipe redial backoff ceiling (default PIPE_BACKOFF_MAX_MS). */
			pipeBackoffMaxMs?: number;
			/** Consecutive failed pipe redials before the pipe is reported lost (default PIPE_MAX_REDIALS). */
			pipeMaxRedials?: number;
		},
	) {
		this.#registry = deps.registry;
		this.#connector = deps.connector;
		this.#supervisor = deps.supervisor;
		this.#config = deps.config;
		this.#eventLog = deps.eventLog;
		this.#fleet = deps.fleet;
		this.#transport = deps.transport;
		this.#lifecycle = deps.lifecycle;
		this.#providerProfiles = deps.providerProfiles;
		this.#logStore = deps.logStore;
		this.#backpressureBytes = opts?.backpressureBytes ?? SSE_BACKPRESSURE_BYTES;
		this.#ringBytes = opts?.ringBytes ?? SSE_RING_BYTES;
		this.#silenceDeadlineMs = opts?.silenceDeadlineMs ?? SSE_SILENCE_DEADLINE_MS;
		this.#pipeBackoffMinMs = opts?.pipeBackoffMinMs ?? PIPE_BACKOFF_MIN_MS;
		this.#pipeBackoffMaxMs = opts?.pipeBackoffMaxMs ?? PIPE_BACKOFF_MAX_MS;
		this.#pipeMaxRedials = opts?.pipeMaxRedials ?? PIPE_MAX_REDIALS;
		deps.registry.onChange = this.#onRegistryChange;
		// Project-set mutations are rare and the frame is re-derivable from
		// priming, so they broadcast via a dedicated hook, never ringed.
		deps.registry.onProjectsChange = this.#onProjectsChange;
		// Tap daemons that already exist at construction (state.json load).
		this.#reconcileDaemonTaps();
	}

	/**
	 * Edge HTTP surface. Returns a Response (route handled) or null (not an
	 * edge route; the control plane decides). Never throws.
	 */
	async handleFetch(req: Request): Promise<Response | null> {
		try {
			const url = new URL(req.url);
			const path = url.pathname;
			if (path === "/events") {
				if (req.method !== "GET") return null; // control plane 405s
				return this.#openEventsResponse(req);
			}
			if (path === "/command") {
				if (req.method !== "POST") return null; // control plane 405s
				return await this.#handleCommand(req);
			}
			if (req.method !== "GET") return null;
			if (path === "/ctl/templates") {
				return json(Object.keys(this.#config.templates));
			}
			if (path === "/ctl/fs/browse") {
				try {
					return json(await browseDirectories(url.searchParams.get("path") ?? undefined));
				} catch (err) {
					if (err instanceof BrowseError) return json({ error: err.message }, 400);
					throw err;
				}
			}
			const stderrMatch = STDERR_ROUTE.exec(path);
			if (stderrMatch) {
				return this.#handleStderr(stderrMatch[1]);
			}
			const downloadMatch = DOWNLOAD_ROUTE.exec(path);
			if (downloadMatch) {
				return await this.#handleDownload(req, downloadMatch[1]);
			}
			if (path === "/ctl/debug") {
				return json(this.#debugSnapshot());
			}
			if (path.startsWith("/ctl/")) return null; // the rest of /ctl is the control plane's
			return await this.#serveStatic(path);
		} catch (err) {
			return json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
	}

	/** Connector status transition → daemon_status broadcast (wired by server.ts). */
	onDaemonStatus(entry: RegistryEntry): void {
		const frame: ServerFrame = {
			type: "daemon_status",
			daemonId: entry.daemonId,
			status: entry.status,
			...(entry.error !== undefined ? { error: entry.error } : {}),
		};
		this.#broadcast(frame);
	}

	/**
	 * Global broadcast: a poll-detected, on-disk worktree removal (the
	 * daemon's cwd vanished between git-state poll ticks). Ringed (default)
	 * so a browser whose stream was down at emit time still gets the toast
	 * once via Last-Event-ID resume — the client's per-prime-window
	 * seenFrameSeqs dedups the replay. Never sent for UI-initiated
	 * delete_worktree/remove.
	 */
	announceWorktreeRemoved(entry: { daemonId: string; name: string; cwd: string }): void {
		this.#broadcast({
			type: "worktree_removed",
			daemonId: entry.daemonId,
			name: entry.name,
			path: entry.cwd,
		});
	}

	/** Detach broadcast wiring and close every browser stream + pipe. */
	close(): void {
		if (this.#registry.onChange === this.#onRegistryChange) {
			this.#registry.onChange = null;
		}
		if (this.#registry.onProjectsChange === this.#onProjectsChange) {
			this.#registry.onProjectsChange = null;
		}
		for (const unsubscribe of this.#daemonTaps.values()) unsubscribe();
		this.#daemonTaps.clear();
		// Edge teardown: release anything the browser-gated watch still holds.
		this.#stopActivityWatch();
		this.#stopKeepalive();
		for (const client of this.#clients.values()) {
			if (client.gcTimer) clearTimeout(client.gcTimer);
		}
		this.#clients.clear();
		for (const stream of [...this.#browsers]) {
			this.#closePipe(stream);
			try {
				stream.controller.close();
			} catch {
				// Ignore; the stream is already gone.
			}
		}
		this.#browsers.clear();
	}

	// ---------------------------------------------------------------------
	// Browser streams
	// ---------------------------------------------------------------------

	/**
	 * Open a browser GET /events SSE response: bind the stream to the
	 * clientId (?client=), prime it (roster + merged daemons, seqs 1..k),
	 * replay the client's ring per Last-Event-ID, and stream live deltas
	 * until the browser goes away. The body's queuing strategy sizes chunks
	 * in bytes so backpressure is measured against the configured cap.
	 */
	#openEventsResponse(req: Request): Response {
		const clientId = new URL(req.url).searchParams.get("client");
		const lastEventId = req.headers.get("last-event-id");
		let stream: BrowserStream | null = null;
		const body = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					const client = this.#bindClient(clientId);
					// Finding #25: a rebind with a STILL-LIVE previous stream (the
					// old EventSource's cancel hasn't fired yet — browser
					// reconnects overlap) must not leave it in #browsers: two
					// live streams for one client would ring every broadcast
					// twice (two seqs) and double-deliver. Close the old
					// stream's controller + pipe and drop its entry first,
					// #dropBrowser-style. The stale cancel that fires later is a
					// no-op thanks to the identity guard in #releaseBrowser.
					const previous = client.stream;
					if (previous) {
						this.#browsers.delete(previous);
						this.#closePipe(previous);
						try {
							previous.controller.close();
						} catch {
							// Already closed/cancelled.
						}
					}
					// The constructor's start callback types the controller as the
					// default/byte union; this stream is built with a default
					// source, so the default controller is the actual runtime type.
					stream = {
						controller: controller as ReadableStreamDefaultController<Uint8Array>,
						unreadEstimate: 0,
						client,
						pipe: null,
					};
					client.stream = stream;
					this.#browsers.add(stream);
					this.#startKeepalive();
					// Priming: roster + merged daemons + registered projects
					// (seqs 1..k, k < SSE_DELTA_SEQ_START).
					let seq = 1;
					this.#enqueue(
						stream,
						encodeSseEvent(
							SSE_EVENT_NAME,
							{
								type: "roster",
								daemons: this.#rosterEntries(),
							},
							seq++,
						),
					);
					this.#enqueue(
						stream,
						encodeSseEvent(
							SSE_EVENT_NAME,
							{ type: "daemons", daemons: this.#daemonsAggregator.merge() },
							seq++,
						),
					);
					this.#enqueue(
						stream,
						encodeSseEvent(
							SSE_EVENT_NAME,
							{
								type: "registered_projects",
								projects: this.#registry.projects(),
								configPath: this.#fleet.configPath,
								// P1.3/P8: the boot-static secret-free profile
								// catalog; omitted entirely when not configured
								// (older fleets imply an empty catalog).
								...(this.#providerProfiles !== undefined
									? { providerProfiles: this.#providerProfiles }
									: {}),
							},
							seq++,
						),
					);
					// Real-time activity priming: one daemon_activity frame per READY
					// daemon with KNOWN derived activity (unknown ones are omitted —
					// their first derivable frame broadcasts live right after the
					// dial below). Edge-local seq, like the rest of the priming group.
					for (const [daemonId, activity] of this.#daemonActivity) {
						if (!activity.known) continue;
						if (this.#registry.get(daemonId)?.status !== "ready") continue;
						this.#enqueue(
							stream,
							encodeSseEvent(
								SSE_EVENT_NAME,
								{
									type: "daemon_activity",
									daemonId,
									streaming: activity.streaming,
									blocked: activity.blocked,
								},
								seq++,
							),
						);
					}
					// Resume: only a delta-era id (≥ SSE_DELTA_SEQ_START) replays
					// the ring; anything below means priming carries full state.
					const last = lastEventId === null ? NaN : Number(lastEventId);
					if (Number.isFinite(last) && last >= SSE_DELTA_SEQ_START) {
						for (const { value } of client.ring.after(last)) this.#enqueue(stream, value);
					}
					// This is now ≥1 open browser stream: retain + dial every ready
					// daemon so its realtime activity stays live (and its idle
					// auto-exit is suspended until the last browser disconnects).
					this.#ensureActivityWatch();
				},
				cancel: () => {
					// The browser went away: close its pipe + release; the
					// client's ring is kept for Last-Event-ID resume.
					if (stream) this.#releaseBrowser(stream);
				},
			},
			{ highWaterMark: this.#backpressureBytes, size: (chunk) => chunk?.byteLength ?? 0 },
		);
		return new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"x-accel-buffering": "no",
			},
		});
	}

	/** Find or create the client state for a stream open (?client= optional). */
	#bindClient(clientId: string | null): BrowserClient {
		if (clientId !== null && clientId !== "") {
			let client = this.#clients.get(clientId);
			if (client) {
				// Reconnect with the same clientId: clear the reclaim timer and
				// rebind — the ring resumes from the browser's Last-Event-ID.
				if (client.gcTimer) {
					clearTimeout(client.gcTimer);
					client.gcTimer = null;
				}
				return client;
			}
			client = newClient(clientId, this.#ringBytes);
			this.#clients.set(clientId, client);
			return client;
		}
		// Anonymous stream: served (priming + broadcasts + ring) but not
		// command-addressable (POST /command needs a client id).
		return newClient(null, this.#ringBytes);
	}

	/**
	 * POST /command: one ClientCommand per request, 202 {commandId} on
	 * accept; answers ride the /events stream only. The X-Omp-Client-Id
	 * header selects the browser stream the command acts on (edge-level
	 * commands answer there; attached-session commands proxy to that
	 * browser's daemon pipe).
	 */
	async #handleCommand(req: Request): Promise<Response> {
		const clientId = req.headers.get("x-omp-client-id");
		const client =
			typeof clientId === "string" && clientId !== "" ? this.#clients.get(clientId) : undefined;
		const stream = client?.stream ?? null;
		if (!stream) {
			return json({ error: "unknown client or not connected" }, 400);
		}
		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return json({ error: "malformed JSON body" }, 400);
		}
		if (
			typeof raw !== "object" ||
			raw === null ||
			!("type" in raw) ||
			typeof raw.type !== "string"
		) {
			return json({ error: "request body must be a JSON object with a string type" }, 400);
		}
		const cmd = raw as Record<string, unknown>;
		const type = cmd.type as string;
		// Phase 6: the mux-era commands and detach are gone from
		// ClientCommand. Any type outside the browser allowlist — a stale
		// client's removed command or plain garbage — is rejected here so
		// the daemon never sees a command it no longer understands.
		if (BROWSER_COMMAND_TYPES[type] !== true) {
			this.#sendError(stream, UNKNOWN_COMMAND_MESSAGE);
			return json({ commandId: cmd.id }, 202);
		}
		switch (type) {
			case "list_projects":
				void this.#handleListProjects(stream);
				break;
			case "list_daemon_sessions": {
				const daemonId =
					typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "list_daemon_sessions: missing daemonId");
					break;
				}
				void this.#handleListDaemonSessions(stream, daemonId);
				break;
			}
			case "list_project_branches": {
				const projectId =
					typeof cmd.projectId === "string" && cmd.projectId !== "" ? cmd.projectId : undefined;
				if (projectId === undefined) {
					this.#sendError(stream, "list_project_branches: missing projectId");
					break;
				}
				void this.#handleListProjectBranches(stream, projectId);
				break;
			}
			case "spawn": {
				const cwd = typeof cmd.cwd === "string" && cmd.cwd !== "" ? cmd.cwd : undefined;
				if (cwd === undefined) {
					this.#sendError(stream, "spawn: missing cwd");
					break;
				}
				const template =
					typeof cmd.template === "string" && cmd.template !== "" ? cmd.template : undefined;
				let labels: string[] | undefined;
				try {
					labels = parseSpawnLabels(cmd.labels);
				} catch (err) {
					this.#sendError(stream, err instanceof Error ? err.message : String(err));
					break;
				}
				void this.#handleSpawn(stream, cwd, template, labels);
				break;
			}
			case "spawn_resume": {
				const daemonId =
					typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "spawn_resume: missing daemonId");
					break;
				}
				const sessionFile =
					typeof cmd.sessionFile === "string" && cmd.sessionFile !== ""
						? cmd.sessionFile
						: undefined;
				void this.#handleSpawnResume(stream, daemonId, sessionFile);
				break;
			}
			case "stop": {
				const daemonId =
					typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "stop: missing daemonId");
					break;
				}
				void this.#handleStop(stream, daemonId);
				break;
			}
			case "remove": {
				const daemonId =
					typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "remove: missing daemonId");
					break;
				}
				void this.#handleRemove(stream, daemonId);
				break;
			}
			case "add_project": {
				const path = typeof cmd.path === "string" && cmd.path !== "" ? cmd.path : undefined;
				if (path === undefined) {
					this.#sendError(stream, "add_project: missing path");
					break;
				}
				const start = cmd.start === true;
				const template =
					typeof cmd.template === "string" && cmd.template !== "" ? cmd.template : undefined;
				let labels: string[] | undefined;
				try {
					labels = parseSpawnLabels(cmd.labels);
				} catch (err) {
					this.#sendError(stream, err instanceof Error ? err.message : String(err));
					break;
				}
				void this.#handleAddProject(stream, path, start, template, labels);
				break;
			}
			case "remove_project": {
				const projectId =
					typeof cmd.projectId === "string" && cmd.projectId !== "" ? cmd.projectId : undefined;
				if (projectId === undefined) {
					this.#sendError(stream, "remove_project: missing projectId");
					break;
				}
				void this.#handleRemoveProject(stream, projectId);
				break;
			}
			case "create_clone": {
				// Frozen contract (docs/clone-contracts.md): projectId/name/
				// profileId required; source (when given) has exactly one of
				// local/remote; revision/branch/start optional.
				const projectId =
					typeof cmd.projectId === "string" && cmd.projectId !== "" ? cmd.projectId : undefined;
				if (projectId === undefined) {
					this.#sendError(stream, "create_clone: missing projectId");
					break;
				}
				const name = typeof cmd.name === "string" && cmd.name !== "" ? cmd.name : undefined;
				if (name === undefined) {
					this.#sendError(stream, "create_clone: missing name");
					break;
				}
				const profileId =
					typeof cmd.profileId === "string" && cmd.profileId !== "" ? cmd.profileId : undefined;
				if (profileId === undefined) {
					this.#sendError(stream, "create_clone: missing profileId");
					break;
				}
				const sourceRaw = cmd.source;
				let source: { local?: string; remote?: string } | undefined;
				if (sourceRaw !== undefined) {
					if (typeof sourceRaw !== "object" || sourceRaw === null || Array.isArray(sourceRaw)) {
						this.#sendError(stream, "create_clone: source must be an object");
						break;
					}
					// Exactly one non-empty member. Read through a checked
					// narrowing: absent/empty members are treated as unset.
					const sourceFields = sourceRaw as Record<string, unknown>;
					const hasLocal = typeof sourceFields.local === "string" && sourceFields.local !== "";
					const hasRemote = typeof sourceFields.remote === "string" && sourceFields.remote !== "";
					if (hasLocal === hasRemote) {
						this.#sendError(stream, "create_clone: source must set exactly one of local or remote");
						break;
					}
					source = hasLocal
						? { local: sourceFields.local as string }
						: { remote: sourceFields.remote as string };
				}
				const revision =
					typeof cmd.revision === "string" && cmd.revision !== "" ? cmd.revision : undefined;
				const branch = typeof cmd.branch === "string" && cmd.branch !== "" ? cmd.branch : undefined;
				const start = cmd.start === true ? true : undefined;
				void this.#handleCreateClone(stream, {
					projectId,
					name,
					profileId,
					...(source !== undefined ? { source } : {}),
					...(revision !== undefined ? { revision } : {}),
					...(branch !== undefined ? { branch } : {}),
					...(start !== undefined ? { start } : {}),
				});
				break;
			}
			case "create_worktree": {
				const projectId =
					typeof cmd.projectId === "string" && cmd.projectId !== "" ? cmd.projectId : undefined;
				if (projectId === undefined) {
					this.#sendError(stream, "create_worktree: missing projectId");
					break;
				}
				const name = typeof cmd.name === "string" && cmd.name !== "" ? cmd.name : undefined;
				if (name === undefined) {
					this.#sendError(stream, "create_worktree: missing name");
					break;
				}
				const baseRef =
					typeof cmd.baseRef === "string" && cmd.baseRef !== "" ? cmd.baseRef : undefined;
				const existingBranch =
					typeof cmd.existingBranch === "string" && cmd.existingBranch !== ""
						? cmd.existingBranch
						: undefined;
				const start = cmd.start === true ? true : undefined;
				void this.#handleCreateWorktree(stream, projectId, name, {
					baseRef,
					existingBranch,
					start,
				});
				break;
			}
			case "add_worktree": {
				const projectId =
					typeof cmd.projectId === "string" && cmd.projectId !== "" ? cmd.projectId : undefined;
				if (projectId === undefined) {
					this.#sendError(stream, "add_worktree: missing projectId");
					break;
				}
				const worktreePath =
					typeof cmd.worktreePath === "string" && cmd.worktreePath !== ""
						? cmd.worktreePath
						: undefined;
				if (worktreePath === undefined) {
					this.#sendError(stream, "add_worktree: missing worktreePath");
					break;
				}
				const start = cmd.start === true ? true : undefined;
				void this.#handleAddWorktree(stream, projectId, worktreePath, start);
				break;
			}
			case "delete_worktree": {
				const daemonId =
					typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "delete_worktree: missing daemonId");
					break;
				}
				const deleteBranch = cmd.deleteBranch === true ? true : undefined;
				void this.#handleDeleteWorktree(stream, daemonId, deleteBranch);
				break;
			}
			case "worktree_delete_info": {
				const daemonId =
					typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "worktree_delete_info: missing daemonId");
					break;
				}
				void this.#handleWorktreeDeleteInfo(stream, daemonId);
				break;
			}
			case "attach": {
				const daemonId =
					typeof cmd.sessionId === "string" && cmd.sessionId !== "" ? cmd.sessionId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "attach: missing sessionId");
					break;
				}
				// The command id keys the attach_result answer (finding #28); a
				// malformed client without one falls back to the legacy error frame.
				const commandId = typeof cmd.id === "string" && cmd.id !== "" ? cmd.id : undefined;
				void this.#handleAttach(stream, daemonId, commandId);
				break;
			}
			default:
				this.#forwardCommand(stream, cmd);
				break;
		}
		return json({ commandId: cmd.id }, 202);
	}

	// ---------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------

	async #handleListProjects(stream: BrowserStream): Promise<void> {
		try {
			// No root scanning: projects are the registered set's unregistered
			// linked worktrees (roster cwds excluded). The registered mains ride
			// the separate registered_projects frame.
			const projects = await mergeUnregisteredWorktrees(
				this.#registry.projects(),
				this.#registry.list().map((entry) => entry.cwd),
			);
			this.#sendAnswer(stream, { type: "projects", projects });
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Answer a roster-dropdown request: the last sessions of one daemon's
	 * worktree, newest-first (the edge lists from disk so asleep/never-started
	 * daemons answer too — no live process needed). Unknown daemon → error.
	 */
	async #handleListDaemonSessions(stream: BrowserStream, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			// Clone sessions list from the fleet transcript store (P8.4 — the
			// owning daemon's session dir lives in the provider volume, never
			// a fleet-local cwd); direct/worktree list from disk so asleep/
			// never-started daemons answer too. Empty list when no store.
			const sessions =
				entry.workspace?.kind === "clone"
					? await listCloneDaemonSessions(this.#logStore, daemonId, DROPDOWN_SESSION_LIMIT)
					: await listDaemonSessions(entry.cwd ?? "", DROPDOWN_SESSION_LIMIT);
			this.#sendAnswer(stream, { type: "daemon_sessions", daemonId, sessions });
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * list_project_branches: unicast answer with the registered project's
	 * local branches + checked-out state, for the add-worktree branch picker.
	 */
	async #handleListProjectBranches(stream: BrowserStream, projectId: string): Promise<void> {
		const project = this.#registry.projects().find((p) => p.projectId === projectId);
		if (!project) {
			this.#sendError(stream, `unknown project: ${projectId}`);
			return;
		}
		try {
			const branches = await listProjectBranches(project.path);
			this.#sendAnswer(stream, { type: "project_branches", projectId, branches });
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleSpawn(
		stream: BrowserStream,
		cwd: string,
		template: string | undefined,
		labels: string[] | undefined,
	): Promise<void> {
		try {
			const resolved = await validateProjectPath(cwd);
			if (resolved === null) {
				this.#sendError(stream, `not a directory: ${cwd}`);
				return;
			}
			// Progress surfaces via roster/daemon_status broadcasts. A cwd
			// belonging to a registered project (main checkout or a linked
			// worktree) is tagged with that projectId so the roster groups the
			// daemon under the project; unregistered paths stay untagged
			// (fallback group).
			const entry = await this.#supervisor.spawn({ cwd: resolved, template, labels });
			const projectId = await projectIdForCwd(this.#registry.projects(), resolved);
			if (projectId !== undefined) this.#registry.update(entry.daemonId, { projectId });
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * add_project: register the project's realpath (registry.addProject
	 * validates + dedups). A dedup answers an error frame naming the
	 * existing projectId. The project's default workspace — a roster entry
	 * for the repo's main checkout mapped to the repo CWD, never a managed
	 * worktree — is registered via registerProjectMainEntry: with start:true
	 * the main checkout is spawned (template/labels passthrough) and the
	 * fresh entry is tagged with the projectId; without it the entry is
	 * created asleep (wakeable via spawn_resume/attach). Success surfaces
	 * via the registered_projects + roster broadcasts, never a unicast.
	 */
	async #handleAddProject(
		stream: BrowserStream,
		path: string,
		start: boolean,
		template: string | undefined,
		labels: string[] | undefined,
	): Promise<void> {
		try {
			const before = this.#registry.projects();
			let project: RegisteredProject;
			try {
				project = await this.#registry.addProject(path);
			} catch (err) {
				this.#sendError(stream, err instanceof Error ? err.message : String(err));
				return;
			}
			if (before.some((p) => p.projectId === project.projectId)) {
				// Dedup: the realpath is already registered.
				this.#sendError(stream, `project already registered: ${project.projectId}`);
				return;
			}
			try {
				await registerProjectMainEntry(this.#registry, this.#supervisor, project, {
					start,
					template,
					labels,
				});
			} catch (err) {
				// The project stays registered; the error names the stage.
				this.#sendError(
					stream,
					`project ${project.projectId} registered, spawn failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return;
			}
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * remove_project: deregister a project (never touches disk); the
	 * never-started default workspace (a provably-empty roster placeholder)
	 * is dropped with it. While any REAL roster entry (something that ever
	 * ran or is remote/attached) references it, registry.removeProject
	 * throws and the error frame names the blocking daemon ids.
	 */
	async #handleRemoveProject(stream: BrowserStream, projectId: string): Promise<void> {
		try {
			this.#registry.removeProject(projectId);
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * create_worktree: git worktree add under workspaceDir for a registered
	 * project (branch = slugified name; existingBranch attaches instead).
	 * With start:true the worktree is spawned (registerWorktreeEntry) —
	 * progress rides the roster/daemon_status broadcasts; the supervisor
	 * only spawns, attach/session-picker are client-side. Staged: a failure
	 * names the stage and leaves prior stages intact (a created-but-
	 * unspawned worktree shows up in discovery / the Add-existing tab).
	 */
	async #handleCreateWorktree(
		stream: BrowserStream,
		projectId: string,
		name: string,
		opts: { baseRef?: string; existingBranch?: string; start?: boolean },
	): Promise<void> {
		const project = this.#registry.projects().find((p) => p.projectId === projectId);
		if (!project) {
			this.#sendError(stream, `unknown project: ${projectId}`);
			return;
		}
		let created: CreateWorktreeResult;
		try {
			created = await createWorktree(project, name, {
				workspaceDir: this.#config.workspaceDir,
				baseRef: opts.baseRef,
				existingBranch: opts.existingBranch,
			});
		} catch (err) {
			this.#sendError(
				stream,
				`create worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}
		try {
			await registerWorktreeEntry(this.#registry, this.#supervisor, project, created.path, {
				start: opts.start,
			});
		} catch (err) {
			this.#sendError(stream, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * create_clone: delegate entirely to the injected lifecycle service (the
	 * SAME create the POST /ctl/clones control-plane route uses — no HTTP
	 * self-proxy, no second lifecycle implementation). Progress + the new
	 * roster entry ride the roster/daemon_status/lifecycleStage broadcasts;
	 * with start:true the lifecycle also ensures the provider compute and
	 * callback pair, so the client's attach follows the same wake path as any
	 * stopped clone. Typed failures surface as an error frame with a
	 * user-safe message.
	 */
	async #handleCreateClone(stream: BrowserStream, input: CreateCloneInput): Promise<void> {
		if (!this.#lifecycle) {
			this.#sendError(stream, "create_clone is unavailable: no lifecycle service wired");
			return;
		}
		try {
			await this.#lifecycle.createClone(input);
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * add_worktree: register a discovered-but-unregistered linked worktree of
	 * the project (validated via validateUnregisteredWorktree) and optionally
	 * spawn a daemon on it (start:true).
	 */
	async #handleAddWorktree(
		stream: BrowserStream,
		projectId: string,
		worktreePath: string,
		start: boolean | undefined,
	): Promise<void> {
		const project = this.#registry.projects().find((p) => p.projectId === projectId);
		if (!project) {
			this.#sendError(stream, `unknown project: ${projectId}`);
			return;
		}
		let resolved: string;
		try {
			resolved = await validateUnregisteredWorktree(
				worktreePath,
				project,
				this.#registry.list().map((e) => e.cwd),
			);
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
			return;
		}
		try {
			await registerWorktreeEntry(this.#registry, this.#supervisor, project, resolved, { start });
		} catch (err) {
			this.#sendError(stream, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * delete_worktree: stop the daemon, evict it from the roster, then git
	 * worktree remove (owned + clean only; optional `git branch -d`). The
	 * guards run BEFORE any mutation, so a refusal leaves the daemon and
	 * roster untouched.
	 */
	async #handleDeleteWorktree(
		stream: BrowserStream,
		daemonId: string,
		deleteBranch: boolean | undefined,
	): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.workspace?.kind === "clone") {
				// Clone delete is the lifecycle's verified P7 gate (admission,
				// quiesce, store verification, read-only flip, provider
				// deletion) — NEVER the git-worktree guards below: they reason
				// about a fleet-local cwd that a clone volume does not have.
				if (!this.#lifecycle) {
					this.#sendError(stream, "clone delete is unavailable: no lifecycle service wired");
					return;
				}
				await this.#lifecycle.deleteClone(daemonId);
				for (const s of this.#browsers) {
					if (s.pipe?.daemonId === daemonId) this.#closePipe(s);
				}
				return;
			}
			const path = entry.cwd ?? "";
			const info = await worktreeDeleteInfo(path, this.#config.workspaceDir);
			if (!info.owned) {
				this.#sendError(stream, info.reason ?? `not a managed worktree: ${path}`);
				return;
			}
			if (info.dirty) {
				this.#sendError(stream, info.reason ?? `worktree has uncommitted changes: ${path}`);
				return;
			}
			// A browser attached to the removed daemon must not keep a live pipe.
			for (const s of this.#browsers) {
				if (s.pipe?.daemonId === daemonId) this.#closePipe(s);
			}
			// Stop + evict (removal-time cleanup: #24 prune drops supervisor state).
			if (entry.mode === "spawned") {
				await this.#supervisor.prune(daemonId);
			} else {
				this.#connector.drop(daemonId);
			}
			// The roster broadcast rides registry.onChange.
			this.#registry.remove(daemonId);
			await deleteWorktree(path, this.#config.workspaceDir, { deleteBranch });
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * worktree_delete_info: answer with the unicast guard-evidence frame
	 * (owned/dirty/branch merge+push state) for the delete confirmation.
	 */
	async #handleWorktreeDeleteInfo(stream: BrowserStream, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.workspace?.kind === "clone") {
				// Clone guard evidence is the lifecycleStage/lifecycleError on
				// the roster entry (the fleet-private WorkspaceDeletion state
				// never crosses this boundary) — not git-worktree guard facts.
				this.#sendError(
					stream,
					"clone deletion guard evidence rides lifecycleStage/lifecycleError",
				);
				return;
			}
			const info = await worktreeDeleteInfo(entry.cwd ?? "", this.#config.workspaceDir);
			this.#sendAnswer(stream, { type: "worktree_delete_info", daemonId, ...info });
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleSpawnResume(
		stream: BrowserStream,
		daemonId: string,
		sessionFile?: string,
	): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.status !== "asleep") {
				this.#sendError(stream, `daemon ${daemonId} is not asleep (status ${entry.status})`);
				return;
			}
			// A dropdown-picked session must belong to this workspace's session
			// listing — never let an arbitrary path/id reach resume. Clones
			// validate against the fleet store's sessionId (the store key is
			// the SDK session id — P8.4), never a fleet-local cwd.
			let resumeFile: string | undefined;
			if (sessionFile !== undefined) {
				if (entry.workspace?.kind === "clone") {
					const listed = await listCloneDaemonSessions(
						this.#logStore,
						daemonId,
						DROPDOWN_SESSION_LIMIT,
					);
					const ok = listed.some((s) => s.id === sessionFile || s.path === sessionFile);
					if (!ok) {
						this.#sendError(stream, `session not in this clone's fleet store: ${sessionFile}`);
						return;
					}
					resumeFile = sessionFile;
				} else {
					const listed = await listDaemonSessions(entry.cwd ?? "", DROPDOWN_SESSION_LIMIT);
					const resolved = realpathOf(sessionFile);
					const ok = listed.some((s) => realpathOf(s.path) === resolved);
					if (!ok) {
						this.#sendError(stream, `session file not in this worktree: ${sessionFile}`);
						return;
					}
					resumeFile = sessionFile;
				}
			}
			await this.#wake(entry, resumeFile);
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleStop(stream: BrowserStream, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.workspace?.kind === "clone") {
				// Clone stop is the lifecycle's proof-bearing provider stop —
				// NEVER the supervisor/connector paths (they do not manage
				// provider compute). Channel teardown happens first so no
				// browser keeps a callback stream against a stopping daemon.
				for (const s of this.#browsers) {
					if (s.pipe?.daemonId === daemonId) this.#closePipe(s);
				}
				if (!this.#lifecycle) {
					this.#sendError(stream, "clone stop is unavailable: no lifecycle service wired");
					return;
				}
				await this.#lifecycle.stopClone(daemonId);
				return;
			}
			// A browser attached to the stopped daemon must not keep a live pipe:
			// its redial would only fail against the dead endpoint and surface a
			// phantom "daemon connection lost" error (mirrors #handleRemove).
			for (const s of this.#browsers) {
				if (s.pipe?.daemonId === daemonId) this.#closePipe(s);
			}
			if (entry.mode === "spawned") {
				try {
					await this.#supervisor.stop(daemonId);
				} catch (err) {
					// Error-safe stop: a failed terminate must not leave the entry
					// "ready" forever — the daemon is being stopped regardless, so
					// flip the status before surfacing the error.
					this.#registry.setStatus(daemonId, "asleep");
					throw err;
				}
			} else {
				this.#connector.disconnect(daemonId);
				this.#registry.setStatus(daemonId, "asleep");
			}
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleRemove(stream: BrowserStream, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.workspace?.kind === "clone") {
				// Clone remove routes through the SAME verified deletion gate
				// as delete (P7) — never registry.remove: dropping the roster
				// identity without verification would orphan or lose the
				// volume/store silently. Browsers detach only AFTER the gate
				// passes, so a gate refusal keeps live attachments intact.
				if (!this.#lifecycle) {
					this.#sendError(stream, "clone remove is unavailable: no lifecycle service wired");
					return;
				}
				await this.#lifecycle.removeClone(daemonId);
				for (const s of this.#browsers) {
					if (s.pipe?.daemonId === daemonId) this.#closePipe(s);
				}
				return;
			}
			// A browser attached to the removed daemon must not keep a live pipe.
			for (const s of this.#browsers) {
				if (s.pipe?.daemonId === daemonId) this.#closePipe(s);
			}
			// #24: prune/drop the per-daemon supervisor/connector state so a
			// removed daemon leaks nothing and pending waitReady() waiters
			// reject immediately instead of hanging until their timeout.
			if (entry.mode === "spawned") {
				await this.#supervisor.prune(daemonId);
			} else {
				this.#connector.drop(daemonId);
			}
			// The entry is gone; the roster broadcast rides registry.onChange.
			this.#registry.remove(daemonId);
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleAttach(
		stream: BrowserStream,
		daemonId: string,
		commandId: string | undefined,
	): Promise<void> {
		const entry = this.#registry.get(daemonId);
		if (!entry) {
			this.#sendAttachOutcome(stream, commandId, { error: `unknown daemon: ${daemonId}` });
			return;
		}
		// Re-attach (same or another daemon) closes the previous pipe first.
		this.#closePipe(stream);
		try {
			await this.#wake(entry);
			// Clone attach readiness is the callback pair's, not the connector's:
			// ensureCloneRunning resolved at provider-running + enrollment (the
			// pair dials in right after) and #openCallbackPipe primes via
			// onPairChange — a connector waitReady would hang against a daemon
			// that has no control socket at all.
			if (entry.workspace?.kind !== "clone") {
				await this.#connector.waitReady(daemonId, ATTACH_WAIT_READY_MS);
			}
		} catch (err) {
			this.#sendAttachOutcome(stream, commandId, {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		const current = this.#registry.get(daemonId);
		if (current?.workspace?.kind !== "clone" && !current?.endpoint) {
			this.#sendAttachOutcome(stream, commandId, { error: `daemon ${daemonId} has no endpoint` });
			return;
		}
		// #openPipe answers the attach: ok once the channel is underway (the
		// direct pipe's resume machinery keeps the attachment alive across
		// drops; the callback stream re-primes on pair replacement), or a
		// keyed failure when it cannot start.
		this.#openPipe(stream, current, commandId);
	}

	// ---------------------------------------------------------------------
	// Proxy pipes
	// ---------------------------------------------------------------------

	/**
	 * Wake a daemon whose control channel is down. Clone-kind entries go
	 * through the lifecycle ensure (provider compute + enrollment; pair
	 * readiness rides the lifecycleStage roster broadcasts and the transport
	 * onPairChange stream_open re-send — never awaited here). Direct/worktree
	 * entries keep the legacy wake: asleep spawned → respawn (--resume),
	 * everything else with a stale socket → redial. Serialized per daemon —
	 * the roster UI sends spawn_resume and attach back-to-back; a second wake
	 * while the first is in flight must not respawn/ensure again.
	 */
	async #wake(entry: RegistryEntry, resumeFile?: string): Promise<void> {
		const daemonId = entry.daemonId;
		if (entry.workspace?.kind === "clone") {
			if (this.#transport?.pairStatus(daemonId).paired === true) return;
			if (this.#lifecycle === undefined || this.#transport === undefined) {
				throw new Error("clone wake is unavailable: no lifecycle/transport wired");
			}
			if (this.#waking.has(daemonId)) return;
			this.#waking.add(daemonId);
			try {
				await this.#lifecycle.ensureCloneRunning(
					daemonId,
					resumeFile && resumeFile.trim() !== "" ? { resumeSessionId: resumeFile } : undefined,
				);
			} finally {
				// Clone wakes settle on resolve — ensureCloneRunning is
				// idempotent, so a back-to-back wake is safe either way.
				this.#waking.delete(daemonId);
			}
			return;
		}
		if (entry.status !== "asleep" && this.#connector.isConnected(daemonId)) return;
		if (this.#waking.has(daemonId)) return;
		this.#waking.add(daemonId);
		try {
			if (entry.mode === "spawned" && entry.status === "asleep") {
				await this.#supervisor.respawn(
					entry,
					resumeFile && resumeFile.trim() !== "" ? { resumeFile } : undefined,
				);
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

	/**
	 * Open this browser's dedicated daemon channel and answer the attach:
	 * ok once the channel is underway — the direct pipe's resume machinery
	 * keeps the attachment alive across drops, and the callback virtual
	 * stream re-primes on every pair replacement (finding #28). Direct daemons
	 * dial their endpoint; clone daemons bind a callback virtual stream — no
	 * inbound dial exists for them (P3.4).
	 */
	#openPipe(stream: BrowserStream, entry: RegistryEntry, commandId?: string): void {
		// A racing attach may have replaced stream.pipe while we waited; never leak it.
		this.#closePipe(stream);
		// The browser may have closed while waitReady was pending; don't open
		// a pipe nobody will close (its retain would pin the connector socket).
		if (!this.#browsers.has(stream)) return;
		if (entry.workspace?.kind === "clone") {
			this.#openCallbackPipe(stream, entry, commandId);
			return;
		}
		const endpoint = entry.endpoint;
		if (!endpoint) {
			this.#sendAttachOutcome(stream, commandId, {
				error: `daemon ${entry.daemonId} has no endpoint`,
			});
			return;
		}
		const pipe: DirectPipeState = {
			mode: "direct",
			daemonId: entry.daemonId,
			abort: new AbortController(),
			retained: false,
			closed: false,
			silenceTimer: null,
			lastSeq: 0,
			redialAttempt: 0,
			reconnectTimer: null,
		};
		stream.pipe = pipe;
		// Attach accepted: the dial below is asynchronous, but from here the
		// pipe's resume machinery owns liveness (redial with Last-Event-ID, or
		// a terminal "daemon connection lost" error frame) — the browser is
		// attached.
		if (commandId !== undefined)
			this.#sendAttachOutcome(stream, commandId, { sessionId: entry.daemonId });
		this.#dialPipe(stream, pipe);
	}

	/**
	 * Bind a browser's attach to a clone daemon's callback virtual stream
	 * ("browser/<connId>", P3.4). The daemon primes + replays per stream: the
	 * edge sends stream_open on bind and after every pair replacement, then
	 * forwards the daemon's frame envelopes verbatim (priming included) to
	 * this browser. Slow browsers are dropped (drop-and-resume, direct-pipe
	 * parity — the transport's 4 MiB stream queue bound fires the sink's
	 * onBackpressure). A torn-down pair surfaces as the same terminal
	 * "daemon connection lost" error frame a direct pipe emits after its
	 * redial budget exhausts; the edge never redials or queues for clones.
	 */
	#openCallbackPipe(stream: BrowserStream, entry: RegistryEntry, commandId?: string): void {
		const daemonId = entry.daemonId;
		const transport = this.#transport;
		if (!transport) {
			this.#sendAttachOutcome(stream, commandId, {
				error: `clone ${daemonId} attach is unavailable: no callback transport wired`,
			});
			return;
		}
		const connId = randomUUID();
		const streamId = `browser/${connId}`;
		const pipe: CallbackPipeState = {
			mode: "callback",
			daemonId,
			connId,
			closed: false,
			lastSeq: 0,
			pairConnectionId: null,
			detach: () => {},
			unsubscribePair: () => {},
		};
		const unsubscribePair = transport.onPairChange(daemonId, () => {
			if (stream.pipe !== pipe || pipe.closed) return;
			this.#sendStreamOpen(pipe);
		});
		pipe.unsubscribePair = unsubscribePair;
		pipe.detach = () => transport.detachVirtualStream(daemonId, streamId);
		stream.pipe = pipe;
		// Attach accepted: the stream is bound below, and from here the
		// transport owns pair liveness (stream_open re-sends on pair change) —
		// the browser is attached. Progress rides the lifecycleStage roster
		// broadcasts; attach_result mirrors the direct pipe's dial-underway ok.
		if (commandId !== undefined)
			this.#sendAttachOutcome(stream, commandId, { sessionId: daemonId });
		const sink: VirtualStreamSink = {
			deliver: (envelope) => {
				if (stream.pipe !== pipe || pipe.closed) return;
				this.#onCallbackEnvelope(stream, pipe, envelope);
			},
			onBackpressure: () => {
				// Transport dropped an envelope on this stream's full 4 MiB
				// queue: drop-and-resume (direct-pipe parity). The ring + the
				// client's Last-Event-ID resume close the gap.
				if (stream.pipe === pipe && !pipe.closed) this.#dropBrowser(stream);
			},
		};
		transport.attachVirtualStream(daemonId, streamId, sink);
		if (stream.pipe !== pipe || pipe.closed) {
			pipe.detach();
			pipe.unsubscribePair();
			return;
		}
		// Pair already live at bind: prime now; onPairChange handles later
		// replacements (and the very first pair-ready when ensure returned
		// before the daemon dialed).
		if (transport.pairStatus(daemonId).paired) this.#sendStreamOpen(pipe);
	}

	/** Send stream_open on this browser's callback stream (prime / re-prime).
	 * lastSeq is omitted on pair replacement — the per-connection daemon seq
	 * space restarts, so the daemon re-primes from its ring head. */
	#sendStreamOpen(pipe: CallbackPipeState): void {
		const transport = this.#transport;
		if (!transport || pipe.closed) return;
		const status = transport.pairStatus(pipe.daemonId);
		if (!status.paired || status.connectionId === null) return;
		if (pipe.pairConnectionId !== status.connectionId) {
			// New pair: its seq space is fresh — never send a stale lastSeq.
			pipe.pairConnectionId = status.connectionId;
			pipe.lastSeq = 0;
		}
		transport
			.sendToDaemon(pipe.daemonId, {
				streamId: `browser/${pipe.connId}`,
				kind: "control",
				payload: {
					type: "stream_open",
					...(pipe.lastSeq > 0 ? { lastSeq: pipe.lastSeq } : {}),
				},
			})
			.catch(() => {
				// No live pair / send failure: onPairChange re-sends once the
				// pair is (re)established. Never queues or retries blindly.
			});
	}

	/** Route one callback envelope from a browser's clone stream: frame
	 * envelopes forward verbatim (daemon priming + deltas); stream_resync
	 * controls surface as a stream_reset so the client re-primes; ack /
	 * command / heartbeat are ignored (receipt-only, wrong-direction, or
	 * transport liveness). */
	#onCallbackEnvelope(
		stream: BrowserStream,
		pipe: CallbackPipeState,
		envelope: CallbackEnvelope,
	): void {
		if (envelope.kind !== "frame" && envelope.kind !== "control") return;
		if (Number.isFinite(envelope.seq) && envelope.seq > pipe.lastSeq) pipe.lastSeq = envelope.seq;
		if (envelope.kind === "control") {
			const payload = envelope.payload;
			if (typeof payload === "object" && payload !== null && "type" in payload) {
				if (payload.type === "stream_resync") {
					// The daemon dropped frames on ITS outbound buffer and pushes a
					// fresh snapshot after this marker — mirror the direct pipe's
					// stream_reset so the client re-primes (never a silent gap).
					this.#sendDelta(stream, { type: "stream_reset" });
				}
			}
			return;
		}
		const payload = envelope.payload;
		if (typeof payload !== "object" || payload === null) return;
		this.#onPipeFrame(stream, pipe, payload as Record<string, unknown>);
	}

	/**
	 * One /events dial (initial or redial). Superseded-dial guard: a fetch
	 * that resolved after a newer dial/drop is aborted and ignored. A redial
	 * carries Last-Event-ID = the last forwarded daemon seq — delta-era only
	 * (≥ SSE_DELTA_SEQ_START); anything below means the daemon's full
	 * priming re-derives current state anyway. 401 (wrong credential) and
	 * proto mismatch are terminal, like the connector.
	 */
	#dialPipe(stream: BrowserStream, pipe: DirectPipeState): void {
		const entry = this.#registry.get(pipe.daemonId);
		const endpoint = entry?.endpoint;
		if (!endpoint) {
			// Redial impossible (daemon removed / never had an endpoint).
			this.#pipeLost(stream, pipe);
			return;
		}
		const headers: Record<string, string> = {};
		if (entry.token) headers.Authorization = `Bearer ${entry.token}`;
		if (pipe.lastSeq >= SSE_DELTA_SEQ_START) headers["Last-Event-ID"] = String(pipe.lastSeq);
		const abort = new AbortController();
		pipe.abort = abort;
		fetch(daemonHttpBase(endpoint) + "/events", { headers, signal: abort.signal })
			.then((res) => {
				if (stream.pipe !== pipe || pipe.closed) {
					abort.abort();
					return;
				}
				if (res.status === 401) {
					// Wrong credential: terminal — only a respawn (via the
					// connector's onDialFailed) refreshes the token.
					res.body?.cancel().catch(() => {});
					this.#pipeLost(stream, pipe, "unauthorized (401): daemon rejected the token");
					return;
				}
				if (!res.ok || !res.body) {
					this.#pipeEnded(stream, pipe);
					return;
				}
				// The pipe is live: feed the connector's idle policy (once per
				// pipe lifetime — a redial must not double-retain).
				if (!pipe.retained) {
					pipe.retained = true;
					this.#connector.retain(pipe.daemonId);
				}
				this.#armPipeSilence(pipe);
				void this.#consumePipe(stream, pipe, res);
			})
			.catch(() => {
				if (stream.pipe !== pipe || pipe.closed) return; // superseded or dropped
				this.#pipeEnded(stream, pipe);
			});
	}

	async #consumePipe(stream: BrowserStream, pipe: DirectPipeState, res: Response): Promise<void> {
		try {
			for await (const unit of parseSseUnits(res.body!)) {
				if (stream.pipe !== pipe || pipe.closed) return; // superseded or dropped
				// Any unit — event or keepalive — proves the daemon lives:
				// re-arm the silence deadline and reset the redial budget.
				this.#armPipeSilence(pipe);
				pipe.redialAttempt = 0;
				if (unit.kind !== "event") continue;
				if (unit.event === SSE_PING_EVENT) continue; // keepalive: no id, not a delta
				if (unit.event !== SSE_EVENT_NAME) continue;
				// Track the daemon's own seqs so a redial resumes via Last-Event-ID.
				const seq = Number(unit.id);
				if (Number.isFinite(seq) && seq > pipe.lastSeq) pipe.lastSeq = seq;
				this.#onPipeFrame(stream, pipe, unit.data);
			}
		} catch {
			if (stream.pipe !== pipe || pipe.closed) return;
			this.#pipeEnded(stream, pipe);
			return;
		}
		if (stream.pipe !== pipe || pipe.closed) return;
		// Clean end (dormant daemon / server close): non-intentional — resume.
		this.#pipeEnded(stream, pipe);
	}

	/**
	 * Forward a session frame from this browser's attached daemon channel:
	 * proto-gate then forward hello_ok (finding #61 — the browser's own gate
	 * needs it in roster mode), tap and strip per-daemon broker rosters;
	 * STAMP sessionId = daemonId on every session-scoped frame (omp-session
	 * no longer sends one) and on `attached` (its required "s1" must read as
	 * the daemonId through the edge). Global frames pass unchanged. Every
	 * forwarded frame is an edge-local delta for this browser (a fresh seq;
	 * RINGED only for the daemon's delta types — see #sendDelta —
	 * recoverable via Last-Event-ID; unringed priming/answer frames are
	 * re-derived on re-attach). Direct pipes pass a raw SSE data string
	 * (parsed here); callback streams pass the already-parsed frame object
	 * (the envelope payload is verbatim JSON). Shared by both transports so
	 * session semantics stay identical.
	 */
	#onPipeFrame(
		stream: BrowserStream,
		pipe: PipeState,
		data: string | Record<string, unknown>,
	): void {
		let raw: unknown;
		if (typeof data === "string") {
			try {
				raw = JSON.parse(data);
			} catch {
				return; // non-JSON noise
			}
		} else {
			raw = data;
		}
		if (typeof raw !== "object" || raw === null) return;
		const frame = raw as Record<string, unknown>;
		if (frame.type === "hello_ok") {
			// Proto gate (mirrors the connector): a daemon speaking a
			// different OMP_PROTO is not drivable — the channel is terminal.
			if (Number(frame.proto) !== OMP_PROTO) {
				if (isDirectPipe(pipe)) {
					this.#pipeLost(
						stream,
						pipe,
						`proto mismatch: daemon speaks OMP_PROTO ${String(frame.proto)}, expected ${OMP_PROTO}`,
					);
				} else {
					// Callback channel: the transport owns the pair; surface the
					// terminal error to the browser and detach this stream.
					this.#callbackLost(
						stream,
						pipe,
						`proto mismatch: daemon speaks OMP_PROTO ${String(frame.proto)}, expected ${OMP_PROTO}`,
					);
				}
				return;
			}
			// Finding #61: the gate above proved proto === OMP_PROTO, so
			// forwarding the daemon's REAL hello_ok gives the browser's own
			// proto check something to run against in roster mode too (the
			// edge's priming is roster + daemons only). Falls through to the
			// stamping + #sendDelta below like any other global frame.
		}
		if (frame.type === "daemons") {
			// Broker rosters are tapped here (like the control socket) but
			// NEVER forwarded: browsers only ever see the edge's single
			// merged frame (#broadcastDaemons).
			if (Array.isArray(frame.daemons))
				this.#ingestDaemons(pipe.daemonId, frame.daemons as DaemonInfo[]);
			return;
		}
		if (frame.type === "daemon_activity") {
			// daemon_activity is edge-generated and fleet-scoped: daemons never
			// send it, but strip it like `daemons` broker rosters if one ever
			// does — the edge owns the only activity frame browsers see.
			return;
		}
		const stamped =
			SESSION_SCOPED_FRAME_TYPES[String(frame.type)] === true || frame.type === "attached"
				? { ...frame, sessionId: pipe.daemonId }
				: frame;
		this.#sendDelta(stream, stamped);
	}

	/**
	 * The daemon pipe ended non-intentionally (silence, error, clean close,
	 * or a failed dial): schedule a Last-Event-ID redial so the browser stays
	 * attached. The stale silence timer dies with the ended stream — a fresh
	 * dial arms its own — so a late fire can't abort the redial. Only a
	 * terminal outcome — budget exhausted, or the redial being impossible —
	 * falls through to #pipeLost (finding #4). Callback pipes never redial:
	 * the transport owns pair liveness (P3.4), so this is unreachable for
	 * them by construction.
	 */
	#pipeEnded(stream: BrowserStream, pipe: DirectPipeState): void {
		if (pipe.closed) return; // intentional teardown already handled
		if (stream.pipe !== pipe) return; // superseded by a newer pipe
		this.#clearPipeSilence(pipe);
		if (pipe.redialAttempt >= this.#pipeMaxRedials) {
			this.#pipeLost(stream, pipe);
			return;
		}
		this.#schedulePipeRedial(stream, pipe);
	}

	/** Jittered bounded backoff, connector-style; the budget resets on any live unit. */
	#schedulePipeRedial(stream: BrowserStream, pipe: DirectPipeState): void {
		if (pipe.reconnectTimer) return;
		const attempt = pipe.redialAttempt++;
		const delay = backoffDelay(attempt, this.#pipeBackoffMinMs, this.#pipeBackoffMaxMs);
		pipe.reconnectTimer = setTimeout(() => {
			pipe.reconnectTimer = null;
			if (pipe.closed || stream.pipe !== pipe) return; // torn down / superseded
			this.#dialPipe(stream, pipe);
		}, delay);
	}

	/** The pipe is gone for good (budget exhausted / 401 / proto mismatch / redial impossible): release + report lost. */
	#pipeLost(
		stream: BrowserStream,
		pipe: DirectPipeState,
		message = "daemon connection lost",
	): void {
		if (pipe.closed) return; // intentional teardown already released
		pipe.closed = true;
		this.#clearPipeSilence(pipe);
		if (pipe.reconnectTimer) {
			clearTimeout(pipe.reconnectTimer);
			pipe.reconnectTimer = null;
		}
		if (stream.pipe === pipe) stream.pipe = null;
		this.#releaseRetain(pipe);
		this.#sendError(stream, message);
	}

	/** A callback channel is gone for good: detach the stream and report lost. */
	#callbackLost(
		stream: BrowserStream,
		pipe: CallbackPipeState,
		message = "daemon connection lost",
	): void {
		if (pipe.closed) return; // intentional teardown already released
		pipe.closed = true;
		if (stream.pipe === pipe) stream.pipe = null;
		pipe.detach();
		pipe.unsubscribePair();
		this.#sendError(stream, message);
	}

	/** Intentional pipe teardown (browser close / re-attach / removal): release + abort (direct) or detach (callback). */
	#closePipe(stream: BrowserStream): void {
		const pipe = stream.pipe;
		if (!pipe) return;
		stream.pipe = null;
		pipe.closed = true;
		if (isDirectPipe(pipe)) {
			this.#clearPipeSilence(pipe);
			if (pipe.reconnectTimer) {
				clearTimeout(pipe.reconnectTimer);
				pipe.reconnectTimer = null;
			}
			this.#releaseRetain(pipe);
			try {
				pipe.abort.abort();
			} catch {
				// Ignore; the pipe is already gone.
			}
			return;
		}
		// Callback: tell the daemon the stream closed, then unbind. Best
		// effort — a missing pair (stop/delete already tore it down) makes
		// sendToDaemon throw, which is fine: the detach below is the
		// authority, and the daemon GCs orphan streams itself.
		this.#transport
			?.sendToDaemon(pipe.daemonId, {
				streamId: `browser/${pipe.connId}`,
				kind: "control",
				payload: { type: "stream_close" },
			})
			.catch(() => {});
		pipe.detach();
		pipe.unsubscribePair();
	}

	#releaseRetain(pipe: DirectPipeState): void {
		if (!pipe.retained) return;
		pipe.retained = false;
		this.#connector.release(pipe.daemonId);
	}

	/**
	 * Forward a non-edge command to the attached daemon: direct daemons get
	 * POST /command (fire-and-forget accept; answers ride the pipe's /events
	 * stream); clone daemons get a kind:"command" envelope on their callback
	 * stream (same POST /command body; answers ride the stream's frame
	 * envelopes — P3.4). A missing/unattached channel fails fast BY ID
	 * (finding #59: the client correlates call() promises only with
	 * call_result, so a bare error frame would leave the promise hanging
	 * until its 30s timeout). No offline queue: a callback send failure
	 * answers the same typed not-attached error.
	 */
	#forwardCommand(stream: BrowserStream, cmd: Record<string, unknown>): void {
		const pipe = stream.pipe;
		const entry = pipe ? this.#registry.get(pipe.daemonId) : undefined;
		const failNotAttached = (): void => {
			const commandId = typeof cmd.id === "string" && cmd.id !== "" ? cmd.id : undefined;
			if (commandId !== undefined) {
				this.#sendAnswer(stream, {
					type: "call_result",
					id: commandId,
					ok: false,
					error: "not attached",
				});
			} else {
				this.#sendError(stream, "not attached");
			}
		};
		if (isDirectPipe(pipe)) {
			if (!entry?.endpoint) {
				failNotAttached();
				return;
			}
			// Fire-and-forget accept: answers ride the pipe's /events stream (and
			// thus this browser's). A dropped POST is recovered by the browser's
			// pending-map timeout + re-send; the daemon dedups by command id.
			fetch(daemonHttpBase(entry.endpoint) + "/command", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${entry.token ?? ""}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(cmd),
			}).catch(() => {
				// Ignore: the pipe's silence deadline owns daemon liveness.
			});
			return;
		}
		if (pipe?.mode !== "callback") {
			failNotAttached();
			return;
		}
		this.#transport
			?.sendToDaemon(pipe.daemonId, {
				streamId: `browser/${pipe.connId}`,
				kind: "command",
				payload: cmd,
			})
			.catch(failNotAttached);
	}

	/** Reset the pipe's silence deadline; every SSE unit (event or comment) re-arms it. */
	#armPipeSilence(pipe: DirectPipeState): void {
		this.#clearPipeSilence(pipe);
		pipe.silenceTimer = setTimeout(() => {
			pipe.silenceTimer = null;
			// Dead daemon pipe: no event/comment within the deadline. Abort the
			// stream; the consume loop's error path drives #pipeLost.
			pipe.abort.abort();
		}, this.#silenceDeadlineMs);
	}

	#clearPipeSilence(pipe: DirectPipeState): void {
		if (pipe.silenceTimer) {
			clearTimeout(pipe.silenceTimer);
			pipe.silenceTimer = null;
		}
	}

	// ---------------------------------------------------------------------
	// Sending + broadcasting
	// ---------------------------------------------------------------------

	/** Bytes currently buffered on a browser stream (the queue is byte-sized via the stream's queuing strategy). */
	#bufferedBytes(stream: BrowserStream): number {
		const desired = stream.controller.desiredSize;
		if (desired === null) return stream.unreadEstimate;
		if (stream.unreadEstimate > 0) stream.unreadEstimate = 0;
		return Math.max(0, this.#backpressureBytes - desired);
	}

	/** Enqueue one pre-encoded block; past the backpressure cap the stream is terminated (drop-and-resume). */
	#enqueue(stream: BrowserStream, block: string): void {
		try {
			if (shouldDropFrame(this.#bufferedBytes(stream) + block.length, this.#backpressureBytes)) {
				this.#dropBrowser(stream);
				return;
			}
			stream.unreadEstimate += block.length;
			stream.controller.enqueue(SSE_ENCODER.encode(block));
		} catch {
			// Stream already closed/cancelled: dropped (removal happens on cancel/drop).
		}
	}

	/**
	 * One live daemon-pipe frame as an edge-local delta: RINGED only when the
	 * daemon would ring it (mirror of its RING_DELTAS, finding #5) — priming
	 * frames (hello_ok, attached, history, available_commands), unicast
	 * answers (call_result) and per-stream lifecycle (stream_reset) are
	 * re-derivable (re-attach priming / re-POST) and consume a seq but no
	 * ring entry, exactly like the daemon's delta counter. A resuming
	 * browser's ring replay therefore has the same deliberate gaps and is
	 * still correct: after() returns only ringed entries newer than the
	 * Last-Event-ID, and the client re-attaches on every reconnect open,
	 * re-deriving anything the ring never held.
	 */
	#sendDelta(stream: BrowserStream, frame: unknown): void {
		const client = stream.client;
		const seq = client.nextSeq++;
		const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
		const type = (frame as { type?: unknown } | null)?.type;
		if (typeof type === "string" && EDGE_RING_DELTAS[type]) client.ring.push(seq, block);
		this.#enqueue(stream, block);
	}

	/**
	 * Ring one client's copy of a broadcast; deliver when its stream is
	 * live. `ring: false` still advances the client seq (like priming and
	 * unicast answers) but leaves no ring entry — the frame must be
	 * re-derivable from the next open's priming.
	 */
	#broadcastTo(client: BrowserClient, frame: ServerFrame, ring = true): void {
		const seq = client.nextSeq++;
		const block = encodeSseEvent(SSE_EVENT_NAME, frame, seq);
		if (ring) client.ring.push(seq, block);
		if (client.stream) this.#enqueue(client.stream, block);
	}

	/** Unicast answer (projects / error): fresh seq but NOT ringed (lost answers are re-POSTed). */
	#sendAnswer(stream: BrowserStream, frame: unknown): void {
		const seq = stream.client.nextSeq++;
		this.#enqueue(stream, encodeSseEvent(SSE_EVENT_NAME, frame, seq));
	}

	#sendError(stream: BrowserStream, error: string): void {
		this.#sendAnswer(stream, { type: "error", error });
	}

	/**
	 * Answer an attach command (finding #28): an id-keyed attach_result
	 * unicast when the command carried an id (new clients settle their
	 * pending attach from exactly this frame); a legacy global error frame
	 * for a malformed client that sent none.
	 */
	#sendAttachOutcome(
		stream: BrowserStream,
		commandId: string | undefined,
		outcome: { sessionId: string } | { error: string },
	): void {
		if (commandId === undefined) {
			this.#sendError(
				stream,
				"error" in outcome ? outcome.error : `attached: ${outcome.sessionId}`,
			);
			return;
		}
		this.#sendAnswer(
			stream,
			"error" in outcome
				? { type: "attach_result", id: commandId, ok: false, error: outcome.error }
				: { type: "attach_result", id: commandId, ok: true, sessionId: outcome.sessionId },
		);
	}

	/**
	 * Broadcast one frame to every browser. Named clients ring EVERY delta —
	 * also while disconnected — so a Last-Event-ID resume replays the gap;
	 * anonymous streams ring only what they receive (no resume contract).
	 * `ring: false` skips the ring (re-derivable frames only, e.g.
	 * registered_projects).
	 */
	#broadcast(frame: ServerFrame, opts?: { ring?: boolean }): void {
		const ring = opts?.ring ?? true;
		for (const stream of this.#browsers) this.#broadcastTo(stream.client, frame, ring);
		for (const client of this.#clients.values()) {
			if (client.stream === null) this.#broadcastTo(client, frame, ring);
		}
	}

	#broadcastRoster(): void {
		this.#broadcast({
			type: "roster",
			daemons: this.#rosterEntries(),
		});
	}

	/**
	 * Clone stored-history resolver for the roster projection (S2). Memoized
	 * for {@link CLONE_HISTORY_TTL_MS}: the projection runs on EVERY roster
	 * broadcast (registry change, activity, status flips) while the read behind
	 * `cloneStoredHistory` walks `logs/<workspaceId>` and stats each session
	 * subtree. Without the cache a busy fleet would re-walk the store many
	 * times per second; with it each clone costs at most one walk per TTL
	 * window. Display enrichment only — the registry stays the truth.
	 */
	readonly #cloneHistoryFor = (daemonId: string): CloneHistoryInfo => {
		const now = Date.now();
		const cached = this.#cloneHistory.get(daemonId);
		if (cached !== undefined && now - cached.at < CLONE_HISTORY_TTL_MS) return cached.info;
		const info = cloneStoredHistory(this.#logStore, daemonId);
		this.#cloneHistory.set(daemonId, { at: now, info });
		return info;
	};

	/** Roster projection: registry entries + clone stored-history enrichment. */
	#rosterEntries(): DaemonEntry[] {
		// Drop cache keys for clones that left the roster so the TTL map tracks
		// the live roster, not process history.
		for (const key of this.#cloneHistory.keys()) {
			if (this.#registry.get(key) === undefined) this.#cloneHistory.delete(key);
		}
		return this.#registry
			.list()
			.map((entry) => toRosterEntry(entry, this.#config.workspaceDir, this.#cloneHistoryFor));
	}

	/** Broadcast the current registered-project set to every edge stream. */
	#broadcastRegisteredProjects(): void {
		// Never ringed: the frame is re-derivable from the next open's
		// priming (which always carries the full project set).
		this.#broadcast(
			{
				type: "registered_projects",
				projects: this.#registry.projects(),
				configPath: this.#fleet.configPath,
				...(this.#providerProfiles !== undefined
					? { providerProfiles: this.#providerProfiles }
					: {}),
			},
			{ ring: false },
		);
	}

	/**
	 * Drop-and-resume: a browser stream past the backpressure cap is
	 * terminated (buffered data still flushes; the browser reconnects with
	 * Last-Event-ID and the edge replays its ring). The client state (ring)
	 * survives for the resume; the pipe is closed + released.
	 */
	#dropBrowser(stream: BrowserStream): void {
		this.#browsers.delete(stream);
		this.#closePipe(stream);
		// Identity guard (finding #25): a STALE stream's late teardown (its
		// cancel fired after a rebind installed a replacement) must not
		// clobber the client's current stream reference.
		if (stream.client.stream === stream) stream.client.stream = null;
		this.#armClientReclaim(stream.client);
		try {
			stream.controller.close();
		} catch {
			// Already closed/cancelled.
		}
		if (this.#browsers.size === 0) {
			this.#stopKeepalive();
			// Last browser gone: release every retained ready daemon so the
			// connector's idle-drop re-arms and each daemon's idle auto-exit resumes.
			this.#stopActivityWatch();
		}
	}

	/** The browser's stream ended (client cancel): close pipe + release; keep the ring for resume. */
	#releaseBrowser(stream: BrowserStream): void {
		this.#browsers.delete(stream);
		this.#closePipe(stream);
		// Identity guard (finding #25): the cancel of a stream already
		// superseded by a rebind must not null the client's NEW stream.
		if (stream.client.stream === stream) stream.client.stream = null;
		this.#armClientReclaim(stream.client);
		if (this.#browsers.size === 0) {
			this.#stopKeepalive();
			this.#stopActivityWatch();
		}
	}

	/** After a disconnect the client's ring is kept for a grace period, then reclaimed. */
	#armClientReclaim(client: BrowserClient): void {
		if (client.clientId === null) return; // anonymous: no map entry to reclaim
		if (client.gcTimer) {
			clearTimeout(client.gcTimer);
			client.gcTimer = null;
		}
		client.gcTimer = setTimeout(() => {
			client.gcTimer = null;
			if (client.stream === null) this.#clients.delete(client.clientId!);
		}, CLIENT_RECLAIM_MS);
	}

	#startKeepalive(): void {
		if (this.#keepaliveTimer) return;
		this.#keepaliveTimer = setInterval(() => {
			for (const stream of [...this.#browsers]) this.#enqueue(stream, SSE_PING_BLOCK);
		}, SSE_KEEPALIVE_MS);
	}

	#stopKeepalive(): void {
		if (!this.#keepaliveTimer) return;
		clearInterval(this.#keepaliveTimer);
		this.#keepaliveTimer = null;
	}

	// ---------------------------------------------------------------------
	// Aggregated daemons panel
	// ---------------------------------------------------------------------

	/**
	 * Keep a frame tap on every registered daemon and drop taps for removed
	 * ones (evicting their cached rosters). Direct/worktree daemons are
	 * tapped on their connector control socket; clone daemons on the
	 * callback pair's mirrored "control" stream (the daemon broadcasts the
	 * same session frames there — P3.4). Idempotent; runs on every registry
	 * change and once at construction.
	 */
	#reconcileDaemonTaps(): void {
		const live = new Set(this.#registry.list().map((entry) => entry.daemonId));
		let evicted = false;
		for (const [daemonId, unsubscribe] of this.#daemonTaps) {
			if (live.has(daemonId)) continue;
			unsubscribe();
			this.#daemonTaps.delete(daemonId);
			this.#daemonsAggregator.remove(daemonId);
			// A removed daemon's activity is gone too — never primed, never broadcast.
			this.#daemonActivity.delete(daemonId);
			evicted = true;
		}
		for (const entry of this.#registry.list()) {
			if (this.#daemonTaps.has(entry.daemonId)) continue;
			const handleFrame = (frame: ServerFrame): void => {
				// Derive realtime activity from the RAW daemon frames — the tap
				// sees them BEFORE the edge stamps sessionId on proxy pipes, and
				// never reads daemon_activity back (daemons never send it; the
				// pipe forwarder strips it like `daemons` broker rosters).
				switch (frame.type) {
					case "daemons":
						if (Array.isArray(frame.daemons)) this.#ingestDaemons(entry.daemonId, frame.daemons);
						break;
					case "state":
						this.#setActivity(entry.daemonId, {
							streaming: frame.state?.isStreaming === true,
						});
						break;
					case "ui_request": {
						const activity = this.#ensureActivity(entry.daemonId);
						if (activity.openDialogIds.has(frame.id)) break; // replay of the same open
						activity.openDialogIds.add(frame.id);
						this.#setActivity(entry.daemonId, { blocked: true });
						break;
					}
					case "ui_request_end": {
						const activity = this.#daemonActivity.get(entry.daemonId);
						if (activity && activity.openDialogIds.delete(frame.id)) {
							this.#setActivity(entry.daemonId, {
								blocked: activity.openDialogIds.size > 0,
							});
						}
						break;
					}
					default:
						break;
				}
			};
			if (entry.workspace?.kind === "clone" && this.#transport) {
				// Clone taps subscribe to the daemon's mirrored broadcast
				// stream. The composite unsubscribe tears down both the
				// envelope tap and its activity broadcast on eviction.
				const transport = this.#transport;
				this.#daemonTaps.set(
					entry.daemonId,
					transport.onDaemonEnvelope(entry.daemonId, (envelope) => {
						if (envelope.kind !== "frame" || envelope.streamId !== CALLBACK_CONTROL_STREAM_ID)
							return;
						const payload = envelope.payload;
						if (typeof payload === "object" && payload !== null) {
							handleFrame(payload as ServerFrame);
						}
					}),
				);
				continue;
			}
			this.#daemonTaps.set(entry.daemonId, this.#connector.onFrame(entry.daemonId, handleFrame));
		}
		if (evicted) this.#broadcastDaemons();
	}

	/** Get-or-create a daemon's activity state (starts UNKNOWN). */
	#ensureActivity(daemonId: string): DaemonActivity {
		let activity = this.#daemonActivity.get(daemonId);
		if (!activity) {
			activity = { known: false, streaming: false, blocked: false, openDialogIds: new Set() };
			this.#daemonActivity.set(daemonId, activity);
		}
		return activity;
	}

	/**
	 * Merge one dimension of a daemon's activity and broadcast ONLY on an
	 * actual change (unknown→known counts as a change so the first derivable
	 * frame always surfaces). Not broadcast on removal — the roster status
	 * change dominates the row client-side.
	 */
	#setActivity(daemonId: string, patch: { streaming?: boolean; blocked?: boolean }): void {
		const activity = this.#ensureActivity(daemonId);
		const changed =
			!activity.known ||
			(patch.streaming !== undefined && patch.streaming !== activity.streaming) ||
			(patch.blocked !== undefined && patch.blocked !== activity.blocked);
		if (patch.streaming !== undefined) activity.streaming = patch.streaming;
		if (patch.blocked !== undefined) activity.blocked = patch.blocked;
		activity.known = true;
		if (!changed) return;
		this.#broadcastActivity(daemonId);
	}

	/**
	 * Broadcast one daemon_activity frame to every edge stream. NEVER ringed
	 * (like registered_projects): the frame is re-derivable from the next
	 * open's priming, and a ring replay after priming would regress the
	 * client to a stale value.
	 */
	#broadcastActivity(daemonId: string): void {
		const activity = this.#daemonActivity.get(daemonId);
		if (!activity) return;
		// A removed daemon's tap is gone, but be defensive: never broadcast
		// activity for an id the edge no longer manages.
		if (!this.#registry.get(daemonId)) return;
		this.#broadcast(
			{
				type: "daemon_activity",
				daemonId,
				streaming: activity.streaming,
				blocked: activity.blocked,
			},
			{ ring: false },
		);
	}

	/**
	 * Delete-gate admission signal (P7.3): the derived realtime activity of
	 * one daemon. UNKNOWN (known:false) until the first derivable frame — a
	 * daemon with no observed activity cannot be proven idle, so callers
	 * refuse deletion while it is live. `live` reports whether the daemon's
	 * transport channel is currently up: the connector socket for direct/
	 * worktree daemons, the callback pair for clones (P3.4 — the fleet
	 * cannot observe a clone's accepted work any other way). Read-only:
	 * never mutates.
	 */
	daemonActivity(daemonId: string): {
		streaming: boolean;
		blocked: boolean;
		known: boolean;
		live: boolean;
	} {
		const entry = this.#registry.get(daemonId);
		const live =
			entry !== undefined
				? entry.workspace?.kind === "clone"
					? (this.#transport?.pairStatus(daemonId).paired ?? false)
					: this.#connector.isConnected(daemonId)
				: false;
		const activity = this.#daemonActivity.get(daemonId);
		if (!activity) return { streaming: false, blocked: false, known: false, live };
		return {
			streaming: activity.streaming,
			blocked: activity.blocked,
			known: activity.known,
			live,
		};
	}

	/**
	 * Browser-gated retain-all: while ≥1 browser /events stream is open, every
	 * READY registry daemon keeps a LIVE connector stream (retained so the
	 * idle-drop is suspended, dialed so frames flow) so its realtime activity
	 * stays derivable. Never dials non-ready entries — dialing an asleep
	 * spawned daemon would redial-loop it into `reconnecting`. connect() is a
	 * no-op when a stream is already open or a dial is in flight.
	 */
	#ensureActivityWatch(): void {
		if (this.#browsers.size === 0) return;
		for (const entry of this.#registry.list()) {
			if (entry.status !== "ready") continue;
			// Clone liveness is the callback pair's (P3.4): the connector
			// neither retains nor dials them — nothing to suspend or dial.
			if (entry.workspace?.kind === "clone") continue;
			if (!this.#watchedReady.has(entry.daemonId)) {
				this.#watchedReady.add(entry.daemonId);
				this.#connector.retain(entry.daemonId);
			}
			this.#connector.connect(entry.daemonId);
		}
	}

	/**
	 * Release + forget every retained ready daemon. connector.release() re-arms
	 * the idle-drop at zero subscribers, so each daemon's own idle auto-exit
	 * timer resumes — the deliberate accepted consequence of browser-gated
	 * retention (see docs/architecture.md).
	 */
	#stopActivityWatch(): void {
		for (const daemonId of this.#watchedReady) this.#connector.release(daemonId);
		this.#watchedReady.clear();
	}

	/**
	 * Reconcile the browser-gated retain set against the CURRENT registry
	 * (ready = the live set): release+forget entries that left ready
	 * (asleep/error/removed), retain+dial entries that newly reached ready.
	 * Each daemon is released exactly once and never leaks. No-op while no
	 * browser is open (a stream close already released everything).
	 */
	#reconcileActivityRetention(): void {
		if (this.#browsers.size === 0) {
			this.#stopActivityWatch();
			return;
		}
		const current = new Set(
			this.#registry
				.list()
				.filter((entry) => entry.status === "ready" && entry.workspace?.kind !== "clone")
				.map((entry) => entry.daemonId),
		);
		for (const daemonId of [...this.#watchedReady]) {
			if (current.has(daemonId)) continue;
			this.#watchedReady.delete(daemonId);
			this.#connector.release(daemonId);
		}
		this.#ensureActivityWatch();
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

	/** Broadcast ONE merged {type:"daemons"} frame to every edge stream. */
	#broadcastDaemons(): void {
		this.#broadcast({ type: "daemons", daemons: this.#daemonsAggregator.merge() });
	}

	// ---------------------------------------------------------------------
	// /ctl routes + static
	// ---------------------------------------------------------------------

	/** GET /ctl/sessions/{id}/stderr: 404 for unknown/non-spawned entries. */
	#handleStderr(daemonId: string): Response {
		const entry = this.#registry.get(daemonId);
		if (!entry || entry.mode !== "spawned") {
			return json({ error: "not found" }, 404);
		}
		return json({ text: this.#supervisor.stderrTail(daemonId) });
	}

	/**
	 * GET /ctl/sessions/{id}/download?path=…: session-file download through
	 * the daemon's mode-appropriate transport (P3.4). Direct/worktree daemons
	 * proxy their HTTP /download endpoint (bearer, same realpath jail);
	 * clone daemons get a fleet-issued capture bulk correlation and a
	 * download_bulk command on the transport control stream — the daemon
	 * streams the file back over POST /callback/bulk (multi-part under the
	 * 64 MiB aggregate cap) with no inbound dial. Both paths ride the
	 * server-level auth gate (BrowserAuth) and never touch the fleet's own
	 * filesystem. Unknown daemon → 404; missing transport → 503; a failed
	 * or capped transfer → 502 with the typed reason.
	 */
	async #handleDownload(req: Request, daemonId: string): Promise<Response> {
		const entry = this.#registry.get(daemonId);
		if (!entry) return json({ error: "not found" }, 404);
		const path = new URL(req.url).searchParams.get("path");
		if (typeof path !== "string" || path === "") {
			return json({ error: "download requires a ?path=" }, 400);
		}
		if (entry.workspace?.kind === "clone") {
			const transport = this.#transport;
			if (!transport) {
				return json({ error: "download unavailable: no callback transport wired" }, 503);
			}
			const correlation = transport.createBulkCorrelation(daemonId, { capture: true });
			try {
				await transport.sendToDaemon(daemonId, {
					streamId: CALLBACK_CONTROL_STREAM_ID,
					kind: "command",
					payload: { type: "download_bulk", correlationId: correlation.correlationId, path },
				});
			} catch {
				return json(
					{ error: `download unavailable: clone ${daemonId} has no live callback pair` },
					503,
				);
			}
			const result = await correlation.done;
			if (result.state !== "received" || result.data === undefined) {
				return json({ error: `download failed: ${result.error ?? "transfer aborted"}` }, 502);
			}
			const name = path.split("/").pop() ?? "download";
			return new Response(result.data, {
				status: 200,
				headers: {
					"content-type": "application/octet-stream",
					"content-disposition": `attachment; filename="${name.replace(/["\r\n]/g, "_")}"`,
					"content-length": String(result.data.byteLength),
				},
			});
		}
		const endpoint = entry.endpoint;
		if (!endpoint) return json({ error: "not found" }, 404);
		const headers: Record<string, string> = {};
		if (entry.token) headers.Authorization = `Bearer ${entry.token}`;
		const upstream = await fetch(
			daemonHttpBase(endpoint) + "/download?path=" + encodeURIComponent(path),
			{ headers },
		);
		if (!upstream.ok || !upstream.body) {
			return json({ error: `download failed: upstream ${upstream.status}` }, 502);
		}
		return new Response(upstream.body, {
			status: 200,
			headers: {
				// The daemon's own content-disposition (safe basename) wins
				// when present; everything else is re-labeled octet-stream.
				"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
				...(upstream.headers.get("content-disposition")
					? { "content-disposition": upstream.headers.get("content-disposition")! }
					: {}),
			},
		});
	}

	/**
	 * GET /ctl/debug: loopback developer introspection. Endpoint URLs and
	 * ports are exposed on purpose (they are the point of the feature);
	 * bearer tokens are NEVER — nothing from the registry's token field
	 * reaches this payload. The fleet-private WorkspaceRecord is likewise
	 * never serialized here: providerHandle, cleanup/archive state, and
	 * clone sources stay off this snapshot (the mapping above lists only
	 * public liveness fields, never entry.workspace).
	 */
	#debugSnapshot(): Record<string, unknown> {
		const connectorSnap = this.#connector.snapshot();
		const supervisorSnap = this.#supervisor.snapshot();
		const sessions = this.#registry.list().map((entry) => {
			const uptimeBase = entry.readyAt ?? entry.registeredAt;
			const session: Record<string, unknown> = {
				daemonId: entry.daemonId,
				name: entry.name,
				status: entry.status,
				mode: entry.mode,
				registeredAt: entry.registeredAt,
				uptimeSec: Math.max(0, Math.floor((Date.now() - uptimeBase) / 1000)),
			};
			if (entry.endpoint !== undefined) session.endpoint = entry.endpoint;
			if (entry.pid !== undefined) session.pid = entry.pid;
			if (entry.readyAt !== undefined) session.readyAt = entry.readyAt;
			if (entry.error !== undefined) session.error = entry.error;
			const connector = connectorSnap[entry.daemonId];
			if (connector) session.connector = connector;
			const supervisor = supervisorSnap[entry.daemonId];
			if (supervisor) session.supervisor = supervisor;
			return session;
		});
		return {
			fleet: {
				port: this.#fleet.port,
				startedAt: this.#fleet.startedAt,
				uptimeSec: Math.max(0, Math.floor((Date.now() - this.#fleet.startedAt) / 1000)),
				statePath: this.#fleet.statePath,
				configPath: this.#fleet.configPath,
			},
			sessions,
			log: this.#eventLog.list(),
		};
	}

	/** Static dist/ from the process cwd, then the embedded bundle (R15), then a tiny placeholder. */
	async #serveStatic(pathname: string): Promise<Response> {
		const file = Bun.file(pathname === "/" ? "dist/index.html" : `dist${pathname}`);
		if (await file.exists()) {
			return new Response(file);
		}
		// Installed-bundle path: no on-disk dist/ next to an arbitrary cwd, so
		// serve the assets embedded by build:omp-web. Keys mirror the daemon's
		// lookup in server/index.ts ("/" → "/index.html"); content-type is
		// inferred from the file extension, same as the disk branch above.
		const embedded = EMBEDDED_DIST[pathname === "/" ? "/index.html" : pathname];
		if (embedded) {
			return new Response(Bun.file(embedded));
		}
		return new Response(PLACEHOLDER_HTML, {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
}
