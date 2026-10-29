/**
 * Fleet edge (Phase 3): the browser-facing half of the aggregate UI.
 *
 * Mounted by fleet/server.ts on the same loopback Bun.serve as the
 * /ctl control API:
 *
 *   - GET /ws is the browser socket (OMP_PROTO 6), one WebSocket per client
 *     (lib/wire/browser-socket.ts is the wire). Every open socket gets an
 *     immediate roster + merged-daemons + registered-projects priming
 *     (edge-local seqs 1..k, k < DELTA_SEQ_START); live `roster_delta` /
 *     `session_status` / `daemons` / `registered_projects` broadcasts and
 *     proxied session frames follow as `{"seq":N,"frame":…}` messages with
 *     edge-local monotonic seqs from DELTA_SEQ_START, kept in a
 *     per-client ReplayRing (cap CLIENT_RING_CAP, byte budget CLIENT_RING_BYTES) for
 *     `after` resume: N ≥ DELTA_SEQ_START replays ring.after(N)
 *     after priming, anything below skips replay (priming already carries
 *     full current state). Only session DELTA types are ringed (isRingedFrameType,
 *     the session's own table, finding #5): priming frames (history,
 *     available_commands) and unicast answers (call_result) ride the live
 *     socket with a seq but no ring entry, re-derivable by re-attach
 *     priming / a re-sent command, exactly like the session. The session
 *     broadcasts an answer to every stream it has, so an id-keyed answer is
 *     additionally routed to the ONE browser whose command asked for it (the
 *     pipe's copy is dropped otherwise), never fanned out to browsers that
 *     share nothing with the command but the session. Frames are spliced
 *     (relayJson into seqFrameMessage), never re-stringified on the relay path.
 *   - Commands arrive in band as `{"cmd":…}` messages on that socket: acked
 *     (`{"ack":id}`, was 202) or nacked (`{"nack":id,"status":S,…}`, was
 *     400/413/…), answers ride the same socket as id-keyed frames. The
 *     browser a command acts on is the socket's `client` query id (an
 *     anonymous socket is not command-addressable). A re-sent id after a
 *     reconnect is acked again; the dedup window (#forwardOrigins and the
 *     session's own cache) survives the disconnect. Fleet-level commands
 *     (add_project / sync_projects / spawn / spawn_resume / stop / remove /
 *     attach) are handled here; attached-session commands (call / login_code
 *     / ui_response / collab_* / daemon_* / list_*) ride the session's
 *     callback pair. Anything outside the browser-command allowlist is
 *     rejected with an error frame. The upgrade is origin-checked whenever
 *     browser auth is enabled (see server.ts), which replaces `requireCsrf`
 *     for commands.
 *   - PAIR ATTACH: one callback virtual stream PER BROWSER ("browser/<connId>"
 *     on the session's pair). The session primes every new stream, so
 *     hello_ok → attached → history → state → available_commands → ready come
 *     from the session itself. The edge stamps `scope` (the attached roster
 *     workspace id) on every session-scoped frame and on `attached`
 *     (omp-session no longer sends one; a standalone session's `attached.scope`
 *     is its opaque BOOT_HANDLE, which the edge overwrites). Every session
 *     dials the fleet, so the edge never dials: an
 *     asleep spawned session is woken through the shared SessionWaker
 *     (session-waker.ts: respawn and pair wait, with a redial grace for a
 *     reconnecting or ready-but-unpaired session), and an unpaired
 *     remote session is refused.
 *     A pair replacement re-primes the stream from zero. A dropped pair ends
 *     the browser's stream with the "session connection lost" error frame.
 *     Attach is answered with an id-keyed attach_result frame (finding #28)
 *     so unrelated global error frames never settle a browser's in-flight
 *     attach.
 *   - RESUME: a named client's socket drop (anything but a 1000 or 1001 close:
 *     a finished client, a page unloading) does not close its session
 *     channel once its priming went through (the session's `ready` frame was
 *     forwarded; a drop mid-priming leaves nothing a browser could resume, so
 *     that channel closes at once). The channel is parked on the client for CLIENT_RECLAIM_MS and
 *     paused on the session (stream_pause: it holds the ringed deltas and sends
 *     nothing, so a browser that never returns costs no pair traffic); frames
 *     already in flight feed the client's ring like a fleet broadcast, and
 *     stream_resume on adoption sends the held ones. A returning socket (same `client`, `after` ≥
 *     DELTA_SEQ_START) adopts the channel before the ring replay when the
 *     ring still holds everything after `after` (ReplayRing.evictedThrough),
 *     no re-prime frame (EDGE_REPRIME_FRAMES: hello_ok, attached, history,
 *     available_commands, stream_reset) went by since, and the session pair
 *     is the one the channel was opened on. The browser's re-attach carrying
 *     `resume` then answers attach_result `resumed: true` and nothing is
 *     primed: the ring replay is the whole catch-up and no history crosses the
 *     wire. Any other case (pair replaced, a re-prime frame meeting the parked
 *     channel, ring eviction, an older client without `resume`) closes the
 *     channel and the attach is an ordinary priming one.
 *   - Backpressure: a browser socket whose send buffer exceeds the cap (default
 *     CLIENT_BACKPRESSURE_BYTES) before a send, whose send is refused, or
 *     that buffers bytes with no drain for CLIENT_STALL_MS (a browser that
 *     stopped reading) is closed 4503 (drop-and-resume): the browser
 *     reconnects with `after` and the edge replays its ring. One slow
 *     browser never stalls the session stream or other browsers. The session's
 *     priming and history bursts are paced by the browser's drain, not
 *     counted against the cap: stream_open puts the stream on ack pacing,
 *     and the edge answers with stream_ack controls as the socket's buffer
 *     drains (`drain` events and every send), so at most
 *     STREAM_ACK_WINDOW_BYTES of a burst sit in the edge (a slow browser
 *     slows its own priming; a stuck one is dropped by the stall rule).
 *   - Real-time session activity: the session's control-stream envelopes are
 *     tapped and derive per-session {streaming, blocked} from state /
 *     the agent_start event (the session sends no state frame at turn start) /
 *     ui_request / ui_request_end (a state frame's pendingUiRequestIds, when
 *     present, replaces the delta-built open-dialog set, so every pair-up
 *     resyncs `blocked`), broadcasting an edge-generated
 *     {type:"session_activity"} frame ONLY on change (never ringed,
 *     re-derivable from the next open's priming). A yielded agent_end event
 *     (not an SDK-internal continuation, not a non-terminal error pause)
 *     stashes the turn's outcome; the state frame that then flips streaming
 *     to false carries it as `endedTurn` on that one live broadcast (never
 *     primed, never set by a runtime-gone reset). Sessions hold their own
 *     pair, so no browser presence is needed to keep activity live.
 *     session_activity is stripped from callback streams like `daemons`
 *     broker rosters.
 *   - Aggregated daemons: every session's control-stream envelopes are tapped
 *     for {type:"daemons"} broker rosters. The latest roster per workspaceId is
 *     cached (full-replace), merged across sessions, and broadcast as ONE
 *     {type:"daemons"} frame to every edge stream, also on browser open.
 *     Per-session daemons frames are stripped from callback streams (the
 *     merged frame is the only one browsers see), and removing a session from
 *     the registry evicts its cache (see daemons-aggregator.ts).
 *   - Static dist/ serving lives in static-ui.ts (shared with the UI server);
 *     with serveUi false the edge answers 404 JSON for static paths instead.
 *
 * Roster serialization never leaks credentials (enrollment tokens and digests)
 * to browsers (see toRosterEntry).
 */

import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import {
	COMMAND_DEDUP_WINDOW_MS,
	workspaceSessionsLimit,
	OMP_PROTO,
	CLIENT_BACKPRESSURE_BYTES,
	CLIENT_STALL_MS,
	DELTA_SEQ_START,
	CLIENT_KEEPALIVE_MS,
	CLIENT_RING_CAP,
	CLIENT_RING_BYTES,
	type ClientCommand,
	type RosterEntry,
	type DaemonInfo,
	type PublicProviderProfile,
	type ServerFrame,
	type WireTurnOutcome,
	isRingedFrameType,
	isSessionScopedFrameType,
} from "#lib/wire/protocol";
import {
	ackMessage,
	BROWSER_SOCKET_PATH,
	browserCloseFor,
	nackMessage,
	parseBrowserSocketParams,
	parseClientMessage,
	pingMessage,
	seqFrameMessage,
	type BrowserCloseKind,
} from "#lib/wire/browser-socket";
import { ReplayRing } from "#lib/wire/replay-ring";
import {
	CALLBACK_BROWSER_STREAM_PREFIX,
	CALLBACK_CONTROL_STREAM_ID,
	CallbackError,
	STREAM_ACK_STEP_BYTES,
} from "#lib/wire/callback-protocol";
import type {
	CallbackEnvelope,
	StreamAckControl,
	StreamOpenControl,
	StreamPauseControl,
	StreamResumeControl,
} from "#lib/wire/callback-protocol";
import type { FleetConfig } from "./config";
import { serveStaticUi } from "./static-ui";
import { BrowseError, browseDirectories } from "./fs-browse";
import { listRecentRoots } from "./recent-roots";
import { DaemonsAggregator } from "./daemons-aggregator";
import type {
	BulkCorrelation,
	SessionTransportRegistry,
	VirtualStreamSink,
} from "./session-transport";
import {
	listCloneWorkspaceSessions,
	listWorkspaceSessions,
	type CloneSessionStore,
} from "./workspace-sessions";
import { type Registry, type RegistryChange, type RegistryEntry } from "./registry";
import type { ProjectSync } from "./project-sync";
import type { SessionWaker } from "./session-waker";
import { EDGE_COMMAND_FIELDS, readEdgeArgs, type EdgeArgs } from "./edge-commands";
import { FleetOperations, OperationError } from "./operations";
import type { CloneCreateInput, LifecycleApi } from "./workspace-lifecycle";
import type { FleetEventLog, FleetFacts } from "./events";
import { NOT_GIT_PROJECT_MESSAGE } from "./discovery";
import { listProjectBranches, realpathOf } from "./worktrees";

/** Reclaim grace for a disconnected browser's ring (`after` resume window). */
const CLIENT_RECLAIM_MS = 60_000;
/** Drain checkpoints merge until they span this many queued bytes (bounds the checkpoint list). */
const CREDIT_GRAIN_BYTES = 32 * 1024;
/** Close codes of a client that is done (RFC 6455 "normal closure"; "going away" is what a page unloading sends). */
const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;

/** Picked-session membership: the whole worktree listing, never the dropdown page. */
const RESUME_MEMBERSHIP_LIMIT = Number.POSITIVE_INFINITY;

/** attach_result error for an attach a newer attach on the same stream overtook. */
const ATTACH_SUPERSEDED = "attach superseded";

/**
 * spawn_resume hit a row that is not asleep (or failed). Distinct from a pick
 * validation or wake failure so the rejection is not recorded as a refused
 * pick: a running row has no pending pick for a later attach to protect.
 */
class NotAsleepError extends Error {}

/**
 * Per-session realtime activity, derived by the edge from the raw tapped
 * session frames (state → isStreaming, an agent_start event → streaming; ui_request / ui_request_end, and a
 * state frame's pendingUiRequestIds snapshot → the open-dialog set that
 * drives `blocked`; a yielded agent_end event → `pendingTurn`, the outcome
 * the next streaming true→false broadcast reports as `endedTurn`), and reset
 * to idle when the row's process is gone or
 * relaunching (#resetActivityOfGoneRuntime). Starts UNKNOWN per session
 * (`known: false`, nothing derived) until the first derivable frame
 * arrives. Never carries credentials.
 */
interface SessionActivity {
	/** True once at least one derivable frame has been observed (unknown→known is itself a change). */
	known: boolean;
	streaming: boolean;
	blocked: boolean;
	/** ui_request ids currently open on the session; `blocked` = size > 0. */
	openDialogIds: Set<string>;
	/**
	 * Outcome of the last observed turn end (a yielded agent_end), stashed
	 * until the state frame that flips `streaming` true→false consumes it as
	 * that one broadcast's `endedTurn`. Cleared by agent_start, by any other
	 * streaming update, and by a runtime-gone reset; never primed.
	 */
	pendingTurn?: WireTurnOutcome;
}

/**
 * Bytes a text message costs on the wire: its UTF-8 length plus the
 * WebSocket frame header (2 bytes; 4 past 125 bytes; 10 past 65535). Server
 * frames are unmasked. Matches what `getBufferedAmount()` counts, so drain
 * accounting (sent minus buffered) lands on zero when the socket empties.
 */
function sentBytes(text: string): number {
	const payload = Buffer.byteLength(text, "utf8");
	return payload + (payload < 126 ? 2 : payload < 65536 ? 4 : 10);
}

const STDERR_ROUTE = /^\/ctl\/sessions\/([^/]+)\/stderr$/;
/** Fleet-proxied session-file download: files ride the callback bulk channel. */
const DOWNLOAD_ROUTE = /^\/ctl\/sessions\/([^/]+)\/download$/;

/**
 * Error frame for any browser command outside the allowlist. Phase 6: the
 * mux-era commands and `detach` are gone from ClientCommand, so an unknown
 * command (or plain garbage) must not reach the session; the edge rejects it
 * with this instead.
 */
const UNKNOWN_COMMAND_MESSAGE = "fleet edge: use spawn/stop/roster";

/**
 * Browser-command allowlist, checked on the RAW parsed frame before any
 * dispatch: edge-handled commands plus the ClientCommand variants forwarded
 * to the attached session. `hello` is gone from the protocol (session auth is
 * HTTP-level, the bearer header). Anything else is rejected
 * with UNKNOWN_COMMAND_MESSAGE. Typed against ClientCommand so a removed
 * variant stops compiling instead of silently broadening the allowlist.
 */
const BROWSER_COMMAND_LIST = [
	// Handled at the edge.
	"list_project_branches",
	"sync_projects",
	"list_workspace_sessions",
	"spawn",
	"spawn_resume",
	"stop",
	"remove",
	// Clone creation: handled at the edge via the injected lifecycle hooks.
	"create_clone",
	"add_project",
	"remove_project",
	"attach",
	// Worktree lifecycle (Phase 4): create/add/delete + delete-info evidence.
	"create_worktree",
	"delete_worktree",
	"worktree_delete_info",
	// Forwarded to the attached session over its callback pair.
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
// fails tsc on ADDED ones; a variant added to the union without an
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
 * The JSON text for a relayed session frame, taken from the frame's own
 * wire text instead of re-serialized, or undefined when the caller must
 * stringify the parsed frame. The edge decided on JSON.parse(payloadJson); the
 * browser JSON.parses the text this returns, so both see one value. With
 * `scope`, the stamp `{ ...frame, scope }` is spliced in as the last
 * member (JSON.parse is last-key-wins, so it overrides an existing key, as the
 * spread does). The stamp key is `scope`, never `workspaceId`, so a session-scoped
 * frame whose payload names its own `workspaceId` keeps it. Only stamped frame types reach the splice, and those carry a
 * `type` member, so the object is never empty. Declined (undefined) when the
 * text is not a bare object. The text lands inside a `{"seq":N,"frame":…}`
 * message (seqFrameMessage): JSON tolerates whitespace and line breaks
 * between tokens, so nothing else needs declining.
 */
function relayJson(payloadJson: string, scope: string | undefined): string | undefined {
	if (payloadJson.charCodeAt(0) !== 0x7b || payloadJson.charCodeAt(payloadJson.length - 1) !== 0x7d)
		return undefined;
	if (scope === undefined) return payloadJson;
	const member = `"scope":${JSON.stringify(scope)}`;
	return `${payloadJson.slice(0, -1)},${member}}`;
}

/**
 * Session frames a ring replay cannot re-deliver and whose loss leaves the
 * browser showing the wrong session state: the attach priming (hello_ok,
 * attached, history, available_commands) and a stream reset. The edge rings
 * only isRingedFrameType deltas (finding #5; the same table as the session's
 * rings), so these are forwarded live and never ringed: re-attach priming
 * re-derives them. A browser that dropped before one of them reached it must
 * not resume (see #adoptParked); it re-attaches and is primed again.
 */
const EDGE_REPRIME_FRAMES: Record<string, true> = {
	hello_ok: true,
	attached: true,
	history: true,
	available_commands: true,
	stream_reset: true,
};

/**
 * Forwarded commands whose answer is id-keyed (ANSWER_FRAME_TYPES) and so
 * routable back to the browser that asked. `login_code`/`ui_response` carry
 * an id too but are answered by no frame, and the `sessions`/`files` frames that
 * answer `list_sessions`/`list_files` are not routed by id here, so neither is routable.
 */
const ANSWERED_FORWARD_TYPES: Record<string, true> = {
	call: true,
	daemon_logs: true,
	daemon_stop: true,
	daemon_restart: true,
};

/** The session's id-keyed unicast answers (one pipe copy per attached browser). */
const ANSWER_FRAME_TYPES: Record<string, true> = {
	call_result: true,
	daemon_logs_result: true,
	daemon_control_result: true,
};

/**
 * Answer frame type per forwarded command type: the client correlates each
 * command with exactly one frame type, so a refusal (see
 * {@link FleetEdge.#recordForwardOrigin}) must speak the same type or the
 * caller waits out its own timeout.
 */
const REFUSED_ANSWER_TYPES: Record<string, string> = {
	call: "call_result",
	daemon_logs: "daemon_logs_result",
	daemon_stop: "daemon_control_result",
	daemon_restart: "daemon_control_result",
};

/** Cap on remembered forward origins (the session's answer cache is capped the same way). */
const FORWARD_ORIGIN_CAP = 256;

/**
 * The browser one forwarded command id belongs to.
 */
interface ForwardOrigin {
	clientId: string;
	/** The session the command was forwarded to (the answer must come back from the same one). */
	workspaceId: string;
	/** The session's authorized enrollment generation at forward time; a changed generation means a new process. */
	generation: number | null;
	/** The answer reached the origin: later pipe copies of it are consumed, not fanned out. */
	delivered: boolean;
	/** An earlier forward of this id was accepted onto the pair, so the session may have applied the command. */
	sent: boolean;
	/** Insertion time, for the TTL sweep (the session's dedup window). */
	at: number;
}

/**
 * Single eviction path for non-clone roster rows (FLC-22). Implemented by the
 * server (fleet/server.ts #evictRow / #evictProject), which owns the pair
 * watch, log tap, and store-orphan marker that a row removal must also clear.
 * `evictRow` stops the session, runs `removal`, and drops the row only once
 * `removal` resolves; a rejecting `removal` leaves the row registered (FLC-21).
 */
export interface EdgeEvictionHooks {
	evictRow<T>(workspaceId: string, removal: () => Promise<T>): Promise<T>;
	evictProject(projectId: string): Promise<void>;
}

/** The live machinery the edge coordinates. */
export interface EdgeDeps {
	registry: Registry;
	/** The lifecycle owner: every runtime start, stop, delete, clone create/fetch and the host debug facts. */
	lifecycle: LifecycleApi;
	sync: Pick<ProjectSync, "syncNow">;
	config: FleetConfig;
	/** Fleet lifecycle-event ring, surfaced verbatim by /ctl/debug. */
	eventLog: FleetEventLog;
	/** Fleet-wide facts (port/startedAt/state paths) surfaced by /ctl/debug. */
	fleet: FleetFacts;
	/**
	 * Callback transport: every session dials the fleet and attaches,
	 * commands, and downloads over its pair. Absent (test construction) =
	 * session rows report typed unavailability.
	 */
	transport?: SessionTransportRegistry;
	/** Non-clone row eviction (FLC-22). Required: the server owns pair/log-tap/orphan cleanup. */
	eviction: EdgeEvictionHooks;
	/** Session wake (FLC-23): brings a session's callback pair up before an attach or prompt. Required; the server owns it. */
	waker: SessionWaker;
	/** Boot-static secret-free provider catalog, published on registered_projects. Omitted entirely when not configured. */
	providerProfiles?: PublicProviderProfile[];
	/** Fleet transcript store for clone session listing/resume membership. Absent = clone rows list no sessions. */
	logStore?: CloneSessionStore;
	/** Serve the static UI for non-API paths (default true); false = 404 JSON, the split-setup control plane. */
	serveUi?: boolean;
	/** Agent sessions dir (`<agent dir>/sessions`) read for recent-root autocomplete; absent = no recent roots. */
	sessionsDir?: string;
}

/**
 * Admission the fleet server decided for one `/ws` upgrade (auth, origin,
 * loopback exemption). A refusal is delivered as a typed close after the
 * upgrade; `session` is the browser auth session the socket belongs to
 * (null for a loopback peer or with auth disabled), so sign-out and expiry
 * can close exactly its sockets.
 */
export interface BrowserAdmission {
	refusal: { kind: BrowserCloseKind; message: string } | null;
	session: { hash: string; expiresAt: number } | null;
}

/** `ws.data` of a browser socket on the fleet's Bun.serve (see the `kind` discriminator). */
export interface BrowserSocketData {
	kind: "browser";
	/** Typed refusal decided at upgrade; `open` closes the socket with it at once. */
	refusal: { kind: BrowserCloseKind; message: string } | null;
	/** Page-scoped id from `client` (null = anonymous, not command-addressable). */
	clientId: string | null;
	/** Resume point from `after` (null = fresh priming). */
	after: number | null;
	session: { hash: string; expiresAt: number } | null;
	/** Set by `open` once the socket is bound to a client. */
	stream: BrowserStream | null;
}

/**
 * One browser socket consumer on the edge, keyed by the browser's
 * page-scoped clientId. The ring + seq counter live here so a reconnecting
 * browser (same clientId) resumes from its `after` across socket
 * replacement; the state is reclaimed after a grace period with no socket.
 */
interface BrowserClient {
	/** Page-scoped id from `client` (null for anonymous sockets, not command-addressable). */
	clientId: string | null;
	/** Edge-local replay ring of this browser's ringed deltas, as the full wire messages (cap CLIENT_RING_CAP, byte budget CLIENT_RING_BYTES). */
	ring: ReplayRing<string>;
	/** Next edge-local delta seq for this browser (≥ DELTA_SEQ_START). */
	nextSeq: number;
	/**
	 * Edge seq of the last frame forwarded to this browser that a ring replay
	 * cannot re-deliver and that changes what the browser shows of its session
	 * (EDGE_REPRIME_FRAMES). A resume point below it may have missed one.
	 */
	resetSeq: number;
	/** Live socket, or null while disconnected (the ring is kept for resume). */
	stream: BrowserStream | null;
	/**
	 * The dropped socket whose session channel is parked for this client: the
	 * channel keeps running (frames feed the ring) until a returning socket
	 * adopts it, a re-prime frame or a pair change makes it stale, or the
	 * reclaim grace ends.
	 */
	parked: BrowserStream | null;
	/** Reclaim timer: drops the client state when no socket rebinds in time. */
	gcTimer: ReturnType<typeof setTimeout> | null;
}

/** One live `/ws` browser socket on the edge. */
export interface BrowserStream {
	ws: ServerWebSocket<BrowserSocketData>;
	/** Set once released (closed by either side, dropped, replaced): nothing is sent after. */
	closed: boolean;
	/** The client this socket belongs to (ring/seq live there). */
	client: BrowserClient;
	/** This browser's dedicated session channel: a callback virtual stream
	 * ("browser/<connId>" on the session's pair). Null while unattached. */
	pipe: CallbackPipeState | null;
	/** Bumped by every attach on this socket; an attach whose value moved on is superseded. */
	attachSeq: number;
	/** Bytes ever sent on the socket (the kernel has taken `enqueuedBytes` minus what is still buffered). */
	enqueuedBytes: number;
	/** Bytes the socket had taken at the last drain check; only moves forward. */
	drainedMark: number;
	/** Last time the buffer was empty or the socket took bytes (the stall clock). */
	progressAt: number;
	/** Last time the edge wrote anything (the keepalive's idle clock). */
	lastSendAt: number;
	/** The channel adopted at open from the client's previous socket (see #adoptParked); the next attach with `resume` confirms it. Cleared by any attach. */
	resumable: boolean;
}

/**
 * One callback virtual stream: a browser's dedicated "browser/<connId>" pair
 * to a session. Sessions dial the fleet, so no inbound dial ever exists. The
 * session primes + replays per stream; the edge only forwards envelopes and
 * re-sends stream_open after every pair replacement. Never redials: pair
 * liveness is the transport's job; a dropped pair surfaces as a
 * "session connection lost" error frame.
 */
interface CallbackPipeState {
	workspaceId: string;
	/** The socket this channel serves: its frames are forwarded there. A parked channel's owner is the dropped (closed) socket, until a returning socket adopts it. */
	owner: BrowserStream;
	/** Edge-chosen browser connection id, the "browser/<connId>" stream's suffix. */
	connId: string;
	/** Intentional teardown (browser close / re-attach / clone stopped/removed). */
	closed: boolean;
	/** The pair connectionId this stream was last opened on (a stream_open went). */
	pairConnectionId: string | null;
	/** Unbind the transport virtual stream; idempotent, safe after close(). */
	detach: () => void;
	/** Unsubscribe the pair-change observer; idempotent, safe after close(). */
	unsubscribePair: () => void;
	/**
	 * Drain checkpoints for the session envelopes this stream consumed, in wire-seq
	 * order: each covers the stream's `enqueuedBytes` in (start, end]. Slots
	 * before `creditHead` are consumed. Adjacent small envelopes merge, so the
	 * list is bounded by the queue's bytes, not its frame count.
	 */
	credits: Array<{ start: number; end: number; seq: number } | undefined>;
	creditHead: number;
	/** Highest checkpoint seq the queue has drained past, and the highest sent as stream_ack. */
	drainedSeq: number;
	ackedSeq: number;
	/** Socket-taken bytes at the last stream_ack. */
	ackedDrained: number;
	/**
	 * The session's priming reached the socket (its `ready` frame was forwarded
	 * after the last `hello_ok`). Only a primed channel is worth parking: a drop
	 * before that leaves the browser with `after` below the re-prime frames, so
	 * it could never resume and would hold the session's burst until the reclaim.
	 */
	primed: boolean;
}

function newClient(clientId: string | null, ringBytes: number): BrowserClient {
	return {
		clientId,
		ring: new ReplayRing<string>(CLIENT_RING_CAP, ringBytes),
		nextSeq: DELTA_SEQ_START,
		resetSeq: 0,
		stream: null,
		parked: null,
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
 * the RosterEntry fields of a registry entry (never credentials, template,
 * or registeredAt) plus a live uptime in seconds since
 * readyAt (or registeredAt when never ready) and pid.
 *
 * Clone-workspace projection: the roster surfaces the PUBLIC subset of
 * the fleet-private WorkspaceRecord: kind→workspaceKind,
 * desiredState→desiredState, profileId→providerProfileId, plus the
 * ephemeral lifecycle liveness facts (lifecycleStage/lifecycleError, the
 * same liveness class as status/pid/readyAt). The record's private
 * remainder (providerHandle, cleanup/archive state, clone source paths and URLs) NEVER
 * crosses this boundary (only the `localSource` boolean does), exactly as RegistryEntry credentials and templates
 * never do: roster frames and registered_projects frames stay free of
 * credentials, private addresses, provider handles, and secret material. Any
 * future workspace field must be mapped here explicitly (or added to the
 * RegisteredProject shape) before it can appear on the wire.
 */
export function toRosterEntry(entry: RegistryEntry): RosterEntry {
	const roster: RosterEntry = {
		workspaceId: entry.workspaceId,
		name: entry.name,
		cwd: entry.cwd,
		project: entry.project,
		status: entry.status,
		// An asleep session has no live process: omit the uptime rather than let
		// the registeredAt fallback show a growing uptime for a dead session.
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
	if (entry.branch !== undefined) roster.branch = entry.branch;
	if (entry.detachedAt !== undefined) roster.detachedAt = entry.detachedAt;
	if (entry.worktreeLocked === true) roster.worktreeLocked = true;
	if (entry.git !== undefined) roster.git = { ...entry.git };
	if (entry.lastSessionFile !== undefined) roster.lastSessionFile = entry.lastSessionFile;
	if (entry.sessionTitle !== undefined) roster.sessionTitle = entry.sessionTitle;
	// The empty flag is meaningful only when true; a false/undefined is the same,
	// so it stays off the wire (mirrors the title-cleared rule above).
	if (entry.sessionEmpty === true) roster.sessionEmpty = true;
	// Liveness facts are meaningless for an asleep session; keep them off the
	// roster even if the registry entry transiently carries stale ones (e.g.
	// mid-respawn, when the lifecycle writes the pid before the child readies).
	if (entry.status !== "asleep") {
		if (entry.readyAt !== undefined) roster.readyAt = entry.readyAt;
		if (entry.pid !== undefined) roster.pid = entry.pid;
	}
	if (entry.error !== undefined) roster.error = entry.error;
	// Clone workspace projection: pass through the PUBLIC workspace
	// fields only: kind/desiredState/profileId from the fleet-private record
	// (legacy entries carry an in-memory inferred workspace after load), and
	// the ephemeral lifecycle liveness facts straight off the entry. The
	// record's providerHandle and everything else private stays off the wire.
	const workspace = entry.workspace;
	if (workspace !== undefined) {
		roster.workspaceKind = workspace.kind;
		roster.desiredState = workspace.desiredState;
		if (workspace.profileId !== undefined) roster.providerProfileId = workspace.profileId;
		if (workspace.kind === "clone" && workspace.source?.local !== undefined) {
			roster.localSource = true;
		}
	}
	if (entry.lifecycleStage !== undefined) roster.lifecycleStage = entry.lifecycleStage;
	if (entry.lifecycleError !== undefined) roster.lifecycleError = entry.lifecycleError;
	return roster;
}

export class FleetEdge {
	readonly #registry: Registry;
	readonly #lifecycle: LifecycleApi;
	readonly #sync: Pick<ProjectSync, "syncNow">;
	readonly #config: FleetConfig;
	readonly #eventLog: FleetEventLog;
	readonly #fleet: FleetFacts;
	/** Callback transport: clone attach/commands/downloads ride it; undefined = clone rows answer typed unavailability. */
	readonly #transport: SessionTransportRegistry | undefined;
	/** Session wake (FLC-23): one rule set shared with fan-out prompts, so every wake follows it. */
	readonly #waker: SessionWaker;
	/** Shared clone/worktree/project mutations (operations.ts): the same calls the control API makes. */
	readonly #ops: FleetOperations;
	/** Browser-command runners, keyed like EDGE_COMMAND_FIELDS; each receives the validated args. */
	readonly #runners: Record<string, (stream: BrowserStream, id: string, args: EdgeArgs) => void> = {
		list_workspace_sessions: (stream, _id, a) =>
			void this.#handleListWorkspaceSessions(
				stream,
				a.workspaceId as string,
				a.limit as number | undefined,
			),
		list_project_branches: (stream, _id, a) =>
			void this.#handleListProjectBranches(
				stream,
				a.projectId as string,
				a.remote as string | undefined,
			),
		sync_projects: () => this.#sync.syncNow(),
		spawn: (stream, _id, a) =>
			void this.#runOperation(stream, () =>
				this.#ops.spawn({
					cwd: a.cwd as string,
					template: a.template as string | undefined,
				}),
			),
		spawn_resume: (stream, _id, a) =>
			void this.#handleSpawnResume(
				stream,
				a.workspaceId as string,
				a.sessionFile as string | undefined,
			),
		stop: (stream, _id, a) =>
			void this.#runOperation(stream, () => this.#ops.stop(a.workspaceId as string)),
		remove: (stream, _id, a) =>
			void this.#runOperation(stream, () => this.#ops.remove(a.workspaceId as string)),
		add_project: (stream, id, a) => void this.#handleAddProject(stream, id, a.path as string),
		remove_project: (stream, _id, a) =>
			void this.#runOperation(stream, () => this.#ops.removeProject(a.projectId as string)),
		create_clone: (stream, id, a) =>
			void this.#runWorkspaceCreate(stream, id, () =>
				this.#ops.createClone({
					projectId: a.projectId as string,
					name: a.name as string,
					profileId: a.profileId as string,
					source: a.source as CloneCreateInput["source"],
					revision: a.revision as string | undefined,
					branch: a.branch as string | undefined,
					start: a.start as boolean | undefined,
				}),
			),
		create_worktree: (stream, id, a) =>
			void this.#runWorkspaceCreate(stream, id, () =>
				this.#ops.createWorktree(a.projectId as string, {
					name: a.name as string,
					baseRef: a.baseRef as string | undefined,
					existingBranch: a.existingBranch as string | undefined,
					start: a.start as boolean | undefined,
				}),
			),
		delete_worktree: (stream, _id, a) =>
			void this.#runOperation(stream, () =>
				this.#ops.deleteWorkspace(a.workspaceId as string, {
					deleteBranch: a.deleteBranch as string | undefined,
				}),
			),
		worktree_delete_info: (stream, _id, a) =>
			void this.#runOperation(stream, async () => {
				const workspaceId = a.workspaceId as string;
				const info = await this.#ops.worktreeDeleteInfo(workspaceId);
				this.#sendAnswer(stream, { type: "worktree_delete_info", workspaceId, ...info });
			}),
		attach: (stream, id, a) =>
			void this.#handleAttach(stream, a.workspaceId as string, id, a.resume === true),
	};
	/** Boot-static secret-free provider catalog, published on registered_projects. */
	readonly #providerProfiles: PublicProviderProfile[] | undefined;
	/** Fleet transcript store for clone session listing/resume membership. */
	readonly #logStore: CloneSessionStore | undefined;
	readonly #backpressureBytes: number;
	/** A queue with unread bytes and no drain for this long drops the stream (default CLIENT_STALL_MS). */
	readonly #stallMs: number;
	/** Keepalive/stall sweep cadence (default CLIENT_KEEPALIVE_MS). */
	readonly #keepaliveMs: number;
	/** Reclaim grace after a socket drop (default CLIENT_RECLAIM_MS). */
	readonly #reclaimMs: number;
	/** Per-client ring byte budget (default CLIENT_RING_BYTES; finding #5). */
	readonly #ringBytes: number;
	/** Live browser streams (broadcasts + backpressure). */
	readonly #browsers = new Set<BrowserStream>();
	/** Command-addressable browsers by clientId (ring survives stream replacement). */
	readonly #clients = new Map<string, BrowserClient>();
	/**
	 * Forwarded command id → the browser that asked (per-origin correlation).
	 * The session broadcasts each unicast answer to ALL its streams, so with one
	 * pipe per browser every browser would otherwise receive every other
	 * browser's answer; a replayed answer could then settle a pending call in
	 * the wrong tab. Answers are delivered to the recorded origin only, and a
	 * duplicate pipe copy of a delivered answer is consumed instead of fanned
	 * out. Entries expire with the session's own dedup window.
	 */
	readonly #forwardOrigins = new Map<string, ForwardOrigin>();
	/**
	 * In-flight spawn_resume work per workspaceId, registered synchronously before
	 * its first await so a concurrently arriving attach can await the pick
	 * validation instead of racing past it and waking on lastSessionFile.
	 */
	readonly #pendingResumes = new Map<string, Promise<void>>();
	/**
	 * Reason the last picked spawn_resume for a workspaceId failed validation or
	 * its wake. Set on that failure, cleared on a successful pick or an
	 * explicit no-pick spawn_resume. While set, an attach that would wake the
	 * session fails with this reason instead of waking on lastSessionFile. A
	 * status rejection (NotAsleepError) is never recorded: the row is running.
	 */
	readonly #refusedResumes = new Map<string, string>();
	/** Cached broker rosters per workspaceId, merged into the broadcast daemons frame. */
	readonly #daemonsAggregator = new DaemonsAggregator();
	/** Serialized merged roster last broadcast, so an unchanged roster is not re-sent. */
	#lastDaemonsRoster: string | undefined;
	/**
	 * Per-workspace control-stream taps (unsubscribe fns), reconciled on registry change. Each tap
	 * derives the workspace's activity and `lastSessionFile` and ingests its broker roster.
	 */
	readonly #controlTaps = new Map<string, () => void>();
	/** Per-session realtime activity, derived in the control-socket tap (browser-gated). */
	readonly #sessionActivity = new Map<string, SessionActivity>();
	/** Keepalive/stall sweep: pings idle browser sockets every CLIENT_KEEPALIVE_MS. */
	#keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	/** False on the split-setup control plane: static paths answer 404 JSON instead of the UI. */
	readonly #serveUi: boolean;
	readonly #sessionsDir: string | undefined;

	/** Bound once so close() can unset registry.onChange without clobbering a replacement. */
	readonly #onRegistryChange = (change: RegistryChange): void => {
		// New sessions get a sessions-frame tap; removed ones lose it and their
		// cached rosters are evicted (broadcast so browsers drop the entries).
		this.#reconcileControlTaps();
		this.#broadcastRosterDelta(change);
		for (const entry of change.upserted) this.#resetActivityOfGoneRuntime(entry);
	};

	/** Project-set mutations only; the frame is re-derivable from priming, so it is never ringed. */
	readonly #onProjectsChange = (): void => {
		this.#broadcastRegisteredProjects();
	};

	constructor(
		deps: EdgeDeps,
		opts?: {
			/** Backpressure cap for browser streams (default CLIENT_BACKPRESSURE_BYTES). */
			backpressureBytes?: number;
			/** Per-client replay-ring byte budget (default CLIENT_RING_BYTES). */
			ringBytes?: number;
			/** Stall limit for a browser stream whose queue stops draining (default CLIENT_STALL_MS). */
			stallMs?: number;
			/** Keepalive and stall-sweep interval (default CLIENT_KEEPALIVE_MS). */
			keepaliveMs?: number;
			/** Grace a disconnected client's ring and parked session channel are kept for resume (default CLIENT_RECLAIM_MS). */
			reclaimMs?: number;
		},
	) {
		this.#registry = deps.registry;
		this.#lifecycle = deps.lifecycle;
		this.#sync = deps.sync;
		this.#config = deps.config;
		this.#eventLog = deps.eventLog;
		this.#fleet = deps.fleet;
		this.#transport = deps.transport;
		this.#waker = deps.waker;
		this.#ops = new FleetOperations({
			registry: deps.registry,
			lifecycle: deps.lifecycle,
			sync: deps.sync,
			config: deps.config,
			eventLog: deps.eventLog,
			eviction: deps.eviction,
		});
		// A detached session's browser pipes drop before its row is stopped,
		// removed or deleted (FleetOperations.onDetach).
		this.#ops.onDetach((workspaceId) => {
			for (const s of this.#browsers) {
				if (s.pipe?.workspaceId === workspaceId) this.#closePipe(s);
			}
			for (const client of this.#clients.values()) {
				if (client.parked?.pipe?.workspaceId === workspaceId) this.#dropParked(client);
			}
		});
		this.#providerProfiles = deps.providerProfiles;
		this.#logStore = deps.logStore;
		this.#backpressureBytes = opts?.backpressureBytes ?? CLIENT_BACKPRESSURE_BYTES;
		this.#ringBytes = opts?.ringBytes ?? CLIENT_RING_BYTES;
		this.#stallMs = opts?.stallMs ?? CLIENT_STALL_MS;
		this.#keepaliveMs = opts?.keepaliveMs ?? CLIENT_KEEPALIVE_MS;
		this.#reclaimMs = opts?.reclaimMs ?? CLIENT_RECLAIM_MS;
		this.#serveUi = deps.serveUi ?? true;
		this.#sessionsDir = deps.sessionsDir;
		deps.registry.onChange = this.#onRegistryChange;
		// Project-set mutations are rare and the frame is re-derivable from
		// priming, so they broadcast via a dedicated hook, never ringed.
		deps.registry.onProjectsChange = this.#onProjectsChange;
		// Tap sessions that already exist at construction (state.json load).
		this.#reconcileControlTaps();
	}

	/**
	 * Edge HTTP surface. Returns a Response (route handled) or null (not an
	 * edge route; the control plane decides). Never throws.
	 */
	async handleFetch(req: Request): Promise<Response | null> {
		try {
			const url = new URL(req.url);
			const path = url.pathname;
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
			if (path === "/ctl/fs/recent-roots") {
				const registered = this.#registry.projects().map((p) => p.path);
				const roots =
					this.#sessionsDir === undefined
						? []
						: await listRecentRoots({ sessionsDir: this.#sessionsDir, registered });
				return json({ roots });
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
			if (!this.#serveUi) {
				return json({ error: "this omp-web control plane serves no UI; run: omp-web ui" }, 404);
			}
			return await serveStaticUi(path, req);
		} catch (err) {
			return json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
	}

	/** Session status transition → session_status broadcast (wired by server.ts). */
	onSessionStatus(entry: RegistryEntry): void {
		const frame: ServerFrame = {
			type: "session_status",
			workspaceId: entry.workspaceId,
			status: entry.status,
			...(entry.error !== undefined ? { error: entry.error } : {}),
		};
		this.#broadcast(frame);
	}

	/**
	 * Global broadcast: a poll-detected, on-disk worktree removal (the
	 * session's cwd vanished between git-state poll ticks). Ringed (default)
	 * so a browser whose socket was down at emit time still gets the toast
	 * once via `after` resume; the client's per-connection seq dedup drops
	 * the replay of one it already saw. Never sent for UI-initiated
	 * delete_worktree/remove.
	 */
	announceWorktreeRemoved(entry: { workspaceId: string; name: string; cwd: string }): void {
		this.#broadcast({
			type: "worktree_removed",
			workspaceId: entry.workspaceId,
			name: entry.name,
			path: entry.cwd,
		});
	}

	/** Detach broadcast wiring and close every browser socket + pipe. */
	close(): void {
		if (this.#registry.onChange === this.#onRegistryChange) {
			this.#registry.onChange = null;
		}
		if (this.#registry.onProjectsChange === this.#onProjectsChange) {
			this.#registry.onProjectsChange = null;
		}
		for (const unsubscribe of this.#controlTaps.values()) unsubscribe();
		this.#controlTaps.clear();
		this.#stopKeepalive();
		for (const client of this.#clients.values()) {
			if (client.gcTimer) clearTimeout(client.gcTimer);
			this.#dropParked(client);
		}
		this.#clients.clear();
		for (const stream of [...this.#browsers]) {
			stream.closed = true;
			this.#closePipe(stream);
			try {
				stream.ws.close(1001, "fleet shutting down");
			} catch {
				// Ignore; the socket is already gone.
			}
		}
		this.#browsers.clear();
	}

	// ---------------------------------------------------------------------
	// Browser streams
	// ---------------------------------------------------------------------

	/**
	 * Accept one `GET /ws` upgrade. The caller (fleet/server.ts) has already
	 * decided admission from the request (cookie session, loopback exemption,
	 * trusted-proxy client address, origin checks); a refusal rides `admission`
	 * and is delivered as a typed close once the socket is open, because a
	 * browser cannot read the status of a failed WebSocket handshake. Only the
	 * proto claim is judged here: a missing or different `proto` is 4426.
	 * Returns undefined once upgraded, or the HTTP error when the handshake
	 * itself failed.
	 */
	acceptBrowserSocket(
		req: Request,
		server: { upgrade(req: Request, options: { data: BrowserSocketData }): boolean },
		admission: BrowserAdmission,
	): Response | undefined {
		const params = parseBrowserSocketParams(new URL(req.url).searchParams);
		let refusal = admission.refusal;
		if (refusal === null && params.proto !== OMP_PROTO) {
			refusal = {
				kind: "proto_mismatch",
				message: `client speaks OMP_PROTO ${params.proto ?? "(none)"}, this fleet speaks ${OMP_PROTO}`,
			};
		}
		const data: BrowserSocketData = {
			kind: "browser",
			refusal,
			clientId: params.clientId,
			after: params.after,
			session: admission.session,
			stream: null,
		};
		if (!server.upgrade(req, { data })) {
			return json({ error: `${BROWSER_SOCKET_PATH} WebSocket upgrade failed` }, 400);
		}
		return undefined;
	}

	/**
	 * Bun `websocket.open` for a browser socket: bind it to the client id
	 * (`client` query), prime it (roster + merged daemons + registered
	 * projects + activity, seqs 1..k), replay the client's ring per `after`,
	 * then stream live deltas until the browser goes away.
	 */
	onBrowserOpen(ws: ServerWebSocket<BrowserSocketData>): void {
		const { refusal, clientId, after } = ws.data;
		if (refusal !== null) {
			const { code, reason } = browserCloseFor(refusal.kind, refusal.message);
			ws.close(code, reason);
			return;
		}
		const client = this.#bindClient(clientId);
		// Finding #25: a rebind with a STILL-LIVE previous socket (the old
		// page's close hasn't been seen yet since browser reconnects overlap)
		// must not leave it in #browsers: two live sockets for one client
		// would ring every broadcast twice (two seqs) and double-deliver.
		// Release the old stream and close its socket first; the old socket's
		// late close event is a no-op thanks to the identity guard in
		// #releaseBrowser.
		const previous = client.stream;
		if (previous) {
			this.#releaseBrowser(previous);
			try {
				previous.ws.close(1000, "replaced by a newer socket for this client");
			} catch {
				// Already closed.
			}
		}
		const now = Date.now();
		const stream: BrowserStream = {
			ws,
			closed: false,
			enqueuedBytes: 0,
			drainedMark: 0,
			progressAt: now,
			lastSendAt: now,
			client,
			pipe: null,
			attachSeq: 0,
			resumable: false,
		};
		ws.data.stream = stream;
		client.stream = stream;
		this.#browsers.add(stream);
		this.#startKeepalive();
		// A returning socket of a client with a parked session channel resumes it
		// (before the priming and the ring replay below; see #adoptParked).
		this.#adoptParked(client, stream, after);
		// Priming: roster + merged daemons + registered projects
		// (seqs 1..k, k < DELTA_SEQ_START).
		let seq = 1;
		this.#send(
			stream,
			seqFrameMessage(
				seq++,
				JSON.stringify({
					type: "roster",
					entries: this.#registry.list().map((entry) => toRosterEntry(entry)),
				}),
			),
		);
		this.#send(
			stream,
			seqFrameMessage(
				seq++,
				JSON.stringify({ type: "daemons", daemons: this.#daemonsAggregator.merge() }),
			),
		);
		this.#send(
			stream,
			seqFrameMessage(
				seq++,
				JSON.stringify({
					type: "registered_projects",
					projects: this.#registry.projects(),
					configPath: this.#fleet.configPath,
					// The boot-static secret-free profile catalog; omitted
					// entirely when the fleet has none to publish.
					...(this.#providerProfiles !== undefined
						? { providerProfiles: this.#providerProfiles }
						: {}),
				}),
			),
		);
		// Real-time activity priming: one session_activity frame per managed
		// session with KNOWN derived activity, whatever its roster status
		// (unknown ones are omitted; their first derivable frame broadcasts
		// live right after the dial below). Non-ready sessions are primed too:
		// broadcasts are never ringed, so a browser offline when a turn ended
		// holds a stale streaming:true, and a session asleep at reconnect
		// would otherwise never correct it (its pair-up state equals the
		// stored value and broadcasts nothing). The client ignores activity
		// for non-ready rows. Edge-local seq, like the rest of the priming group.
		for (const [workspaceId, activity] of this.#sessionActivity) {
			if (!activity.known) continue;
			if (!this.#registry.get(workspaceId)) continue;
			this.#send(
				stream,
				seqFrameMessage(
					seq++,
					JSON.stringify({
						type: "session_activity",
						workspaceId,
						streaming: activity.streaming,
						blocked: activity.blocked,
					}),
				),
			);
		}
		// Resume: only a delta-era `after` (≥ DELTA_SEQ_START) replays the
		// ring; anything below means priming carries full state.
		if (after !== null && after >= DELTA_SEQ_START) {
			for (const { value } of client.ring.after(after)) {
				// Dropped mid-replay: the rest would be sent and refused.
				if (stream.closed) break;
				this.#send(stream, value);
			}
		}
	}

	/**
	 * Bun `websocket.close`: the browser went away; release it and keep the ring
	 * for resume. Its session channel stays parked for the resume too, unless the
	 * client is done: a 1000 (a clean close, e.g. an API client finishing) or 1001
	 * (going away: the page unloaded, a reload or a closed tab, which browsers
	 * announce this way) closes the channel with it. A parked channel keeps every
	 * session frame flowing through the edge (parse, ring, one more envelope per
	 * frame from the session), so only a close that expects a resume pays for it:
	 * a dropped connection (1005/1006), the edge's own 4503, or the web client's
	 * own redial (BROWSER_REDIAL_CLOSE).
	 */
	onBrowserClose(ws: ServerWebSocket<BrowserSocketData>, code?: number): void {
		const stream = ws.data.stream;
		if (stream !== null) {
			this.#releaseBrowser(stream, code !== CLOSE_NORMAL && code !== CLOSE_GOING_AWAY);
		}
	}

	/**
	 * Bun `websocket.drain`: the socket took its buffered bytes. The stall
	 * clock moves and the session is acknowledged how far its burst drained.
	 */
	onBrowserDrain(ws: ServerWebSocket<BrowserSocketData>): void {
		const stream = ws.data.stream;
		if (stream !== null && !stream.closed) this.#noteDrain(stream, false);
	}

	/**
	 * Bun `websocket.message`: one in-band command (`{"cmd":...}`). A message
	 * that is not one parseable command is a protocol violation (close 4400);
	 * a refused command (oversize 413, bad shape 400) is a nack and the socket
	 * stays up. This socket is origin-checked at upgrade whenever browser auth
	 * is enabled, so a command needs no per-command CSRF token: the origin
	 * check on the handshake replaces `requireCsrf` for commands.
	 */
	onBrowserMessage(ws: ServerWebSocket<BrowserSocketData>, message: string | Buffer): void {
		const stream = ws.data.stream;
		if (stream === null || stream.closed) return;
		const session = ws.data.session;
		if (session !== null && Date.now() >= session.expiresAt) {
			this.#closeStream(stream, "unauthorized", "session expired", true);
			return;
		}
		const bytes =
			typeof message === "string" ? Buffer.byteLength(message, "utf8") : message.byteLength;
		const parsed = parseClientMessage(message, bytes);
		if (!parsed.ok) {
			if (parsed.id === null) {
				this.#closeStream(stream, "protocol_violation", parsed.error);
			} else {
				this.#send(stream, nackMessage(parsed.id, parsed.status, parsed.error));
			}
			return;
		}
		this.#acceptCommand(stream, parsed.command as unknown as Record<string, unknown>);
	}

	/**
	 * Close every socket of one browser auth session with 4401 (sign-out). The
	 * clients' rings are discarded with them: their replay state belongs to
	 * the ended session.
	 */
	closeAuthSession(sessionIdHash: string): void {
		for (const stream of [...this.#browsers]) {
			if (stream.ws.data.session?.hash === sessionIdHash) {
				this.#closeStream(stream, "unauthorized", "signed out", true);
			}
		}
	}

	/** Find or create the client state for a socket open (`client` query optional). */
	#bindClient(clientId: string | null): BrowserClient {
		if (clientId !== null && clientId !== "") {
			let client = this.#clients.get(clientId);
			if (client) {
				// Reconnect with the same clientId: clear the reclaim timer and
				// rebind; the ring resumes from the browser's `after`.
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
		// Anonymous socket: served (priming + broadcasts + ring) but not
		// command-addressable (a command needs a client id).
		return newClient(null, this.#ringBytes);
	}

	/**
	 * Dispatch one parsed command and acknowledge it (`{"ack":id}`); a
	 * command the edge cannot take is a nack carrying an HTTP-like status
	 * (400, 409, 413, 429, 503, ...). The socket's client selects the browser the
	 * command acts on (edge-level commands answer there; attached-session
	 * commands proxy to that browser's session pipe). The ack follows any
	 * answer frame the dispatch produced synchronously (an unknown command's
	 * error frame, an attach to an unknown session): a client settles
	 * commands from their id-keyed answers and must not assume ack-first.
	 * A re-sent id after a reconnect is acked again and re-forwarded; the
	 * session's own dedup replays its answer, never re-dispatches (see
	 * #recordForwardOrigin).
	 */
	#acceptCommand(stream: BrowserStream, cmd: Record<string, unknown>): void {
		const id = cmd.id as string;
		if (stream.client.clientId === null) {
			this.#send(
				stream,
				nackMessage(id, 400, "unknown client or not connected: dial /ws with ?client=<id>"),
			);
			return;
		}
		const type = cmd.type as string;
		try {
			// Phase 6: the mux-era commands and detach are gone from
			// ClientCommand. Any type outside the browser allowlist, whether a
			// removed command or plain garbage, is rejected here so the session
			// never sees a command it no longer understands.
			if (BROWSER_COMMAND_TYPES[type] !== true) {
				this.#sendError(stream, UNKNOWN_COMMAND_MESSAGE);
			} else {
				const fields = EDGE_COMMAND_FIELDS[type];
				if (fields !== undefined) {
					try {
						const args = readEdgeArgs(type, fields, cmd);
						this.#runners[type]?.(stream, id, args);
					} catch (err) {
						if (!(err instanceof OperationError)) throw err;
						this.#sendError(stream, err.message);
					}
				} else {
					this.#forwardCommand(stream, id, cmd);
				}
			}
		} catch (err) {
			this.#send(stream, nackMessage(id, 500, err instanceof Error ? err.message : String(err)));
			return;
		}
		this.#send(stream, ackMessage(id));
	}

	// ---------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------

	/**
	 * Answer a session-list request: the last `limit` sessions of one session's
	 * worktree (default 10, clamped to 1..200), newest-first (the edge lists
	 * from disk, so asleep/never-started sessions answer too, no live process
	 * needed). The answer echoes the effective limit. Unknown session → error.
	 */
	async #handleListWorkspaceSessions(
		stream: BrowserStream,
		workspaceId: string,
		requestedLimit: number | undefined,
	): Promise<void> {
		try {
			const limit = workspaceSessionsLimit(requestedLimit);
			const entry = this.#registry.get(workspaceId);
			if (!entry) {
				this.#sendError(stream, `unknown session: ${workspaceId}`);
				return;
			}
			// Clone sessions list from the fleet transcript store (the
			// owning session's session dir lives in the provider volume, never
			// a fleet-local cwd); non-clone sessions list from disk so asleep/
			// never-started sessions answer too. Empty list when no store.
			const sessions =
				entry.workspace?.kind === "clone"
					? await listCloneWorkspaceSessions(this.#logStore, workspaceId, limit)
					: await listWorkspaceSessions(entry.cwd ?? "", limit);
			this.#sendAnswer(stream, { type: "workspace_sessions", workspaceId, limit, sessions });
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * list_project_branches: unicast project_branches answer for the New
	 * workspace branch picker. Without `remote` the project's local branches;
	 * with it, that git remote's branches (ls-remote, falling back to cached
	 * refs and reported as `cached`).
	 */
	async #handleListProjectBranches(
		stream: BrowserStream,
		projectId: string,
		remote: string | undefined,
	): Promise<void> {
		const project = this.#registry.projects().find((p) => p.projectId === projectId);
		if (!project) {
			this.#sendError(stream, `unknown project: ${projectId}`);
			return;
		}
		if (project.git === false) {
			this.#sendError(stream, NOT_GIT_PROJECT_MESSAGE);
			return;
		}
		try {
			const listed = await listProjectBranches(
				project.path,
				remote === undefined ? undefined : { remote },
			);
			this.#sendAnswer(stream, {
				type: "project_branches",
				projectId,
				...(remote !== undefined ? { remote } : {}),
				...listed,
			});
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/** Run one shared operation for a browser command; a refusal or failure answers an error frame. */
	async #runOperation(stream: BrowserStream, run: () => Promise<unknown>): Promise<void> {
		try {
			await run();
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/** Run one workspace create for `id`: workspace_create_result carries the new workspaceId or the refusal text. */
	async #runWorkspaceCreate(
		stream: BrowserStream,
		id: string,
		run: () => Promise<RegistryEntry>,
	): Promise<void> {
		try {
			const entry = await run();
			this.#answerWorkspaceCreate(stream, id, { workspaceId: entry.workspaceId });
		} catch (err) {
			this.#answerWorkspaceCreate(stream, id, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * add_project: register the project behind `path` (a git repo's main
	 * checkout, or a plain directory with no git repo above it) through the
	 * shared operation (never spawns). Answered by add_project_result: the
	 * projectId, with `existing: true` when that project was already registered.
	 */
	async #handleAddProject(stream: BrowserStream, id: string, path: string): Promise<void> {
		try {
			const { project, existing } = await this.#ops.addProject({ path });
			this.#sendAnswer(stream, {
				type: "add_project_result",
				id,
				ok: true,
				projectId: project.projectId,
				existing,
			});
		} catch (err) {
			this.#sendAnswer(stream, {
				type: "add_project_result",
				id,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Unicast workspace_create_result: the new row's workspaceId, or the failure text. */
	#answerWorkspaceCreate(
		stream: BrowserStream,
		id: string,
		outcome: { workspaceId: string } | { error: string },
	): void {
		this.#sendAnswer(
			stream,
			"workspaceId" in outcome
				? { type: "workspace_create_result", id, ok: true, workspaceId: outcome.workspaceId }
				: { type: "workspace_create_result", id, ok: false, error: outcome.error },
		);
	}

	/**
	 * spawn_resume: wake an asleep (or failed) session, optionally on a picked
	 * session. A no-pick request on a row already connecting, ready or
	 * reconnecting is idempotent (it joins the in-flight wake and sends no
	 * error), so a reload's restore racing a wake click, or a second tab, does
	 * not toast; see #runSpawnResume.
	 */
	async #handleSpawnResume(
		stream: BrowserStream,
		workspaceId: string,
		sessionFile?: string,
	): Promise<void> {
		// An explicit no-pick request supersedes an earlier refusal.
		if (sessionFile === undefined) this.#refusedResumes.delete(workspaceId);
		// Registered BEFORE the first await, so it is in place before this
		// spawn_resume is acked. The browser sends its attach only
		// after that ack, so the attach always finds this entry and waits for
		// the validation instead of waking the session on lastSessionFile and
		// silently dropping the pick. The synchronous registration is what makes
		// that ordering sufficient.
		const run = this.#runSpawnResume(workspaceId, sessionFile).then(
			() => {
				if (sessionFile !== undefined) this.#refusedResumes.delete(workspaceId);
			},
			(err: unknown) => {
				const reason = err instanceof Error ? err.message : String(err);
				this.#sendError(stream, reason);
				// Recorded so the attach that follows, and any later attach before a
				// successful pick or a no-pick request, fails with this reason. A wake
				// without a pick has no target to protect, so it is not recorded. Nor
				// is a status rejection (NotAsleepError): the row is running, so no
				// pick is pending, and a stale reason would fail the wake attach after
				// the session sleeps again.
				if (sessionFile !== undefined && !(err instanceof NotAsleepError)) {
					this.#refusedResumes.set(workspaceId, reason);
				}
			},
		);
		this.#pendingResumes.set(workspaceId, run);
		try {
			await run;
		} finally {
			if (this.#pendingResumes.get(workspaceId) === run) this.#pendingResumes.delete(workspaceId);
		}
	}

	/**
	 * The validation + wake body of spawn_resume (see #handleSpawnResume).
	 * Rejects with the refusal or wake failure reason; a status rejection (the
	 * row is not asleep or failed) is a NotAsleepError.
	 *
	 * A no-pick request is idempotent: on a row already being woken or up
	 * (connecting, ready, reconnecting: the states #handleAttach also wakes
	 * through) it joins the wake via #waker.wake, which serializes per session
	 * and returns at once when paired. A reload's deep-link restore and the
	 * row's wake click (or a second tab) race exactly this way. A PICKED
	 * request on such a row is an error: a running session cannot honor a
	 * different pick. stopping and a non-failed error also stay errors. These
	 * status rejections are reported to the browser but never recorded in
	 * #refusedResumes: the row is running, so no pick is pending for a later
	 * attach to protect.
	 */
	async #runSpawnResume(workspaceId: string, sessionFile?: string): Promise<void> {
		// Read synchronously, before any await: once this run yields,
		// #handleSpawnResume replaces the slot with this run's own promise.
		const previous = this.#pendingResumes.get(workspaceId);
		// A back-to-back spawn_resume may still be validating its pick or
		// starting the wake; re-read the entry after it (entries are REPLACED
		// on update, so a pre-wait object can carry a stale status).
		await previous;
		const entry = this.#registry.get(workspaceId);
		if (!entry) throw new Error(`unknown session: ${workspaceId}`);
		// A workspace the lifecycle gave up on (status "error", lifecycleStage
		// "failed": any kind) is retried in place by the same start the Retry
		// button sends.
		const failed = entry.status === "error" && entry.lifecycleStage === "failed";
		const waking =
			entry.status === "connecting" || entry.status === "ready" || entry.status === "reconnecting";
		if (waking && sessionFile === undefined) {
			await this.#waker.wake(entry);
			return;
		}
		if (entry.status !== "asleep" && !failed) {
			throw new NotAsleepError(`session ${workspaceId} is not asleep (status ${entry.status})`);
		}
		// A dropdown-picked session must belong to this worktree's session
		// listing; never let an arbitrary path/id reach resume. Clones
		// validate against the fleet store's sessionId (the store key is
		// the SDK session id), never a fleet-local cwd.
		let resumeFile: string | undefined;
		if (sessionFile !== undefined) {
			if (entry.workspace?.kind === "clone") {
				const listed = await listCloneWorkspaceSessions(
					this.#logStore,
					workspaceId,
					RESUME_MEMBERSHIP_LIMIT,
				);
				const ok = listed.some((s) => s.id === sessionFile || s.path === sessionFile);
				if (!ok) throw new Error(`session not in this clone's fleet store: ${sessionFile}`);
				resumeFile = sessionFile;
			} else {
				const listed = await listWorkspaceSessions(entry.cwd ?? "", RESUME_MEMBERSHIP_LIMIT);
				const resolved = realpathOf(sessionFile);
				const ok = listed.some((s) => realpathOf(s.path) === resolved);
				if (!ok) throw new Error(`session file not in this worktree: ${sessionFile}`);
				resumeFile = sessionFile;
			}
		}
		await this.#waker.wake(entry, { resumeFile });
	}

	/**
	 * Handle one browser `attach`: wake the row if needed, then bind this
	 * stream's pipe to it and answer with an id-keyed attach_result.
	 *
	 * Latest attach wins per browser stream. Each call bumps
	 * `stream.attachSeq`, and an attach whose sequence moved on while it
	 * awaited a pending spawn_resume or a wake (seconds for an asleep row)
	 * never opens a pipe: it answers `attach superseded` instead. Without
	 * this, a slow wake finishing after a quicker attach to another row would
	 * re-bind the stream to the earlier click. The superseded wake itself
	 * still completes (the row may stay running). The browser ignores an
	 * attach_result for an id that is no longer its pending attach, so the
	 * failure never toasts or disturbs the current attachment. A reconnect
	 * replaces the stream object; the old handler then reaches #openPipe,
	 * which skips a stream no longer in #browsers.
	 */
	async #handleAttach(
		stream: BrowserStream,
		workspaceId: string,
		commandId: string,
		resume: boolean,
	): Promise<void> {
		const seq = ++stream.attachSeq;
		// The channel adopted at open serves one confirming attach only.
		const adopted = stream.resumable;
		stream.resumable = false;
		if (!this.#registry.get(workspaceId)) {
			this.#sendAttachOutcome(stream, commandId, { error: `unknown session: ${workspaceId}` });
			return;
		}
		// Resume: this socket already carries the browser's session channel for
		// this session (#adoptParked judged the ring and the pair), and the ring
		// replay at open delivered everything it missed. Nothing is primed.
		if (
			resume &&
			adopted &&
			stream.pipe !== null &&
			!stream.pipe.closed &&
			stream.pipe.workspaceId === workspaceId
		) {
			this.#sendAttachOutcome(stream, commandId, { workspaceId, resumed: true });
			return;
		}
		// Re-attach (same or another session) closes the previous pipe first.
		this.#closePipe(stream);
		try {
			// A back-to-back spawn_resume may still be validating its picked
			// session. Await it, then re-read the entry: registry entries are
			// REPLACED on update, so a pre-wait object can carry a stale status.
			await this.#pendingResumes.get(workspaceId);
			if (stream.attachSeq !== seq) {
				this.#sendAttachOutcome(stream, commandId, { error: ATTACH_SUPERSEDED });
				return;
			}
			const entry = this.#registry.get(workspaceId);
			if (!entry) {
				this.#sendAttachOutcome(stream, commandId, { error: `unknown session: ${workspaceId}` });
				return;
			}
			// A refused or failed pick is recorded in #refusedResumes: waking now
			// would resume lastSessionFile, not the session the user picked.
			const refused = this.#refusedResumes.get(workspaceId);
			if (refused !== undefined && entry.status === "asleep") {
				this.#sendAttachOutcome(stream, commandId, { error: refused });
				return;
			}
			// #waker.wake resolves once the session's callback pair is up (or it
			// throws the reason it cannot be); #openPipe then primes the stream.
			await this.#waker.wake(entry);
			if (stream.attachSeq !== seq) {
				this.#sendAttachOutcome(stream, commandId, { error: ATTACH_SUPERSEDED });
				return;
			}
		} catch (err) {
			this.#sendAttachOutcome(stream, commandId, {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		const current = this.#registry.get(workspaceId);
		if (!current) {
			this.#sendAttachOutcome(stream, commandId, { error: `unknown session: ${workspaceId}` });
			return;
		}
		// #openPipe answers the attach: ok once the callback stream is underway
		// (it re-primes on pair replacement), or a keyed failure when it cannot start.
		this.#openPipe(stream, current, commandId);
	}

	// ---------------------------------------------------------------------
	// Proxy pipes
	// ---------------------------------------------------------------------

	/**
	 * Open this browser's dedicated session channel and answer the attach:
	 * bind a callback virtual stream ("browser/<connId>") on the session's
	 * pair. The session primes and replays per stream, and the edge re-sends
	 * stream_open after every pair replacement (finding #28), so the attach
	 * survives drops without a separate dial.
	 */
	#openPipe(stream: BrowserStream, entry: RegistryEntry, commandId: string): void {
		// A racing attach may have replaced stream.pipe while we waited; never leak it.
		this.#closePipe(stream);
		// The browser may have closed while wake was pending; don't bind a
		// stream nobody will close.
		if (!this.#browsers.has(stream)) return;
		this.#openCallbackPipe(stream, entry, commandId);
	}

	/**
	 * Bind a browser's attach to a session's callback virtual stream
	 * ("browser/<connId>"). The session primes + replays per stream: the edge
	 * sends stream_open on bind and after every pair replacement, then
	 * forwards the session's frame envelopes verbatim (priming included) to
	 * this browser. Slow browsers are dropped by #send's cap (drop-and-resume:
	 * the ring and `after` resume close the gap).
	 * A torn-down pair surfaces as the terminal "session connection lost"
	 * error frame; the edge never redials.
	 */
	#openCallbackPipe(stream: BrowserStream, entry: RegistryEntry, commandId: string): void {
		const workspaceId = entry.workspaceId;
		const transport = this.#transport;
		if (!transport) {
			this.#sendAttachOutcome(stream, commandId, {
				error: `session ${workspaceId} attach is unavailable: no callback transport wired`,
			});
			return;
		}
		const connId = randomUUID();
		const streamId = `${CALLBACK_BROWSER_STREAM_PREFIX}${connId}`;
		const pipe: CallbackPipeState = {
			owner: stream,
			workspaceId,
			connId,
			closed: false,
			pairConnectionId: null,
			credits: [],
			creditHead: 0,
			drainedSeq: 0,
			ackedSeq: 0,
			ackedDrained: 0,
			primed: false,
			detach: () => {},
			unsubscribePair: () => {},
		};
		const unsubscribePair = transport.onPairChange(workspaceId, () => {
			const owner = pipe.owner;
			if (owner.pipe !== pipe || pipe.closed) return;
			// A parked channel's browser is away: the new pair's priming would go to
			// a dead socket, so let it go; the browser's next attach primes afresh.
			if (owner.closed) this.#dropParked(owner.client);
			else this.#sendStreamOpen(owner, pipe);
		});
		pipe.unsubscribePair = unsubscribePair;
		pipe.detach = () => transport.detachVirtualStream(workspaceId, streamId);
		stream.pipe = pipe;
		// Attach accepted: the stream is bound below, and from here the
		// transport owns pair liveness (stream_open re-sends on pair change);
		// the browser is attached. Progress rides the lifecycleStage roster
		// broadcasts; attach_result acknowledges the attach as accepted.
		this.#sendAttachOutcome(stream, commandId, { workspaceId });
		const sink: VirtualStreamSink = {
			deliver: (envelope, payloadJson) => {
				const owner = pipe.owner;
				if (owner.pipe !== pipe || pipe.closed) return;
				const before = owner.enqueuedBytes;
				this.#onCallbackEnvelope(owner, pipe, envelope, payloadJson);
				this.#recordCredit(owner, pipe, before, envelope.seq);
			},
		};
		transport.attachVirtualStream(workspaceId, streamId, sink);
		if (stream.pipe !== pipe || pipe.closed) {
			pipe.detach();
			pipe.unsubscribePair();
			return;
		}
		// Pair already live at bind: prime now; onPairChange handles later
		// replacements (and the very first pair-ready when ensure returned
		// before the session dialed).
		if (transport.pairStatus(workspaceId).paired) this.#sendStreamOpen(stream, pipe);
	}

	/**
	 * Send stream_open on this browser's callback stream (prime / re-prime), once
	 * per session pair. Every pair has its own connectionId (one socket, never
	 * resumed), so each new pair is a fresh session pipe: the session re-primes it.
	 */
	#sendStreamOpen(stream: BrowserStream, pipe: CallbackPipeState): void {
		const transport = this.#transport;
		if (!transport || pipe.closed) return;
		const status = transport.pairStatus(pipe.workspaceId);
		if (!status.paired || status.connectionId === null) return;
		if (pipe.pairConnectionId === status.connectionId) return;
		pipe.pairConnectionId = status.connectionId;
		// Every stream_open restarts the session's credit ledger (and ours): frames
		// it sent before this open are never acknowledged.
		pipe.credits = [];
		pipe.creditHead = 0;
		pipe.drainedSeq = 0;
		pipe.ackedSeq = 0;
		pipe.ackedDrained = stream.enqueuedBytes - this.#bufferedBytes(stream);
		const open: StreamOpenControl = { type: "stream_open" };
		transport
			.sendToSession(pipe.workspaceId, {
				streamId: `${CALLBACK_BROWSER_STREAM_PREFIX}${pipe.connId}`,
				kind: "control",
				payload: open,
			})
			.catch(() => {
				// No live pair / send failure: onPairChange re-sends once the
				// pair is (re)established. Never queues or retries blindly.
			});
	}

	/** Route one callback envelope from a browser's clone stream: frame
	 * envelopes forward verbatim (session priming + deltas); stream_resync
	 * controls surface as a stream_reset so the client re-primes; command /
	 * heartbeat are ignored (wrong-direction or transport liveness). */
	#onCallbackEnvelope(
		stream: BrowserStream,
		pipe: CallbackPipeState,
		envelope: CallbackEnvelope,
		payloadJson: string | undefined,
	): void {
		if (envelope.kind !== "frame" && envelope.kind !== "control") return;
		if (envelope.kind === "control") {
			const payload = envelope.payload;
			if (typeof payload === "object" && payload !== null && "type" in payload) {
				if (payload.type === "stream_resync") {
					// The session dropped frames on ITS outbound buffer and pushes a
					// fresh snapshot after this marker; mirror the callback pipe's
					// stream_reset so the client re-primes (never a silent gap).
					pipe.primed = false;
					this.#sendDelta(stream, { type: "stream_reset", reason: "session_resync" });
				}
			}
			return;
		}
		const payload = envelope.payload;
		if (typeof payload !== "object" || payload === null) return;
		this.#onPipeFrame(stream, pipe, payload as Record<string, unknown>, payloadJson);
	}

	/**
	 * Forward a session frame: proto-gate then forward hello_ok, since the
	 * browser's own gate needs it when proxied through the edge (finding #61);
	 * tap and strip per-session broker rosters; STAMP `scope` (the roster
	 * workspace id) on every session-scoped frame (omp-session no longer sends
	 * one) and on `attached` (its required BOOT_HANDLE is replaced by the
	 * roster workspace id through the edge). Global frames pass unchanged. Every forwarded frame is an
	 * edge-local delta for this browser (a fresh seq; RINGED only for the
	 * session's delta types, see #sendDelta, and recoverable via `after`;
	 * unringed priming/answer frames are re-derived on re-attach). The
	 * payload is the already-parsed frame object (an envelope payload is
	 * verbatim JSON); every decision (gate, strip, stamp, answer routing, ring
	 * class) reads that parsed view. When `payloadJson` (the frame's own wire
	 * text, which the browser will JSON.parse) is present, it is forwarded
	 * instead of re-serializing the parsed frame: every transform here is the
	 * identity or the scope stamp, which relayJson splices into the text
	 * (last key wins, as with the spread). Shared by every session stream so
	 * session semantics stay identical.
	 */
	#onPipeFrame(
		stream: BrowserStream,
		pipe: CallbackPipeState,
		frame: Record<string, unknown>,
		payloadJson?: string,
	): void {
		if (frame.type === "hello_ok") {
			// Proto gate: a session speaking a different OMP_PROTO is not
			// drivable, so the stream is terminal. The transport owns the pair;
			// surface the error to the browser and detach this stream.
			if (Number(frame.proto) !== OMP_PROTO) {
				this.#callbackLost(
					stream,
					pipe,
					`proto mismatch: session speaks OMP_PROTO ${String(frame.proto)}, expected ${OMP_PROTO}`,
				);
				return;
			}
			// Finding #61: the gate above proved proto === OMP_PROTO, so
			// forwarding the session's REAL hello_ok gives the browser's own
			// proto check something to run against on the edge stream too (the
			// edge's priming is roster + daemons only). Falls through to the
			// stamping + #sendDelta below like any other global frame.
		}
		// Priming runs hello_ok → … → ready; the channel is resumable once `ready` went.
		if (frame.type === "hello_ok") pipe.primed = false;
		else if (frame.type === "ready") pipe.primed = true;
		if (frame.type === "daemons") {
			// Broker rosters are tapped here (like the control socket) but
			// NEVER forwarded: browsers only ever see the edge's single
			// merged frame (#broadcastDaemons).
			if (Array.isArray(frame.daemons))
				this.#ingestDaemons(pipe.workspaceId, frame.daemons as DaemonInfo[]);
			return;
		}
		if (frame.type === "session_activity") {
			// session_activity is edge-generated and fleet-scoped: sessions never
			// send it, but strip it like `daemons` broker rosters if one ever
			// does; the edge owns the only activity frame browsers see.
			return;
		}
		const stamp = isSessionScopedFrameType(String(frame.type)) || frame.type === "attached";
		const json =
			payloadJson === undefined
				? undefined
				: relayJson(payloadJson, stamp ? pipe.workspaceId : undefined);
		const outgoing = json === undefined && stamp ? { ...frame, scope: pipe.workspaceId } : frame;
		// Id-keyed answers go to the browser that asked, not to every browser
		// whose pipe happens to carry the session's broadcast copy. The stamp
		// never touches `id` or `type`, so routing reads the same on either view.
		if (this.#routeAnswer(frame, outgoing, json)) return;
		this.#sendDelta(stream, outgoing, json);
	}

	/** A callback channel is gone for good: detach the stream and report lost. */
	#callbackLost(
		stream: BrowserStream,
		pipe: CallbackPipeState,
		message = "session connection lost",
	): void {
		if (pipe.closed) return; // intentional teardown already released
		pipe.closed = true;
		if (stream.pipe === pipe) stream.pipe = null;
		pipe.detach();
		pipe.unsubscribePair();
		this.#sendError(stream, message);
	}

	/** Intentional stream teardown (browser close / re-attach / removal): tell the session the stream closed, then detach. */
	#closePipe(stream: BrowserStream): void {
		const pipe = stream.pipe;
		if (!pipe) return;
		stream.pipe = null;
		pipe.closed = true;
		// Callback: tell the session the stream closed, then unbind. Best
		// effort. A missing pair (stop/delete already tore it down) makes
		// sendToSession throw, which is fine: the detach below is the
		// authority, and the session GCs orphan streams itself.
		this.#transport
			?.sendToSession(pipe.workspaceId, {
				streamId: `${CALLBACK_BROWSER_STREAM_PREFIX}${pipe.connId}`,
				kind: "control",
				payload: { type: "stream_close" },
			})
			.catch(() => {});
		pipe.detach();
		pipe.unsubscribePair();
	}

	/** Best-effort control to the session on this pipe's stream (no live pair: nothing to pause or resume). */
	#sendPipeControl(
		pipe: CallbackPipeState,
		payload: StreamPauseControl | StreamResumeControl,
	): void {
		this.#transport
			?.sendToSession(pipe.workspaceId, {
				streamId: `${CALLBACK_BROWSER_STREAM_PREFIX}${pipe.connId}`,
				kind: "control",
				payload,
			})
			.catch(() => {});
	}

	/**
	 * Forward a non-edge command to the attached session as a kind:"command"
	 * envelope on this browser's callback stream (same payload as the
	 * session's command channel; answers ride the stream's frame envelopes).
	 * A missing or unpaired channel fails fast BY ID (finding #59: the client
	 * correlates call() promises only with call_result, so a bare error frame
	 * would leave the promise hanging until its 30s timeout). No offline
	 * queue: a failed send answers the same typed not-attached error. The one
	 * exception: an earlier forward of this id was accepted onto the pair, so
	 * the session may have applied the command; that answer says the outcome
	 * is unknown instead of "not attached".
	 */
	#forwardCommand(stream: BrowserStream, commandId: string, cmd: Record<string, unknown>): void {
		const pipe = stream.pipe;
		const transport = this.#transport;
		// Finding #59: an unattached call must fail fast BY ID; the client
		// correlates call() promises only with call_result, so a bare error
		// frame would leave the promise hanging until its 30s timeout.
		const failNotAttached = (cause?: unknown): void => {
			// An oversize command is refused by name; it never reached the session.
			const refused =
				cause instanceof CallbackError && cause.code === "payload_too_large"
					? cause.message
					: undefined;
			const sent = this.#forwardOrigins.get(commandId)?.sent === true;
			this.#sendAnswer(stream, {
				type: "call_result",
				id: commandId,
				ok: false,
				error:
					refused ??
					(sent
						? "connection to the session process was lost; the change may have been applied, refresh to check"
						: "not attached"),
			});
		};
		if (!pipe || !transport) {
			failNotAttached();
			return;
		}
		// A replayed id is refused when the entry now runs under a different
		// generation (see #recordForwardOrigin). Never silence: the caller is
		// waiting for exactly this frame type.
		const refusal = this.#recordForwardOrigin(
			stream.client.clientId,
			pipe.workspaceId,
			transport.pairStatus(pipe.workspaceId).authorizedGeneration,
			commandId,
			String(cmd.type),
		);
		if (refusal !== null) {
			const answerType = REFUSED_ANSWER_TYPES[String(cmd.type)];
			if (answerType !== undefined) {
				this.#sendAnswer(stream, { type: answerType, id: commandId, ok: false, error: refusal });
			} else {
				this.#sendError(stream, refusal);
			}
			return;
		}
		const origin = this.#forwardOrigins.get(commandId);
		transport
			.sendToSession(pipe.workspaceId, {
				streamId: `${CALLBACK_BROWSER_STREAM_PREFIX}${pipe.connId}`,
				kind: "command",
				payload: cmd,
			})
			.then(() => {
				// Accepted onto the pair: from here on the session may apply it.
				if (origin !== undefined) origin.sent = true;
			})
			.catch(failNotAttached);
	}

	/**
	 * Remember which browser a forwarded command id belongs to, so its answer
	 * can be routed back to exactly that browser (see #routeAnswer). The FIRST
	 * forward wins while the answer is outstanding: a second browser reusing a
	 * numeric id must not steal the correlation (ids are page-unique, so this
	 * only guards hand-crafted collisions and a client's own re-send).
	 *
	 * Returns null when the command may be forwarded, or the error message to
	 * answer an id-keyed refusal with. A replay (the client re-sending an id
	 * whose answer never arrived) is refused when the entry is now served under
	 * a different GENERATION: a respawn or re-enrollment is a different process
	 * with no dedup memory, so forwarding would execute the command twice.
	 */
	#recordForwardOrigin(
		clientId: string | null,
		workspaceId: string,
		generation: number | null,
		id: string,
		type: string,
	): string | null {
		if (clientId === null) return null;
		if (ANSWERED_FORWARD_TYPES[type] !== true) return null;
		const now = Date.now();
		const existing = this.#forwardOrigins.get(id);
		if (existing !== undefined && !existing.delivered) {
			if (existing.workspaceId === workspaceId && existing.generation !== generation) {
				this.#forwardOrigins.delete(id);
				return `session restarted before this command was answered (generation ${String(existing.generation)} → ${String(generation)}); re-issue it`;
			}
			// Still the same generation: refresh the TTL so routing survives as
			// long as the client keeps replaying, and keep the FIRST origin.
			existing.at = now;
			return null;
		}
		for (const [key, origin] of this.#forwardOrigins) {
			if (now - origin.at > COMMAND_DEDUP_WINDOW_MS) this.#forwardOrigins.delete(key);
		}
		this.#forwardOrigins.set(id, {
			clientId,
			workspaceId,
			generation,
			delivered: false,
			sent: existing?.sent === true,
			at: now,
		});
		// Cap the map by dropping DELIVERED records only: forgetting an
		// outstanding id would make its next replay look like a first forward,
		// and a first forward into a replaced process executes the command
		// again. Undelivered records are bounded by the TTL sweep above.
		for (const [key, origin] of this.#forwardOrigins) {
			if (this.#forwardOrigins.size <= FORWARD_ORIGIN_CAP) break;
			if (origin.delivered) this.#forwardOrigins.delete(key);
		}
		return null;
	}

	/**
	 * Route one id-keyed answer from a session pipe to the browser that asked.
	 * Returns true when the frame was consumed: delivered to the origin, or a
	 * duplicate copy of an answer that already reached it (the session
	 * broadcasts to every pipe, so every browser's pipe sees every answer).
	 * False leaves the frame to normal forwarding: an answer this edge never
	 * forwarded a command for has no origin to correlate with.
	 */
	#routeAnswer(
		frame: Record<string, unknown>,
		outgoing: unknown,
		json: string | undefined,
	): boolean {
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (id === undefined || ANSWER_FRAME_TYPES[String(frame.type)] !== true) return false;
		const origin = this.#forwardOrigins.get(id);
		if (origin === undefined) return false;
		if (origin.delivered) return true;
		const target = this.#clients.get(origin.clientId)?.stream ?? null;
		// The origin has no live socket right now (drop-and-resume): keep the
		// record outstanding so its re-sent command's replayed answer still lands.
		if (target === null) return true;
		origin.delivered = true;
		this.#sendAnswer(target, outgoing, json);
		return true;
	}

	// ---------------------------------------------------------------------
	// Sending + broadcasting
	// ---------------------------------------------------------------------

	/** Bytes currently buffered on a browser socket (not yet taken by the kernel). */
	#bufferedBytes(stream: BrowserStream): number {
		return stream.closed ? 0 : stream.ws.getBufferedAmount();
	}

	/**
	 * The one write path to a browser socket. Before the send, a buffer past
	 * the backpressure cap closes the socket 4503 (drop-and-resume); a send the
	 * socket refuses (`send` returned 0: dropped) closes it the same way, so a
	 * frame is never lost silently. Bun is configured with a send limit above
	 * the cap plus a maximum frame, so it never drops first. Returns false when
	 * the message was not sent.
	 */
	#send(stream: BrowserStream, text: string): boolean {
		if (stream.closed) return false;
		this.#noteDrain(stream, false);
		const buffered = stream.ws.getBufferedAmount();
		if (shouldDropFrame(buffered, this.#backpressureBytes)) {
			this.#dropBrowser(stream, "send buffer past the backpressure cap");
			return false;
		}
		// An empty buffer starts the stall clock afresh: only bytes that sit
		// unread count against the socket.
		const now = Date.now();
		if (buffered === 0) stream.progressAt = now;
		if (stream.ws.send(text) === 0) {
			this.#dropBrowser(stream, "send refused");
			return false;
		}
		stream.enqueuedBytes += sentBytes(text);
		stream.lastSendAt = now;
		return true;
	}

	/**
	 * Note how far the browser's socket has drained this stream's queue: move
	 * the stall clock, retire the drain checkpoints it passed, and acknowledge
	 * the session (stream_ack) once STREAM_ACK_STEP_BYTES more drained, or at
	 * once with `flush` (the periodic sweep, so a tail below the step is never
	 * left unacknowledged).
	 */
	#noteDrain(stream: BrowserStream, flush: boolean): void {
		const drained = Math.max(
			stream.drainedMark,
			stream.enqueuedBytes - this.#bufferedBytes(stream),
		);
		if (drained > stream.drainedMark || stream.enqueuedBytes === drained) {
			stream.progressAt = Date.now();
		}
		stream.drainedMark = drained;
		const pipe = stream.pipe;
		if (pipe === null || pipe.closed) return;
		while (pipe.creditHead < pipe.credits.length) {
			const credit = pipe.credits[pipe.creditHead]!;
			if (credit.end > drained) break;
			pipe.drainedSeq = credit.seq;
			pipe.credits[pipe.creditHead++] = undefined;
		}
		if (pipe.creditHead > 1024 && pipe.creditHead * 2 > pipe.credits.length) {
			pipe.credits = pipe.credits.slice(pipe.creditHead);
			pipe.creditHead = 0;
		}
		if (pipe.drainedSeq <= pipe.ackedSeq) return;
		if (!flush && drained - pipe.ackedDrained < STREAM_ACK_STEP_BYTES) return;
		pipe.ackedSeq = pipe.drainedSeq;
		pipe.ackedDrained = drained;
		const ack: StreamAckControl = { type: "stream_ack", seq: pipe.drainedSeq };
		this.#transport
			?.sendToSession(pipe.workspaceId, {
				streamId: `${CALLBACK_BROWSER_STREAM_PREFIX}${pipe.connId}`,
				kind: "control",
				payload: ack,
			})
			.catch(() => {
				// No live pair: the stream re-opens (and its ledger restarts) on the next pair.
			});
	}

	/**
	 * Record that the session envelope `seq` was consumed into this stream's queue
	 * (forwarded, consumed, or dropped alike): it is acknowledged once the queue
	 * has drained past the bytes enqueued so far. `start` is the queue's byte
	 * total before the envelope was processed.
	 */
	#recordCredit(stream: BrowserStream, pipe: CallbackPipeState, start: number, seq: number): void {
		if (pipe.closed || !Number.isFinite(seq)) return;
		const end = stream.enqueuedBytes;
		const tail = pipe.credits.length > pipe.creditHead ? pipe.credits.at(-1) : undefined;
		if (tail !== undefined && end - tail.start < CREDIT_GRAIN_BYTES) {
			tail.end = end;
			tail.seq = seq;
			return;
		}
		pipe.credits.push({ start, end, seq });
	}

	/**
	 * One live session-pipe frame as an edge-local delta: RINGED only when the
	 * session would ring it (isRingedFrameType, finding #5); priming
	 * frames (hello_ok, attached, history, available_commands), unicast
	 * answers (call_result) and per-stream lifecycle (stream_reset) are
	 * re-derivable (re-attach priming / re-sent command) and consume a seq but
	 * no ring entry, exactly like the session's delta counter. A resuming
	 * browser's ring replay therefore has the same deliberate gaps and is
	 * still correct: after() returns only ringed entries newer than `after`.
	 * The gaps that matter are the re-prime frames (EDGE_REPRIME_FRAMES): the
	 * seq of the last one is `client.resetSeq`, and a browser whose `after` is
	 * below it may have missed one, so it cannot resume (#adoptParked) and
	 * re-attaches with a priming instead. A parked channel (no socket) meeting
	 * one is released at once for the same reason.
	 */
	#sendDelta(stream: BrowserStream, frame: unknown, json?: string): void {
		const client = stream.client;
		const type = (frame as { type?: unknown } | null)?.type;
		const reprime = typeof type === "string" && EDGE_REPRIME_FRAMES[type] === true;
		if (reprime && stream.closed) {
			this.#dropParked(client);
			return;
		}
		const seq = client.nextSeq++;
		const message = seqFrameMessage(seq, json ?? JSON.stringify(frame));
		if (typeof type === "string" && isRingedFrameType(type)) client.ring.push(seq, message);
		else if (reprime) client.resetSeq = seq;
		this.#send(stream, message);
	}

	/**
	 * Ring one client's copy of a broadcast; deliver when its socket is
	 * live. `ring: false` still advances the client seq (like priming and
	 * unicast answers) but leaves no ring entry; the frame must be
	 * re-derivable from the next open's priming.
	 */
	#broadcastTo(client: BrowserClient, json: string, ring = true): void {
		const seq = client.nextSeq++;
		const message = seqFrameMessage(seq, json);
		if (ring) client.ring.push(seq, message);
		if (client.stream) this.#send(client.stream, message);
	}

	/** Unicast answer (projects / error): fresh seq but NOT ringed (lost answers are re-sent by the client). */
	#sendAnswer(stream: BrowserStream, frame: unknown, json?: string): void {
		const seq = stream.client.nextSeq++;
		this.#send(stream, seqFrameMessage(seq, json ?? JSON.stringify(frame)));
	}

	#sendError(stream: BrowserStream, error: string): void {
		this.#sendAnswer(stream, { type: "error", error });
	}

	/**
	 * Answer an attach command (finding #28): the id-keyed attach_result
	 * unicast the client settles its pending attach from. `resumed` says the
	 * browser's previous attachment continues (no priming follows).
	 */
	#sendAttachOutcome(
		stream: BrowserStream,
		commandId: string,
		outcome: { workspaceId: string; resumed?: true } | { error: string },
	): void {
		this.#sendAnswer(
			stream,
			"error" in outcome
				? { type: "attach_result", id: commandId, ok: false, error: outcome.error }
				: {
						type: "attach_result",
						id: commandId,
						ok: true,
						workspaceId: outcome.workspaceId,
						...(outcome.resumed === true ? { resumed: true } : {}),
					},
		);
	}

	/**
	 * Broadcast one frame to every browser. Named clients ring EVERY delta,
	 * also while disconnected, so an `after` resume replays the gap;
	 * anonymous sockets ring only what they receive (no resume contract).
	 * `ring: false` skips the ring (re-derivable frames only, e.g.
	 * registered_projects).
	 */
	#broadcast(frame: ServerFrame, opts?: { ring?: boolean }): void {
		const ring = opts?.ring ?? true;
		// Serialize once: every consumer frames the same JSON (only the seq varies).
		const json = JSON.stringify(frame);
		// A send can drop its socket mid-broadcast (4503), which detaches the
		// client from its stream: remember who already got this frame so the
		// disconnected-clients pass below never rings it a second time.
		const served = new Set<BrowserClient>();
		for (const stream of [...this.#browsers]) {
			served.add(stream.client);
			this.#broadcastTo(stream.client, json, ring);
		}
		for (const client of this.#clients.values()) {
			if (!served.has(client)) this.#broadcastTo(client, json, ring);
		}
	}

	/** Broadcast the roster rows one registry mutation changed. Full rosters ride priming only. */
	#broadcastRosterDelta(change: RegistryChange): void {
		if (change.upserted.length === 0 && change.removed.length === 0) return;
		this.#broadcast({
			type: "roster_delta",
			upserted: change.upserted.map((entry) => toRosterEntry(entry)),
			removed: change.removed,
		});
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
	 * Drop-and-resume: a browser socket past the backpressure cap, one whose
	 * send was refused, or one that stopped draining is closed 4503
	 * (slow_consumer); the browser reconnects with `after` and the edge
	 * replays its ring. The client state (ring) survives for the resume; the
	 * pipe is closed + released.
	 */
	#dropBrowser(stream: BrowserStream, why = "slow consumer"): void {
		this.#closeStream(stream, "slow_consumer", why);
	}

	/** Release a stream and close its socket with a typed code; the client's ring survives unless `discard`. */
	#closeStream(
		stream: BrowserStream,
		kind: BrowserCloseKind,
		message: string,
		discard = false,
	): void {
		this.#releaseBrowser(stream, !discard);
		if (discard) this.#discardClient(stream.client);
		const { code, reason } = browserCloseFor(kind, message);
		try {
			stream.ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	/**
	 * The socket is gone (closed by either side, dropped, replaced): forget the
	 * stream, keep the ring for resume. A named client's session channel stays
	 * open, parked on the client, for the reclaim grace (`retain`): it keeps
	 * feeding the ring, so the returning socket resumes from `after` without a
	 * re-prime (see #adoptParked). Any other release closes the channel.
	 * Idempotent.
	 */
	#releaseBrowser(stream: BrowserStream, retain = true): void {
		stream.closed = true;
		this.#browsers.delete(stream);
		const client = stream.client;
		// Identity guard (finding #25): the close of a socket already
		// superseded by a rebind must not null the client's NEW stream.
		const current = client.stream === stream;
		if (
			retain &&
			current &&
			client.clientId !== null &&
			stream.pipe !== null &&
			stream.pipe.primed &&
			!stream.pipe.closed
		) {
			this.#dropParked(client);
			client.parked = stream;
			this.#sendPipeControl(stream.pipe, { type: "stream_pause" });
		} else if (client.parked !== stream) {
			// A parked stream's late socket close (the edge's own close runs the
			// close handler synchronously) must not kill the parked channel.
			this.#closePipe(stream);
		}
		if (current) {
			client.stream = null;
			this.#armClientReclaim(client);
		}
		if (this.#browsers.size === 0) this.#stopKeepalive();
	}

	/** Forget a client's ring at once (sign-out): its replay state belongs to the ended session. */
	#discardClient(client: BrowserClient): void {
		this.#dropParked(client);
		if (client.gcTimer) {
			clearTimeout(client.gcTimer);
			client.gcTimer = null;
		}
		if (client.clientId !== null && this.#clients.get(client.clientId) === client) {
			this.#clients.delete(client.clientId);
		}
	}

	/** Let go of the session channel a dropped socket left parked (idempotent): the session closes the stream, and the browser's next attach primes afresh. */
	#dropParked(client: BrowserClient): void {
		const parked = client.parked;
		if (parked === null) return;
		client.parked = null;
		this.#closePipe(parked);
	}

	/**
	 * A returning socket for a client with a parked session channel (open, before
	 * the ring replay): hand the channel to the new socket when the browser can
	 * continue from it, else close it. It can when the pair is the one the channel
	 * was opened on (same session process and generation), the ring still holds
	 * everything after the browser's `after`, and no frame a ring cannot replay
	 * (priming, a history resync, a stream reset) went by since that point. The
	 * browser's re-attach (`resume`) then confirms the adoption; any other attach
	 * closes the channel like it always did.
	 */
	#adoptParked(client: BrowserClient, stream: BrowserStream, after: number | null): void {
		const parked = client.parked;
		if (parked === null) return;
		client.parked = null;
		const pipe = parked.pipe;
		const pair = pipe === null ? null : this.#transport?.pairStatus(pipe.workspaceId);
		if (
			pipe === null ||
			pipe.closed ||
			pair === null ||
			pair === undefined ||
			!pair.paired ||
			pair.connectionId !== pipe.pairConnectionId ||
			after === null ||
			after < DELTA_SEQ_START ||
			after < client.resetSeq ||
			after < client.ring.evictedThrough
		) {
			this.#closePipe(parked);
			return;
		}
		parked.pipe = null;
		pipe.owner = stream;
		stream.pipe = pipe;
		stream.resumable = true;
		// The parked socket's drain accounting died with it: whatever the session
		// sent was consumed into the ring, so acknowledge it all and count afresh.
		const tail = pipe.credits.at(-1);
		if (tail !== undefined) pipe.drainedSeq = Math.max(pipe.drainedSeq, tail.seq);
		pipe.credits = [];
		pipe.creditHead = 0;
		pipe.ackedDrained = 0;
		this.#noteDrain(stream, true);
		this.#sendPipeControl(pipe, { type: "stream_resume" });
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
			if (client.stream !== null) return;
			this.#dropParked(client);
			this.#clients.delete(client.clientId!);
		}, this.#reclaimMs);
	}

	/**
	 * One sweep per keepalive interval: close sockets whose session expired
	 * (4401), settle the stall clock and drop a socket that holds bytes with no
	 * drain for the stall limit (4503), and ping every socket the edge has not
	 * written to for half an interval (an idle socket is pinged within one
	 * interval, far inside the client's silence deadline).
	 */
	#startKeepalive(): void {
		if (this.#keepaliveTimer) return;
		this.#keepaliveTimer = setInterval(() => {
			const now = Date.now();
			for (const stream of [...this.#browsers]) {
				const session = stream.ws.data.session;
				if (session !== null && now >= session.expiresAt) {
					this.#closeStream(stream, "unauthorized", "session expired", true);
					continue;
				}
				this.#noteDrain(stream, true);
				if (this.#bufferedBytes(stream) > 0 && now - stream.progressAt >= this.#stallMs) {
					this.#dropBrowser(stream, "browser stopped reading");
					continue;
				}
				if (now - stream.lastSendAt >= this.#keepaliveMs / 2) {
					this.#send(stream, pingMessage(now));
				}
			}
		}, this.#keepaliveMs);
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
	 * Keep a frame tap on every registered session and drop taps for removed
	 * ones (evicting their cached rosters). Every session is tapped on its
	 * callback pair's mirrored "control" stream. Idempotent; runs on every
	 * registry change and once at construction.
	 */
	#reconcileControlTaps(): void {
		const live = new Set(this.#registry.list().map((entry) => entry.workspaceId));
		let evicted = false;
		for (const [workspaceId, unsubscribe] of this.#controlTaps) {
			if (live.has(workspaceId)) continue;
			unsubscribe();
			this.#controlTaps.delete(workspaceId);
			this.#daemonsAggregator.remove(workspaceId);
			// A removed session's activity is gone too: never primed, never broadcast.
			this.#sessionActivity.delete(workspaceId);
			evicted = true;
		}
		for (const entry of this.#registry.list()) {
			if (this.#controlTaps.has(entry.workspaceId)) continue;
			const handleFrame = (frame: ServerFrame): void => {
				// Derive realtime activity from the RAW session frames; the tap
				// sees them BEFORE the edge stamps `scope` on proxy pipes, and
				// never reads session_activity back (sessions never send it; the
				// pipe forwarder strips it like `daemons` broker rosters).
				switch (frame.type) {
					case "daemons":
						if (Array.isArray(frame.daemons)) this.#ingestDaemons(entry.workspaceId, frame.daemons);
						break;
					case "state": {
						// A state snapshot carrying the session's pending ui_request ids is
						// authoritative for the open-dialog set: the control mirror is not
						// replayed across a pair drop and a restarted session never sends
						// ui_request_end for the dead process's dialogs, so deltas alone can
						// stick or miss `blocked`. The session publishes state at every
						// pair-up. Older sessions omit the field: deltas only.
						const pending: unknown = frame.state?.pendingUiRequestIds;
						const patch: { streaming: boolean; blocked?: boolean } = {
							streaming: frame.state?.isStreaming === true,
						};
						if (Array.isArray(pending)) {
							const openDialogIds = this.#ensureActivity(entry.workspaceId).openDialogIds;
							openDialogIds.clear();
							for (const id of pending) if (typeof id === "string") openDialogIds.add(id);
							patch.blocked = openDialogIds.size > 0;
						}
						this.#setActivity(entry.workspaceId, patch);
						// The session file the session is on is what respawn resumes
						// (`--resume <lastSessionFile>`); record it whenever it changes.
						// lastSessionPersisted is the session's report that the SDK has
						// written that file: sticky for it, reset when the file changes.
						const state = frame.state as
							| { sessionFile?: unknown; sessionPersisted?: unknown }
							| undefined;
						const sessionFile = state?.sessionFile;
						if (typeof sessionFile === "string" && sessionFile !== "") {
							const current = this.#registry.get(entry.workspaceId);
							const persisted = state?.sessionPersisted === true;
							if (current?.lastSessionFile !== sessionFile) {
								this.#registry.update(entry.workspaceId, {
									lastSessionFile: sessionFile,
									lastSessionPersisted: persisted ? true : undefined,
								});
							} else if (persisted && current?.lastSessionPersisted !== true) {
								this.#registry.update(entry.workspaceId, { lastSessionPersisted: true });
							}
						}
						break;
					}
					case "event":
						// Turn start: the session publishes state at turn end and at
						// pair-up but not when a turn begins (a prompt's resync runs
						// before SDK admission, and wakes, follow-ups and continuations
						// send none), so the mirrored agent_start event is what flips a
						// detached row to working. The next state frame stays authoritative.
						if (frame.event?.type === "agent_start") {
							this.#ensureActivity(entry.workspaceId).pendingTurn = undefined;
							this.#setActivity(entry.workspaceId, { streaming: true });
						} else if (frame.event?.type === "agent_end") {
							// Turn end. yielded === false: the agent continues its own work
							// (retry, compaction continuation, stop reminders). A non-terminal
							// error is a scheduling pause the SDK does not report as a
							// failure. Neither is a turn end. Frames are untrusted JSON, so
							// copy only well-typed outcome fields.
							const end = frame.event as {
								yielded?: unknown;
								isTerminal?: unknown;
								lastAssistant?: unknown;
							};
							const last: { stopReason?: unknown; errorMessage?: unknown } | null =
								typeof end.lastAssistant === "object" && end.lastAssistant !== null
									? end.lastAssistant
									: null;
							if (end.yielded === false) break;
							if (end.isTerminal === false && last?.stopReason === "error") break;
							const outcome: WireTurnOutcome = {};
							if (typeof last?.stopReason === "string") {
								outcome.stopReason = last.stopReason as WireTurnOutcome["stopReason"];
							}
							if (typeof last?.errorMessage === "string") outcome.errorMessage = last.errorMessage;
							this.#ensureActivity(entry.workspaceId).pendingTurn = outcome;
						}
						break;
					case "ui_request": {
						const activity = this.#ensureActivity(entry.workspaceId);
						if (activity.openDialogIds.has(frame.id)) break; // replay of the same open
						activity.openDialogIds.add(frame.id);
						this.#setActivity(entry.workspaceId, { blocked: true });
						break;
					}
					case "ui_request_end": {
						const activity = this.#sessionActivity.get(entry.workspaceId);
						if (activity && activity.openDialogIds.delete(frame.id)) {
							this.#setActivity(entry.workspaceId, { blocked: activity.openDialogIds.size > 0 });
						}
						break;
					}
					default:
						break;
				}
			};
			const transport = this.#transport;
			if (!transport) continue;
			// Sessions mirror their session frames onto the callback pair's
			// control stream; the unsubscribe tears the tap down on eviction.
			this.#controlTaps.set(
				entry.workspaceId,
				transport.onSessionEnvelope(entry.workspaceId, (envelope) => {
					if (envelope.kind !== "frame" || envelope.streamId !== CALLBACK_CONTROL_STREAM_ID) return;
					const payload = envelope.payload;
					if (typeof payload === "object" && payload !== null) {
						handleFrame(payload as ServerFrame);
					}
				}),
			);
		}
		if (evicted) this.#broadcastDaemons();
	}

	/** Get-or-create a session's activity state (starts UNKNOWN). */
	#ensureActivity(workspaceId: string): SessionActivity {
		let activity = this.#sessionActivity.get(workspaceId);
		if (!activity) {
			activity = { known: false, streaming: false, blocked: false, openDialogIds: new Set() };
			this.#sessionActivity.set(workspaceId, activity);
		}
		return activity;
	}

	/**
	 * Merge one dimension of a session's activity and broadcast ONLY on an
	 * actual change (unknown→known counts as a change so the first derivable
	 * frame always surfaces). Not broadcast on removal; the roster status
	 * change dominates the row client-side.
	 */
	#setActivity(workspaceId: string, patch: { streaming?: boolean; blocked?: boolean }): void {
		const activity = this.#ensureActivity(workspaceId);
		const changed =
			!activity.known ||
			(patch.streaming !== undefined && patch.streaming !== activity.streaming) ||
			(patch.blocked !== undefined && patch.blocked !== activity.blocked);
		// The stashed outcome rides ONLY the broadcast of the streaming
		// true→false flip it ended; any other streaming update (a false→false
		// state, a new turn) makes it stale. A true→true state keeps it: the
		// turn end's own state frame has not arrived yet.
		const endedTurn =
			activity.streaming && patch.streaming === false ? activity.pendingTurn : undefined;
		if (patch.streaming !== undefined && !(activity.streaming && patch.streaming)) {
			activity.pendingTurn = undefined;
		}
		if (patch.streaming !== undefined) activity.streaming = patch.streaming;
		if (patch.blocked !== undefined) activity.blocked = patch.blocked;
		activity.known = true;
		if (!changed) return;
		this.#broadcastActivity(workspaceId, endedTurn);
	}

	/**
	 * A row whose process is gone (asleep, error) or is being launched again
	 * (stage preparation/runtime: a restart proves its predecessor dead first)
	 * has no turn and no open dialog. Only a live process's state frame clears
	 * what agent_start or ui_request set, so without this a session that died
	 * mid-turn would prime a stale spinner until its next pair-up state.
	 */
	#resetActivityOfGoneRuntime(entry: RegistryEntry): void {
		const gone =
			entry.status === "asleep" ||
			entry.status === "error" ||
			entry.lifecycleStage === "preparation" ||
			entry.lifecycleStage === "runtime";
		if (!gone) return;
		const activity = this.#sessionActivity.get(entry.workspaceId);
		if (!activity?.known) return;
		activity.openDialogIds.clear();
		activity.pendingTurn = undefined;
		this.#setActivity(entry.workspaceId, { streaming: false, blocked: false });
	}

	/**
	 * Broadcast one session_activity frame to every edge stream. NEVER ringed
	 * (like registered_projects): the frame is re-derivable from the next
	 * open's priming, and a ring replay after priming would regress the
	 * client to a stale value. `endedTurn` is passed only by the one
	 * streaming true→false flip a yielded agent_end caused.
	 */
	#broadcastActivity(workspaceId: string, endedTurn?: WireTurnOutcome): void {
		const activity = this.#sessionActivity.get(workspaceId);
		if (!activity) return;
		// A removed session's tap is gone, but be defensive: never broadcast
		// activity for an id the edge no longer manages.
		if (!this.#registry.get(workspaceId)) return;
		this.#broadcast(
			{
				type: "session_activity",
				workspaceId,
				streaming: activity.streaming,
				blocked: activity.blocked,
				...(endedTurn ? { endedTurn } : {}),
			},
			{ ring: false },
		);
	}

	/**
	 * Delete-gate admission signal: the derived realtime activity of
	 * one session. UNKNOWN (known:false) until the first derivable frame; a
	 * session with no observed activity cannot be proven idle, so callers
	 * refuse deletion while it is live. `live` reports whether the session's
	 * callback pair is currently up (the fleet observes every session's
	 * accepted work only through that pair). Read-only: never mutates.
	 */
	sessionActivity(workspaceId: string): {
		streaming: boolean;
		blocked: boolean;
		known: boolean;
		live: boolean;
	} {
		const live = this.#transport?.pairStatus(workspaceId).paired ?? false;
		const activity = this.#sessionActivity.get(workspaceId);
		if (!activity) return { streaming: false, blocked: false, known: false, live };
		return {
			streaming: activity.streaming,
			blocked: activity.blocked,
			known: activity.known,
			live,
		};
	}

	/** Cache a session's latest broker roster and broadcast the merged frame. */
	#ingestDaemons(workspaceId: string, entries: DaemonInfo[]): void {
		// Removed sessions' frames are ignored: eviction is final even when a
		// stale browser pipe keeps delivering (registry removal unsubscribes
		// the control tap; pipes are only closed on browser close/re-attach).
		const entry = this.#registry.get(workspaceId);
		if (!entry) return;
		this.#daemonsAggregator.ingest(workspaceId, entries, entry.cwd);
		this.#broadcastDaemons();
	}

	/** Broadcast ONE merged {type:"daemons"} frame to every edge stream when the roster changed. */
	#broadcastDaemons(): void {
		const daemons = this.#daemonsAggregator.merge();
		// Every control tap and browser pipe re-delivers the same roster; only a change is worth a ringed frame.
		const serialized = JSON.stringify(daemons);
		if (serialized === this.#lastDaemonsRoster) return;
		this.#lastDaemonsRoster = serialized;
		this.#broadcast({ type: "daemons", daemons });
	}

	// ---------------------------------------------------------------------
	// /ctl routes + static
	// ---------------------------------------------------------------------

	/** GET /ctl/sessions/{id}/stderr: 404 for unknown/non-spawned entries. */
	#handleStderr(workspaceId: string): Response {
		const entry = this.#registry.get(workspaceId);
		if (!entry) {
			return json({ error: "not found" }, 404);
		}
		return json({ text: this.#lifecycle.sessionLogTail(workspaceId) });
	}

	/**
	 * GET /ctl/sessions/{id}/download?path=…: session-file download over the
	 * session's callback pair. The fleet issues a capture bulk correlation and
	 * a download_bulk command on the transport control stream; the session
	 * streams the file back over POST /callback/bulk (multi-part under the 64
	 * MiB aggregate cap). Rides the server-level auth gate (BrowserAuth) and
	 * never touches the fleet's own filesystem. Unknown session → 404; missing
	 * transport → 503; no live pair or too many concurrent downloads → 503; a
	 * failed transfer (session-reported, cancelled, expired) → 502 with the reason.
	 */
	async #handleDownload(req: Request, workspaceId: string): Promise<Response> {
		if (!this.#registry.get(workspaceId)) return json({ error: "not found" }, 404);
		const path = new URL(req.url).searchParams.get("path");
		if (typeof path !== "string" || path === "") {
			return json({ error: "download requires a ?path=" }, 400);
		}
		const transport = this.#transport;
		if (!transport) {
			return json({ error: "download unavailable: no callback transport wired" }, 503);
		}
		let correlation: BulkCorrelation;
		try {
			correlation = transport.createBulkCorrelation(workspaceId, { capture: true });
		} catch (error) {
			const reason = error instanceof Error ? error.message : "bulk transport busy";
			return json({ error: `download unavailable: ${reason}` }, 503);
		}
		// A browser that goes away, or a session that never took the command,
		// fails the transfer now instead of holding its buffered parts until expiry.
		const onAbort = (): void => correlation.cancel("download request aborted");
		req.signal.addEventListener("abort", onAbort, { once: true });
		try {
			try {
				await transport.sendToSession(workspaceId, {
					streamId: CALLBACK_CONTROL_STREAM_ID,
					kind: "command",
					payload: { type: "download_bulk", correlationId: correlation.correlationId, path },
				});
			} catch {
				correlation.cancel("download command not delivered");
				return json(
					{ error: `download unavailable: ${workspaceId} has no live callback pair` },
					503,
				);
			}
			const result = await correlation.done;
			if (result.state !== "received" || result.chunks === undefined) {
				return json({ error: `download failed: ${result.error ?? "transfer aborted"}` }, 502);
			}
			// Stream the parts as received: no reassembly, so the payload is held once.
			const { chunks } = result;
			let next = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = chunks[next];
					next += 1;
					if (chunk === undefined) controller.close();
					else controller.enqueue(chunk);
				},
			});
			const name = path.split("/").pop() ?? "download";
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": "application/octet-stream",
					"content-disposition": `attachment; filename="${name.replace(/["\r\n]/g, "_")}"`,
					"content-length": String(result.bytes),
				},
			});
		} finally {
			req.signal.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * GET /ctl/debug: loopback developer introspection. Bearer credentials are
	 * NEVER exposed, and nothing from the registry's credential or workspace
	 * field reaches this payload. Each session reports its callback pair state
	 * (enrolled, paired, authorized generation); no endpoint is ever stored or
	 * shown.
	 */
	#debugSnapshot(): Record<string, unknown> {
		const hostSnap = this.#lifecycle.hostSnapshot();
		const sessions = this.#registry.list().map((entry) => {
			const uptimeBase = entry.readyAt ?? entry.registeredAt;
			const status = this.#transport?.pairStatus(entry.workspaceId);
			const session: Record<string, unknown> = {
				workspaceId: entry.workspaceId,
				name: entry.name,
				status: entry.status,
				registeredAt: entry.registeredAt,
				uptimeSec: Math.max(0, Math.floor((Date.now() - uptimeBase) / 1000)),
				pair: {
					enrolled: status?.enrolled ?? false,
					paired: status?.paired ?? false,
					authorizedGeneration: status?.authorizedGeneration ?? null,
				},
			};
			if (entry.pid !== undefined) session.pid = entry.pid;
			if (entry.readyAt !== undefined) session.readyAt = entry.readyAt;
			if (entry.error !== undefined) session.error = entry.error;
			const hostRuntime = hostSnap[entry.workspaceId];
			if (hostRuntime) session.host = hostRuntime;
			return session;
		});
		return {
			fleet: {
				port: this.#fleet.port,
				startedAt: this.#fleet.startedAt,
				uptimeSec: Math.max(0, Math.floor((Date.now() - this.#fleet.startedAt) / 1000)),
				statePath: this.#fleet.statePath,
				configPath: this.#fleet.configPath,
				configError: this.#config.loadError ?? null,
			},
			sessions,
			log: this.#eventLog.list(),
		};
	}
}
