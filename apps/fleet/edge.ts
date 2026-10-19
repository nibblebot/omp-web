/**
 * Fleet edge (Phase 3): the browser-facing half of the aggregate UI.
 *
 * Mounted by fleet/server.ts on the same loopback Bun.serve as the
 * /ctl control API:
 *
 *   - GET /events is the browser SSE downlink. Every open stream gets an
 *     immediate roster + merged-daemons + registered-projects priming
 *     (edge-local seqs 1..k, k < SSE_DELTA_SEQ_START); live `roster_delta` /
 *     `daemon_status` / `daemons` / `registered_projects` broadcasts and
 *     proxied daemon frames follow as SSE events with
 *     edge-local monotonic seqs from SSE_DELTA_SEQ_START, kept in a
 *     per-client SseRing (cap SSE_RING_CAP, byte budget SSE_RING_BYTES) for
 *     Last-Event-ID resume: N ≥ SSE_DELTA_SEQ_START replays ring.after(N)
 *     after priming, anything below skips replay (priming already carries
 *     full current state). Only daemon DELTA types are ringed (mirror of the
 *     daemon's RING_DELTAS, finding #5): priming frames (history,
 *     available_commands) and unicast answers (call_result) ride the live
 *     stream with a seq but no ring entry, re-derivable by re-attach
 *     priming / re-POST, exactly like the daemon. The daemon broadcasts an
 *     answer to every stream it has, so an id-keyed answer is additionally
 *     routed to the ONE browser whose POST asked for it (the pipe's copy is
 *     dropped otherwise), never fanned out to browsers that share nothing
 *     with the command but the daemon.
 *   - POST /command is the browser uplink: one ClientCommand per request,
 *     202 {commandId} on accept, answers ride /events only. Commands are
 *     routed to a browser by the X-Omp-Client-Id header (the browser binds
 *     its stream at /events open with ?client=<id>); a missing or unknown
 *     id is a 400. Fleet-level commands (add_project / sync_projects /
 *     spawn / spawn_resume / stop / remove / attach) are handled here;
 *     attached-session commands (call / login_code / ui_response /
 *     collab_* / daemon_* / list_*) ride the daemon's callback pair. Anything
 *     outside the browser-command allowlist is rejected with an error
 *     frame.
 *   - PAIR ATTACH: one callback virtual stream PER BROWSER ("browser/<connId>"
 *     on the daemon's pair). The daemon primes every new stream, so
 *     hello_ok → attached → history → state → available_commands → ready come
 *     from the session itself. The edge stamps the daemonId as sessionId on
 *     every session-scoped frame and on `attached` (omp-session no longer
 *     sends one). Every daemon dials the fleet, so the edge never dials: an
 *     asleep spawned daemon is respawned
 *     and waited on for PAIR_TIMEOUT_MS, a reconnecting daemon, or a ready one
 *     that just lost its pair, gets REDIAL_GRACE_MS to redial, and an unpaired
 *     remote daemon is refused.
 *     A pair replacement re-primes the stream from zero. A dropped pair ends
 *     the browser's stream with the "daemon connection lost" error frame.
 *     Attach is answered with an id-keyed attach_result frame (finding #28)
 *     so unrelated global error frames never settle a browser's in-flight
 *     attach.
 *   - Backpressure: a browser stream buffering more than the cap (default
 *     SSE_BACKPRESSURE_BYTES) is terminated (drop-and-resume): the browser
 *     reconnects with Last-Event-ID and the edge replays its ring. One slow
 *     browser never stalls the daemon stream or other browsers.
 *   - Real-time daemon activity: the daemon's control-stream envelopes are
 *     tapped and derive per-daemon {streaming, blocked} from state /
 *     ui_request / ui_request_end, broadcasting an edge-generated
 *     {type:"daemon_activity"} frame ONLY on change (never ringed,
 *     re-derivable from the next open's priming). Daemons hold their own
 *     pair, so no browser presence is needed to keep activity live.
 *     daemon_activity is stripped from callback streams like `daemons`
 *     broker rosters.
 *   - Aggregated daemons: every daemon's control-stream envelopes are tapped
 *     for {type:"daemons"} broker rosters. The latest roster per daemonId is
 *     cached (full-replace), merged across daemons, and broadcast as ONE
 *     {type:"daemons"} frame to every edge stream, also on browser open.
 *     Per-daemon daemons frames are stripped from callback streams (the
 *     merged frame is the only one browsers see), and removing a daemon from
 *     the registry evicts its cache (see daemons-aggregator.ts).
 *   - Static dist/ serving lives in static-ui.ts (shared with the UI daemon);
 *     with serveUi false the edge answers 404 JSON for static paths instead.
 *
 * Roster serialization never leaks credentials (enrollment tokens and digests)
 * to browsers (see toRosterEntry).
 */

import { randomUUID } from "node:crypto";
import {
	COMMAND_DEDUP_WINDOW_MS,
	OMP_PROTO,
	SSE_BACKPRESSURE_BYTES,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	SSE_KEEPALIVE_MS,
	SSE_RING_CAP,
	SSE_RING_BYTES,
	type ClientCommand,
	type DaemonEntry,
	type DaemonInfo,
	type PublicProviderProfile,
	type ServerFrame,
	type SessionScopedFrame,
} from "#lib/wire/protocol";
import {
	encodeSseEvent,
	parseSseUnits,
	SSE_PING_BLOCK,
	SSE_PING_EVENT,
	SseRing,
} from "#lib/wire/sse";
import {
	CALLBACK_BROWSER_STREAM_PREFIX,
	CALLBACK_CONTROL_STREAM_ID,
	CallbackError,
} from "#lib/wire/callback-protocol";
import type { CallbackEnvelope } from "#lib/wire/callback-protocol";
import type { FleetConfig } from "./config";
import { isJsonRequest } from "./browser-guard";
import { validateProjectPath } from "./discovery";
import { serveStaticUi } from "./static-ui";
import { BrowseError, browseDirectories } from "./fs-browse";
import { listRecentRoots } from "./recent-roots";
import { DaemonsAggregator } from "./daemons-aggregator";
import type {
	BulkCorrelation,
	DaemonTransportRegistry,
	VirtualStreamSink,
} from "./daemon-transport";
import {
	listCloneDaemonSessions,
	listDaemonSessions,
	type CloneSessionStore,
} from "./daemon-sessions";
import {
	REDIAL_GRACE_MS,
	type Registry,
	type RegistryChange,
	type RegistryEntry,
} from "./registry";
import { PAIR_TIMEOUT_MS, type SpawnSupervisor } from "./supervisor";
import type { FleetEventLog, FleetFacts } from "./events";
import {
	createWorktree,
	deleteWorktree,
	listProjectBranches,
	projectIdForCwd,
	realpathOf,
	registerWorktreeEntry,
	resolveProjectRoot,
	worktreeDeleteInfo,
} from "./worktrees";

/** Reclaim grace for a disconnected browser's ring (Last-Event-ID resume window). */
const CLIENT_RECLAIM_MS = 60_000;

/** Roster-dropdown listing size: the last N sessions of a daemon's worktree. */
const DROPDOWN_SESSION_LIMIT = 10;
/** Picked-session membership: the whole worktree listing, never the dropdown page. */
const RESUME_MEMBERSHIP_LIMIT = Number.POSITIVE_INFINITY;

/**
 * Per-daemon realtime activity, derived by the edge from the raw tapped
 * daemon frames (state → isStreaming; ui_request / ui_request_end → the
 * open-dialog set that drives `blocked`). Starts UNKNOWN per daemon
 * (`known: false`, nothing derived) until the first derivable frame
 * arrives. Never carries credentials.
 */
interface DaemonActivity {
	/** True once at least one derivable frame has been observed (unknown→known is itself a change). */
	known: boolean;
	streaming: boolean;
	blocked: boolean;
	/** ui_request ids currently open on the daemon; `blocked` = size > 0. */
	openDialogIds: Set<string>;
}

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
/** Fleet-proxied session-file download (P3.4): files ride the callback bulk channel. */
const DOWNLOAD_ROUTE = /^\/ctl\/sessions\/([^/]+)\/download$/;

/**
 * Error frame for any browser command outside the allowlist. Phase 6: the
 * mux-era commands and `detach` are gone from ClientCommand, so a stale
 * client sending them (or plain garbage) must not reach the daemon; the
 * edge rejects it with this instead.
 */
const UNKNOWN_COMMAND_MESSAGE = "fleet edge: use spawn/stop/roster";

/**
 * Browser-command allowlist, checked on the RAW parsed frame before any
 * dispatch: edge-handled commands plus the ClientCommand variants forwarded
 * to the attached daemon. `hello` is gone from the protocol (daemon auth is
 * HTTP-level, the bearer header). Anything else is rejected
 * with UNKNOWN_COMMAND_MESSAGE. Typed against ClientCommand so a removed
 * variant stops compiling instead of silently broadening the allowlist.
 */
const BROWSER_COMMAND_LIST = [
	// Handled at the edge.
	"list_project_branches",
	"sync_projects",
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
 * Session-scoped frame types (protocol's SessionScopedFrame). omp-session
 * no longer stamps a sessionId on these; the pipe forwarder adds the
 * daemonId unconditionally so clients proxied through the edge can guard
 * daemon switches. `attached` is handled alongside: its sessionId is REQUIRED
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
	"command_echo",
	"call_result",
	"available_commands",
	"settings_changed",
	"subagent_lifecycle",
	"subagent_progress",
	"ui_request",
	// Finding #16: the dialog's settle marker rides the session scope like the
	// request, so a daemon switch guard applies the same way.
	"ui_request_end",
	"collab_status",
] as const satisfies readonly SessionScopedFrame["type"][];
// Exhaustiveness pin (finding #63): same addition-direction guard as the
// browser-command allowlist; a session-scoped frame added to the union
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
 * never ringed; it is re-derivable by re-attach priming or re-POSTing the
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
	command_echo: true,
	settings_changed: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	ui_request: true,
	// Finding #16: the dialog's settle marker is ringed like the request, so
	// a resume replays request → end (dismissed), never a stale dialog.
	ui_request_end: true,
	collab_status: true,
	ready: true,
	daemons: true,
	error: true,
};

/**
 * Forwarded commands whose answer is id-keyed (ANSWER_FRAME_TYPES) and so
 * routable back to the browser that asked. `login_code`/`ui_response` carry
 * an id too but are answered by no frame, and `list_sessions`/`list_files`
 * answer with unkeyed frames (sessions/files), so neither is routable.
 */
const ANSWERED_FORWARD_TYPES: Record<string, true> = {
	call: true,
	daemon_logs: true,
	daemon_stop: true,
	daemon_restart: true,
};

/** The daemon's id-keyed unicast answers (one pipe copy per attached browser). */
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

/** Cap on remembered forward origins (the daemon's answer cache is capped the same way). */
const FORWARD_ORIGIN_CAP = 256;

/**
 * The browser one forwarded command id belongs to.
 */
interface ForwardOrigin {
	clientId: string;
	/** The daemon the command was forwarded to (the answer must come back from the same one). */
	daemonId: string;
	/** The daemon's authorized enrollment generation at forward time; a changed generation means a new process. */
	generation: number | null;
	/** The answer reached the origin: later pipe copies of it are consumed, not fanned out. */
	delivered: boolean;
	/** An earlier forward of this id was accepted onto the pair, so the session may have applied the command. */
	sent: boolean;
	/** Insertion time, for the TTL sweep (the daemon's dedup window). */
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
	evictRow<T>(daemonId: string, removal: () => Promise<T>): Promise<T>;
	evictProject(projectId: string): Promise<void>;
}

/**
 * Clone lifecycle service injected into the edge (P6/P7 boundary). The edge
 * NEVER stops/removes/deletes a clone workspace through the supervisor,
 * git worktree guards, or registry.remove directly: every clone
 * lifecycle mutation goes through these hooks so the provider lifecycle,
 * admission, and the verify-at-deletion gate cannot be bypassed from the
 * browser surface. All methods throw typed errors whose messages are safe
 * to surface in an error frame. Implemented by fleet/workspace-lifecycle.ts
 * (structural conformance: the edge holds no import on it).
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
	/**
	 * Exactly one member when given; omitted = the project's own path (host-side
	 * providers) or its origin URL (kubernetes).
	 */
	source?: { local?: string; remote?: string; remoteName?: string };
	revision?: string;
	branch?: string;
	start?: boolean;
}

/** The live machinery the edge coordinates. */
export interface EdgeDeps {
	registry: Registry;
	supervisor: SpawnSupervisor;
	config: FleetConfig;
	/** Fleet lifecycle-event ring, surfaced verbatim by /ctl/debug. */
	eventLog: FleetEventLog;
	/** Fleet-wide facts (port/startedAt/state paths) surfaced by /ctl/debug. */
	fleet: FleetFacts;
	/**
	 * Callback transport (P3): every daemon dials the fleet and attaches,
	 * commands, and downloads over its pair. Absent (test construction) =
	 * daemon rows report typed unavailability.
	 */
	transport?: DaemonTransportRegistry;
	/** Clone lifecycle service (create/start/wake/stop/remove/delete). Absent = clone commands answer typed unavailability. */
	lifecycle?: EdgeLifecycleHooks;
	/** Non-clone row eviction (FLC-22). Required: the server owns pair/log-tap/orphan cleanup. */
	eviction: EdgeEvictionHooks;
	/** Boot-static secret-free provider catalog (P1.3), published on registered_projects. Omitted entirely when not configured. */
	providerProfiles?: PublicProviderProfile[];
	/** Fleet transcript store (P3.8) for clone session listing/resume membership. Absent = clone rows list no sessions. */
	logStore?: CloneSessionStore;
	/** Serve the static UI for non-API paths (default true); false = 404 JSON, the split-setup control plane. */
	serveUi?: boolean;
	/** Agent sessions dir (`<agent dir>/sessions`) read for recent-root autocomplete; absent = no recent roots. */
	sessionsDir?: string;
}

/**
 * One browser /events consumer on the edge, keyed by the browser's
 * page-scoped clientId. The ring + seq counter live here so a reconnecting
 * browser (same clientId) resumes from its Last-Event-ID across stream
 * replacement; the state is reclaimed after a grace period with no stream.
 */
interface BrowserClient {
	/** Page-scoped id from ?client= (null for anonymous streams, not command-addressable). */
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
	/** This browser's dedicated daemon channel: a callback virtual stream
	 * ("browser/<connId>" on the daemon's pair). Null while unattached. */
	pipe: CallbackPipeState | null;
}

/**
 * One callback virtual stream: a browser's dedicated "browser/<connId>" pair
 * to a daemon. Daemons dial the fleet, so no inbound dial ever exists. The
 * daemon primes + replays per stream; the edge only forwards envelopes and
 * re-sends stream_open after every pair replacement. Never redials: pair
 * liveness is the transport's job; a dropped pair surfaces as a
 * "daemon connection lost" error frame.
 */
interface CallbackPipeState {
	daemonId: string;
	/** Edge-chosen browser connection id, the "browser/<connId>" stream's suffix. */
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
 * the DaemonEntry fields of a registry entry (never credentials, template,
 * or registeredAt) plus a live uptime in seconds since
 * readyAt (or registeredAt when never ready) and pid.
 *
 * P1.4 clone-workspace projection: the roster surfaces the PUBLIC subset of
 * the fleet-private WorkspaceRecord: kind→workspaceKind,
 * desiredState→desiredState, profileId→providerProfileId, plus the
 * ephemeral lifecycle liveness facts (lifecycleStage/lifecycleError, the
 * same liveness class as status/pid/readyAt). The record's private
 * remainder (providerHandle, cleanup/archive state, clone sources) NEVER
 * crosses this boundary, exactly as RegistryEntry credentials and templates
 * never do: roster frames and registered_projects frames stay free of
 * credentials, private addresses, provider handles, and secret material. Any
 * future workspace field must be mapped here explicitly (or added to the
 * RegisteredProject shape) before it can appear on the wire.
 */
export function toRosterEntry(entry: RegistryEntry): DaemonEntry {
	const roster: DaemonEntry = {
		daemonId: entry.daemonId,
		name: entry.name,
		cwd: entry.cwd,
		project: entry.project,
		labels: [...entry.labels],
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
	if (entry.branch !== undefined) roster.branch = entry.branch;
	if (entry.detachedAt !== undefined) roster.detachedAt = entry.detachedAt;
	if (entry.worktreeLocked === true) roster.worktreeLocked = true;
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
	// fields only: kind/desiredState/profileId from the fleet-private record
	// (legacy entries carry an in-memory inferred workspace after load), and
	// the ephemeral lifecycle liveness facts straight off the entry. The
	// record's providerHandle and everything else private stays off the wire.
	const workspace = entry.workspace;
	if (workspace !== undefined) {
		roster.workspaceKind = workspace.kind;
		roster.desiredState = workspace.desiredState;
		if (workspace.profileId !== undefined) roster.providerProfileId = workspace.profileId;
	}
	if (entry.lifecycleStage !== undefined) roster.lifecycleStage = entry.lifecycleStage;
	if (entry.lifecycleError !== undefined) roster.lifecycleError = entry.lifecycleError;
	return roster;
}

export class FleetEdge {
	readonly #registry: Registry;
	readonly #supervisor: SpawnSupervisor;
	readonly #config: FleetConfig;
	readonly #eventLog: FleetEventLog;
	readonly #fleet: FleetFacts;
	/** Callback transport (P3): clone attach/commands/downloads ride it; undefined = clone rows answer typed unavailability. */
	readonly #transport: DaemonTransportRegistry | undefined;
	/** Clone lifecycle service (P6/P7): every clone mutation goes through it, never a kind-blind edge path. */
	readonly #lifecycle: EdgeLifecycleHooks | undefined;
	/** Non-clone row eviction (FLC-22): every removal of a roster row goes through it. */
	readonly #eviction: EdgeEvictionHooks;
	/** Boot-static secret-free provider catalog, published on registered_projects (P1.3). */
	readonly #providerProfiles: PublicProviderProfile[] | undefined;
	/** Fleet transcript store for clone session listing/resume membership (P3.8). */
	readonly #logStore: CloneSessionStore | undefined;
	readonly #backpressureBytes: number;
	/** Per-client ring byte budget (default SSE_RING_BYTES; finding #5). */
	readonly #ringBytes: number;
	/** Live browser streams (broadcasts + backpressure). */
	readonly #browsers = new Set<BrowserStream>();
	/** Command-addressable browsers by clientId (ring survives stream replacement). */
	readonly #clients = new Map<string, BrowserClient>();
	/**
	 * Forwarded command id → the browser that asked (per-origin correlation).
	 * The daemon broadcasts each unicast answer to ALL its streams, so with one
	 * pipe per browser every browser would otherwise receive every other
	 * browser's answer; a replayed answer could then settle a pending call in
	 * the wrong tab. Answers are delivered to the recorded origin only, and a
	 * duplicate pipe copy of a delivered answer is consumed instead of fanned
	 * out. Entries expire with the daemon's own dedup window.
	 */
	readonly #forwardOrigins = new Map<string, ForwardOrigin>();
	/** daemonIds mid-wake (respawn/redial); serializes spawn_resume + attach. */
	readonly #waking = new Set<string>();
	/**
	 * In-flight spawn_resume work per daemonId, registered synchronously before
	 * its first await so a concurrently arriving attach can await the pick
	 * validation instead of racing past it and waking on lastSessionFile.
	 */
	readonly #pendingResumes = new Map<string, Promise<void>>();
	/**
	 * Reason the last picked spawn_resume for a daemonId was refused or failed.
	 * Set on refusal, cleared on a successful pick or an explicit no-pick
	 * spawn_resume. While set, an attach that would wake the daemon fails with
	 * this reason instead of waking on lastSessionFile.
	 */
	readonly #refusedResumes = new Map<string, string>();
	/** Cached broker rosters per daemonId, merged into the broadcast daemons frame. */
	readonly #daemonsAggregator = new DaemonsAggregator();
	/** Serialized merged roster last broadcast, so an unchanged roster is not re-sent. */
	#lastDaemonsRoster: string | undefined;
	/** Control-socket taps per daemonId (unsubscribe fns), reconciled on registry change. */
	readonly #daemonTaps = new Map<string, () => void>();
	/** Per-daemon realtime activity, derived in the control-socket tap (browser-gated). */
	readonly #daemonActivity = new Map<string, DaemonActivity>();
	/** Keepalive ping events on every open browser stream every SSE_KEEPALIVE_MS. */
	#keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	/** False on the split-setup control plane: static paths answer 404 JSON instead of the UI. */
	readonly #serveUi: boolean;
	readonly #sessionsDir: string | undefined;

	/** Bound once so close() can unset registry.onChange without clobbering a replacement. */
	readonly #onRegistryChange = (change: RegistryChange): void => {
		// A wake ends when the daemon's status leaves "asleep" (spawn_resume's
		// respawn resolves before the fresh child starts dialing, so clearing
		// here, not in #wake, keeps back-to-back attach from double-respawning).
		for (const daemonId of this.#waking) {
			if (this.#registry.get(daemonId)?.status !== "asleep") this.#waking.delete(daemonId);
		}
		// New daemons get a daemons-frame tap; removed ones lose it and their
		// cached rosters are evicted (broadcast so browsers drop the entries).
		this.#reconcileDaemonTaps();
		this.#broadcastRosterDelta(change);
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
		},
	) {
		this.#registry = deps.registry;
		this.#supervisor = deps.supervisor;
		this.#config = deps.config;
		this.#eventLog = deps.eventLog;
		this.#fleet = deps.fleet;
		this.#transport = deps.transport;
		this.#lifecycle = deps.lifecycle;
		this.#eviction = deps.eviction;
		this.#providerProfiles = deps.providerProfiles;
		this.#logStore = deps.logStore;
		this.#backpressureBytes = opts?.backpressureBytes ?? SSE_BACKPRESSURE_BYTES;
		this.#ringBytes = opts?.ringBytes ?? SSE_RING_BYTES;
		this.#serveUi = deps.serveUi ?? true;
		this.#sessionsDir = deps.sessionsDir;
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
			return await serveStaticUi(path);
		} catch (err) {
			return json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
	}

	/** Session status transition → daemon_status broadcast (wired by server.ts). */
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
	 * once via Last-Event-ID resume; the client's per-prime-window
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
					// old EventSource's cancel hasn't fired yet since browser
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
								daemons: this.#registry.list().map((entry) => toRosterEntry(entry)),
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
					// daemon with KNOWN derived activity (unknown ones are omitted;
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
				// rebind; the ring resumes from the browser's Last-Event-ID.
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
		if (!isJsonRequest(req)) return json({ error: "request body must be application/json" }, 415);
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
		const id = typeof cmd.id === "string" ? cmd.id : "";
		// Phase 6: the mux-era commands and detach are gone from
		// ClientCommand. Any type outside the browser allowlist, whether a
		// stale client's removed command or plain garbage, is rejected here
		// so the daemon never sees a command it no longer understands.
		if (BROWSER_COMMAND_TYPES[type] !== true) {
			this.#sendError(stream, UNKNOWN_COMMAND_MESSAGE);
			return json({ commandId: cmd.id }, 202);
		}
		switch (type) {
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
				const remote = typeof cmd.remote === "string" && cmd.remote !== "" ? cmd.remote : undefined;
				void this.#handleListProjectBranches(stream, projectId, remote);
				break;
			}
			case "sync_projects":
				this.#supervisor.syncNow();
				break;
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
				void this.#handleAddProject(stream, id, path);
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
				// local/remote/remoteName; revision/branch/start optional.
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
				let source: CreateCloneInput["source"];
				if (sourceRaw !== undefined) {
					if (typeof sourceRaw !== "object" || sourceRaw === null || Array.isArray(sourceRaw)) {
						this.#sendError(stream, "create_clone: source must be an object");
						break;
					}
					// Exactly one non-empty member. Read through a checked
					// narrowing: absent/empty members are treated as unset.
					const sourceFields = sourceRaw as Record<string, unknown>;
					const given = (["local", "remote", "remoteName"] as const)
						.map((key) => [key, sourceFields[key]] as const)
						.filter(([, value]) => typeof value === "string" && value !== "");
					if (given.length !== 1) {
						this.#sendError(
							stream,
							"create_clone: source must set exactly one of local, remote, or remoteName",
						);
						break;
					}
					source = Object.fromEntries(given) as CreateCloneInput["source"];
				}
				const revision =
					typeof cmd.revision === "string" && cmd.revision !== "" ? cmd.revision : undefined;
				const branch = typeof cmd.branch === "string" && cmd.branch !== "" ? cmd.branch : undefined;
				const start = cmd.start === true ? true : undefined;
				void this.#handleCreateClone(stream, id, {
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
				void this.#handleCreateWorktree(stream, id, projectId, name, {
					baseRef,
					existingBranch,
					start,
				});
				break;
			}
			case "delete_worktree": {
				const daemonId =
					typeof cmd.daemonId === "string" && cmd.daemonId !== "" ? cmd.daemonId : undefined;
				if (daemonId === undefined) {
					this.#sendError(stream, "delete_worktree: missing daemonId");
					break;
				}
				if (cmd.deleteBranch !== undefined && typeof cmd.deleteBranch !== "string") {
					this.#sendError(stream, "delete_worktree: deleteBranch must be a branch name");
					break;
				}
				const deleteBranch =
					typeof cmd.deleteBranch === "string" && cmd.deleteBranch !== ""
						? cmd.deleteBranch
						: undefined;
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

	/**
	 * Answer a roster-dropdown request: the last sessions of one daemon's
	 * worktree, newest-first (the edge lists from disk, so asleep/never-started
	 * daemons answer too, no live process needed). Unknown daemon → error.
	 */
	async #handleListDaemonSessions(stream: BrowserStream, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			// Clone sessions list from the fleet transcript store (P8.4: the
			// owning daemon's session dir lives in the provider volume, never
			// a fleet-local cwd); non-clone sessions list from disk so asleep/
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
	 * add_project: register the main checkout behind `path` (a main checkout,
	 * a linked worktree, or a subdirectory; resolveProjectRoot refuses bare and
	 * non-git paths). Registration never spawns: a sync pass then adds the
	 * project's asleep rows. Answered by add_project_result: the projectId, with
	 * `existing: true` when that checkout was already registered.
	 */
	async #handleAddProject(stream: BrowserStream, id: string, path: string): Promise<void> {
		try {
			const { project, existing } = this.#registry.addProject(await resolveProjectRoot(path));
			this.#supervisor.syncNow();
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

	/**
	 * remove_project: deregister a project and drop all of its rows. Running
	 * rows are shut down and their pair revoked (transcripts kept, disk
	 * untouched). Refused while a clone workspace still belongs to it; the
	 * refusal is checked before any row is stopped.
	 */
	async #handleRemoveProject(stream: BrowserStream, projectId: string): Promise<void> {
		try {
			const rows = this.#registry.list().filter((entry) => entry.projectId === projectId);
			const cloneIds = rows
				.filter((entry) => entry.workspace?.kind === "clone")
				.map((entry) => entry.daemonId);
			if (cloneIds.length > 0) {
				this.#sendError(
					stream,
					`project ${projectId} has clone workspaces: ${cloneIds.join(", ")}`,
				);
				return;
			}
			for (const row of rows) {
				for (const s of this.#browsers) {
					if (s.pipe?.daemonId === row.daemonId) this.#closePipe(s);
				}
			}
			await this.#eviction.evictProject(projectId);
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * create_worktree: git worktree add under workspaceDir for a registered
	 * project (branch = slugified name; existingBranch attaches instead).
	 * With start:true the worktree is spawned (registerWorktreeEntry).
	 * Progress rides the roster/daemon_status broadcasts; the answer is the
	 * unicast workspace_create_result. Staged: a failure names the stage and
	 * leaves prior stages intact (a created-but-unregistered worktree is
	 * picked up by the next project sync).
	 */
	async #handleCreateWorktree(
		stream: BrowserStream,
		id: string,
		projectId: string,
		name: string,
		opts: { baseRef?: string; existingBranch?: string; start?: boolean },
	): Promise<void> {
		const project = this.#registry.projects().find((p) => p.projectId === projectId);
		if (!project) {
			this.#answerWorkspaceCreate(stream, id, { error: `unknown project: ${projectId}` });
			return;
		}
		let worktreePath: string;
		try {
			worktreePath = (
				await createWorktree(project, name, {
					workspaceDir: this.#config.workspaceDir,
					baseRef: opts.baseRef,
					existingBranch: opts.existingBranch,
				})
			).path;
		} catch (err) {
			this.#answerWorkspaceCreate(stream, id, {
				error: `create worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}
		try {
			const entry = await registerWorktreeEntry(
				this.#registry,
				this.#supervisor,
				project,
				worktreePath,
				{ start: opts.start },
			);
			this.#answerWorkspaceCreate(stream, id, { daemonId: entry.daemonId });
		} catch (err) {
			this.#answerWorkspaceCreate(stream, id, {
				error: `register worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	/** Unicast workspace_create_result: the new row's daemonId, or the failure text. */
	#answerWorkspaceCreate(
		stream: BrowserStream,
		id: string,
		outcome: { daemonId: string } | { error: string },
	): void {
		this.#sendAnswer(
			stream,
			"daemonId" in outcome
				? { type: "workspace_create_result", id, ok: true, daemonId: outcome.daemonId }
				: { type: "workspace_create_result", id, ok: false, error: outcome.error },
		);
	}

	/**
	 * create_clone: delegate entirely to the injected lifecycle service (the
	 * SAME create the POST /ctl/clones control-plane route uses, no HTTP
	 * self-proxy, no second lifecycle implementation). Progress + the new
	 * roster entry ride the roster/daemon_status/lifecycleStage broadcasts;
	 * with start:true the lifecycle also ensures the provider compute and
	 * callback pair, so the client's attach follows the same wake path as any
	 * stopped clone. The unicast answer carries the new row's daemonId.
	 */
	async #handleCreateClone(
		stream: BrowserStream,
		id: string,
		input: CreateCloneInput,
	): Promise<void> {
		try {
			if (!this.#lifecycle) {
				throw new Error("create_clone is unavailable: no lifecycle service wired");
			}
			const entry = await this.#lifecycle.createClone(input);
			this.#answerWorkspaceCreate(stream, id, { daemonId: entry.daemonId });
		} catch (err) {
			this.#answerWorkspaceCreate(stream, id, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * delete_worktree: stop the daemon, evict it from the roster, then git
	 * worktree remove (linked + clean only; optional `git branch -d`). The
	 * guards run BEFORE any mutation, so a refusal leaves the daemon and
	 * roster untouched.
	 */
	async #handleDeleteWorktree(
		stream: BrowserStream,
		daemonId: string,
		deleteBranch: string | undefined,
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
				// deletion); NEVER the git-worktree guards below: they reason
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
			const info = await worktreeDeleteInfo(entry);
			if (!info.linked) {
				this.#sendError(stream, info.reason ?? `not a linked worktree: ${path}`);
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
			// Stop + evict only once the guarded removal succeeded (FLC-21): a
			// refused delete leaves the row registered, asleep.
			await this.#eviction.evictRow(daemonId, async () => {
				await deleteWorktree(entry, { deleteBranch });
			});
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * worktree_delete_info: answer with the unicast guard-evidence frame
	 * (linked/dirty/branch merge+push state) for the delete confirmation.
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
				// never crosses this boundary), not git-worktree guard facts.
				this.#sendError(
					stream,
					"clone deletion guard evidence rides lifecycleStage/lifecycleError",
				);
				return;
			}
			const info = await worktreeDeleteInfo(entry);
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
		// An explicit no-pick request supersedes an earlier refusal.
		if (sessionFile === undefined) this.#refusedResumes.delete(daemonId);
		// Registered BEFORE the first await: the roster UI fires the attach
		// back-to-back, and an attach that did not wait for this validation
		// would wake the daemon on lastSessionFile and silently drop the pick.
		const run = this.#runSpawnResume(daemonId, sessionFile).then(
			() => {
				if (sessionFile !== undefined) this.#refusedResumes.delete(daemonId);
			},
			(err: unknown) => {
				const reason = err instanceof Error ? err.message : String(err);
				this.#sendError(stream, reason);
				// Recorded so the attach that follows, and any later attach before a
				// successful pick or a no-pick request, fails with this reason. A wake
				// without a pick has no target to protect, so it is not recorded.
				if (sessionFile !== undefined) this.#refusedResumes.set(daemonId, reason);
			},
		);
		this.#pendingResumes.set(daemonId, run);
		try {
			await run;
		} finally {
			if (this.#pendingResumes.get(daemonId) === run) this.#pendingResumes.delete(daemonId);
		}
	}

	/**
	 * The validation + wake body of spawn_resume (see #handleSpawnResume).
	 * Rejects with the refusal or wake failure reason.
	 */
	async #runSpawnResume(daemonId: string, sessionFile?: string): Promise<void> {
		const entry = this.#registry.get(daemonId);
		if (!entry) throw new Error(`unknown daemon: ${daemonId}`);
		if (entry.status !== "asleep") {
			throw new Error(`daemon ${daemonId} is not asleep (status ${entry.status})`);
		}
		// A dropdown-picked session must belong to this worktree's session
		// listing; never let an arbitrary path/id reach resume. Clones
		// validate against the fleet store's sessionId (the store key is
		// the SDK session id, P8.4), never a fleet-local cwd.
		let resumeFile: string | undefined;
		if (sessionFile !== undefined) {
			if (entry.workspace?.kind === "clone") {
				const listed = await listCloneDaemonSessions(
					this.#logStore,
					daemonId,
					RESUME_MEMBERSHIP_LIMIT,
				);
				const ok = listed.some((s) => s.id === sessionFile || s.path === sessionFile);
				if (!ok) throw new Error(`session not in this clone's fleet store: ${sessionFile}`);
				resumeFile = sessionFile;
			} else {
				const listed = await listDaemonSessions(entry.cwd ?? "", RESUME_MEMBERSHIP_LIMIT);
				const resolved = realpathOf(sessionFile);
				const ok = listed.some((s) => realpathOf(s.path) === resolved);
				if (!ok) throw new Error(`session file not in this worktree: ${sessionFile}`);
				resumeFile = sessionFile;
			}
		}
		await this.#wake(entry, resumeFile);
	}

	async #handleStop(stream: BrowserStream, daemonId: string): Promise<void> {
		try {
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendError(stream, `unknown daemon: ${daemonId}`);
				return;
			}
			if (entry.workspace?.kind === "clone") {
				// Clone stop is the lifecycle's proof-bearing provider stop;
				// NEVER the supervisor paths (they do not manage
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
			// the stopped pair would surface a phantom "daemon connection lost"
			// error (mirrors #handleRemove).
			for (const s of this.#browsers) {
				if (s.pipe?.daemonId === daemonId) this.#closePipe(s);
			}
			try {
				// The supervisor sends ShutdownControl when paired, kills an own
				// child, and revokes the enrollment; it leaves the entry asleep.
				await this.#supervisor.stop(daemonId);
			} catch (err) {
				// Error-safe stop: a failed terminate must not leave the entry
				// "ready" forever; the daemon is being stopped regardless, so
				// flip the status before surfacing the error.
				this.#registry.setStatus(daemonId, "asleep");
				throw err;
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
				// as delete (P7), never registry.remove: dropping the roster
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
			// Removal leaves no process or credential behind: stop, drop the pair
			// state, and remove the row through the server's eviction hook.
			await this.#eviction.evictRow(daemonId, async () => {});
		} catch (err) {
			this.#sendError(stream, err instanceof Error ? err.message : String(err));
		}
	}

	async #handleAttach(
		stream: BrowserStream,
		daemonId: string,
		commandId: string | undefined,
	): Promise<void> {
		if (!this.#registry.get(daemonId)) {
			this.#sendAttachOutcome(stream, commandId, { error: `unknown daemon: ${daemonId}` });
			return;
		}
		// Re-attach (same or another daemon) closes the previous pipe first.
		this.#closePipe(stream);
		try {
			// A back-to-back spawn_resume may still be validating its picked
			// session. Await it, then re-read the entry: registry entries are
			// REPLACED on update, so a pre-wait object can carry a stale status.
			await this.#pendingResumes.get(daemonId);
			const entry = this.#registry.get(daemonId);
			if (!entry) {
				this.#sendAttachOutcome(stream, commandId, { error: `unknown daemon: ${daemonId}` });
				return;
			}
			// A refused or failed pick is recorded in #refusedResumes: waking now
			// would resume lastSessionFile, not the session the user picked.
			const refused = this.#refusedResumes.get(daemonId);
			if (refused !== undefined && entry.status === "asleep") {
				this.#sendAttachOutcome(stream, commandId, { error: refused });
				return;
			}
			// #wake resolves once the daemon's callback pair is up (or it
			// throws the reason it cannot be); #openPipe then primes the stream.
			await this.#wake(entry);
		} catch (err) {
			this.#sendAttachOutcome(stream, commandId, {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		const current = this.#registry.get(daemonId);
		if (!current) {
			this.#sendAttachOutcome(stream, commandId, { error: `unknown daemon: ${daemonId}` });
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
	 * Bring a daemon's callback pair up before an attach or prompt. Every
	 * daemon dials the fleet, so the fleet only ever waits on the pair; it
	 * never dials. A paired daemon returns at once. A reconnecting daemon, or a
	 * ready one that just lost its pair, gets REDIAL_GRACE_MS to redial on its
	 * own. An asleep daemon is
	 * respawned (--resume) and waited on for PAIR_TIMEOUT_MS.
	 * Clone-kind entries go through the lifecycle ensure (provider compute +
	 * enrollment) instead; their pair readiness rides the transport's
	 * onPairChange and is never awaited here. Serialized per daemon: a second
	 * wake while the first is in flight awaits the same pair, never respawning
	 * twice.
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
				// Clone wakes settle on resolve; ensureCloneRunning is
				// idempotent, so a back-to-back wake is safe either way.
				this.#waking.delete(daemonId);
			}
			return;
		}
		const transport = this.#transport;
		if (transport === undefined) throw new Error("session wake is unavailable: no transport wired");
		if (transport.pairStatus(daemonId).paired) return;
		if (this.#waking.has(daemonId)) return;
		this.#waking.add(daemonId);
		try {
			// A reconnecting session, or a ready one that just lost its pair
			// (inside PAIR_LOSS_GRACE_MS), is redialing on its own: give it the
			// grace window before deciding it needs a respawn.
			if (
				(entry.status === "reconnecting" || entry.status === "ready") &&
				(await this.#awaitPair(daemonId, REDIAL_GRACE_MS))
			)
				return;
			// The status may have changed during the wait; respect the live value.
			const status = this.#registry.get(daemonId)?.status ?? entry.status;
			if (status !== "connecting") {
				await this.#supervisor.respawn(
					entry,
					resumeFile && resumeFile.trim() !== "" ? { resumeFile } : undefined,
				);
			}
			if (!(await this.#awaitPair(daemonId, PAIR_TIMEOUT_MS))) {
				throw new Error(`session ${entry.name} did not connect within ${PAIR_TIMEOUT_MS / 1000}s`);
			}
		} catch (err) {
			// A failed wake drops the guard so a later wake can retry. A
			// successful one keeps it until #onRegistryChange sees the status
			// leave "asleep", so a back-to-back wake cannot respawn twice.
			this.#waking.delete(daemonId);
			throw err;
		}
	}

	/**
	 * Open this browser's dedicated session channel and answer the attach:
	 * bind a callback virtual stream ("browser/<connId>") on the session's
	 * pair. The daemon primes and replays per stream, and the edge re-sends
	 * stream_open after every pair replacement (finding #28), so the attach
	 * survives drops without a separate dial.
	 */
	#openPipe(stream: BrowserStream, entry: RegistryEntry, commandId?: string): void {
		// A racing attach may have replaced stream.pipe while we waited; never leak it.
		this.#closePipe(stream);
		// The browser may have closed while wake was pending; don't bind a
		// stream nobody will close.
		if (!this.#browsers.has(stream)) return;
		this.#openCallbackPipe(stream, entry, commandId);
	}

	/**
	 * Resolve true once the session's pair is up, false after timeoutMs. The
	 * pair subscription is released on either outcome.
	 */
	#awaitPair(daemonId: string, timeoutMs: number): Promise<boolean> {
		const transport = this.#transport;
		if (transport === undefined) return Promise.resolve(false);
		if (transport.pairStatus(daemonId).paired) return Promise.resolve(true);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let unsubscribe: () => void = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			resolve(false);
		}, timeoutMs);
		unsubscribe = transport.onPairChange(daemonId, (status) => {
			if (!status.paired) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(true);
		});
		return promise;
	}

	/**
	 * Bind a browser's attach to a daemon's callback virtual stream
	 * ("browser/<connId>"). The daemon primes + replays per stream: the edge
	 * sends stream_open on bind and after every pair replacement, then
	 * forwards the daemon's frame envelopes verbatim (priming included) to
	 * this browser. Slow browsers are dropped (drop-and-resume: the
	 * transport's 4 MiB stream queue bound fires the sink's onBackpressure).
	 * A torn-down pair surfaces as the terminal "daemon connection lost"
	 * error frame; the edge never redials.
	 */
	#openCallbackPipe(stream: BrowserStream, entry: RegistryEntry, commandId?: string): void {
		const daemonId = entry.daemonId;
		const transport = this.#transport;
		if (!transport) {
			this.#sendAttachOutcome(stream, commandId, {
				error: `daemon ${daemonId} attach is unavailable: no callback transport wired`,
			});
			return;
		}
		const connId = randomUUID();
		const streamId = `${CALLBACK_BROWSER_STREAM_PREFIX}${connId}`;
		const pipe: CallbackPipeState = {
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
		// transport owns pair liveness (stream_open re-sends on pair change);
		// the browser is attached. Progress rides the lifecycleStage roster
		// broadcasts; attach_result acknowledges the attach as accepted.
		if (commandId !== undefined)
			this.#sendAttachOutcome(stream, commandId, { sessionId: daemonId });
		const sink: VirtualStreamSink = {
			deliver: (envelope) => {
				if (stream.pipe !== pipe || pipe.closed) return;
				this.#onCallbackEnvelope(stream, pipe, envelope);
			},
			onBackpressure: () => {
				// Transport dropped an envelope on this stream's full 4 MiB
				// queue: drop-and-resume. The ring + the
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
	 * lastSeq is omitted on pair replacement: the per-connection daemon seq
	 * space restarts, so the daemon re-primes from its ring head. */
	#sendStreamOpen(pipe: CallbackPipeState): void {
		const transport = this.#transport;
		if (!transport || pipe.closed) return;
		const status = transport.pairStatus(pipe.daemonId);
		if (!status.paired || status.connectionId === null) return;
		if (pipe.pairConnectionId !== status.connectionId) {
			// New pair: its seq space is fresh; never send a stale lastSeq.
			pipe.pairConnectionId = status.connectionId;
			pipe.lastSeq = 0;
		}
		transport
			.sendToDaemon(pipe.daemonId, {
				streamId: `${CALLBACK_BROWSER_STREAM_PREFIX}${pipe.connId}`,
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
					// fresh snapshot after this marker; mirror the callback pipe's
					// stream_reset so the client re-primes (never a silent gap).
					this.#sendDelta(stream, { type: "stream_reset", reason: "daemon_resync" });
				}
			}
			return;
		}
		const payload = envelope.payload;
		if (typeof payload !== "object" || payload === null) return;
		this.#onPipeFrame(stream, pipe, payload as Record<string, unknown>);
	}

	/**
	 * Forward a session frame: proto-gate then forward hello_ok, since the
	 * browser's own gate needs it when proxied through the edge (finding #61);
	 * tap and strip per-daemon broker rosters; STAMP sessionId = daemonId on
	 * every session-scoped frame (omp-session no longer sends one) and on
	 * `attached` (its required "s1" must read as the daemonId through the
	 * edge). Global frames pass unchanged. Every forwarded frame is an
	 * edge-local delta for this browser (a fresh seq; RINGED only for the
	 * daemon's delta types, see #sendDelta, and recoverable via Last-Event-ID;
	 * unringed priming/answer frames are re-derived on re-attach). The
	 * payload is the already-parsed frame object (an envelope payload is
	 * verbatim JSON). Shared by every session stream so session semantics
	 * stay identical.
	 */
	#onPipeFrame(
		stream: BrowserStream,
		pipe: CallbackPipeState,
		frame: Record<string, unknown>,
	): void {
		if (frame.type === "hello_ok") {
			// Proto gate: a daemon speaking a different OMP_PROTO is not
			// drivable, so the stream is terminal. The transport owns the pair;
			// surface the error to the browser and detach this stream.
			if (Number(frame.proto) !== OMP_PROTO) {
				this.#callbackLost(
					stream,
					pipe,
					`proto mismatch: daemon speaks OMP_PROTO ${String(frame.proto)}, expected ${OMP_PROTO}`,
				);
				return;
			}
			// Finding #61: the gate above proved proto === OMP_PROTO, so
			// forwarding the daemon's REAL hello_ok gives the browser's own
			// proto check something to run against on the edge stream too (the
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
			// does; the edge owns the only activity frame browsers see.
			return;
		}
		const stamped =
			SESSION_SCOPED_FRAME_TYPES[String(frame.type)] === true || frame.type === "attached"
				? { ...frame, sessionId: pipe.daemonId }
				: frame;
		// Id-keyed answers go to the browser that asked, not to every browser
		// whose pipe happens to carry the daemon's broadcast copy.
		if (this.#routeAnswer(stamped)) return;
		this.#sendDelta(stream, stamped);
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

	/** Intentional stream teardown (browser close / re-attach / removal): tell the daemon the stream closed, then detach. */
	#closePipe(stream: BrowserStream): void {
		const pipe = stream.pipe;
		if (!pipe) return;
		stream.pipe = null;
		pipe.closed = true;
		// Callback: tell the daemon the stream closed, then unbind. Best
		// effort. A missing pair (stop/delete already tore it down) makes
		// sendToDaemon throw, which is fine: the detach below is the
		// authority, and the daemon GCs orphan streams itself.
		this.#transport
			?.sendToDaemon(pipe.daemonId, {
				streamId: `${CALLBACK_BROWSER_STREAM_PREFIX}${pipe.connId}`,
				kind: "control",
				payload: { type: "stream_close" },
			})
			.catch(() => {});
		pipe.detach();
		pipe.unsubscribePair();
	}

	/**
	 * Forward a non-edge command to the attached session as a kind:"command"
	 * envelope on this browser's callback stream (same payload as the
	 * session's POST /command; answers ride the stream's frame envelopes).
	 * A missing or unpaired channel fails fast BY ID (finding #59: the client
	 * correlates call() promises only with call_result, so a bare error frame
	 * would leave the promise hanging until its 30s timeout). No offline
	 * queue: a failed send answers the same typed not-attached error. The one
	 * exception: an earlier forward of this id was accepted onto the pair, so
	 * the session may have applied the command; that answer says the outcome
	 * is unknown instead of "not attached".
	 */
	#forwardCommand(stream: BrowserStream, cmd: Record<string, unknown>): void {
		const pipe = stream.pipe;
		const transport = this.#transport;
		// Finding #59: an unattached call must fail fast BY ID; the client
		// correlates call() promises only with call_result, so a bare error
		// frame would leave the promise hanging until its 30s timeout. A
		// malformed id-less command keeps the legacy global error frame.
		const failNotAttached = (cause?: unknown): void => {
			// An oversize command is refused by name; it never reached the session.
			const refused =
				cause instanceof CallbackError && cause.code === "payload_too_large"
					? cause.message
					: undefined;
			const commandId = typeof cmd.id === "string" && cmd.id !== "" ? cmd.id : undefined;
			if (commandId !== undefined) {
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
			} else {
				this.#sendError(stream, refused ?? "not attached");
			}
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
			pipe.daemonId,
			transport.pairStatus(pipe.daemonId).authorizedGeneration,
			cmd,
		);
		if (refusal !== null) {
			const answerType = REFUSED_ANSWER_TYPES[String(cmd.type)];
			const id = typeof cmd.id === "string" ? cmd.id : "";
			if (answerType !== undefined && id !== "") {
				this.#sendAnswer(stream, { type: answerType, id, ok: false, error: refusal });
			} else {
				this.#sendError(stream, refusal);
			}
			return;
		}
		const origin =
			typeof cmd.id === "string" && cmd.id !== "" ? this.#forwardOrigins.get(cmd.id) : undefined;
		transport
			.sendToDaemon(pipe.daemonId, {
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
	 * only guards hand-crafted collisions and a client's own re-POST).
	 *
	 * Returns null when the command may be forwarded, or the error message to
	 * answer an id-keyed refusal with. A replay (the client re-POSTing an id
	 * whose answer never arrived) is refused when the entry is now served under
	 * a different GENERATION: a respawn or re-enrollment is a different process
	 * with no dedup memory, so forwarding would execute the command twice.
	 */
	#recordForwardOrigin(
		clientId: string | null,
		daemonId: string,
		generation: number | null,
		cmd: Record<string, unknown>,
	): string | null {
		if (clientId === null) return null;
		if (ANSWERED_FORWARD_TYPES[String(cmd.type)] !== true) return null;
		const id = typeof cmd.id === "string" && cmd.id !== "" ? cmd.id : undefined;
		if (id === undefined) return null;
		const now = Date.now();
		const existing = this.#forwardOrigins.get(id);
		if (existing !== undefined && !existing.delivered) {
			if (existing.daemonId === daemonId && existing.generation !== generation) {
				this.#forwardOrigins.delete(id);
				return `daemon restarted before this command was answered (generation ${String(existing.generation)} → ${String(generation)}); re-issue it`;
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
			daemonId,
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
	 * Route one id-keyed answer from a daemon pipe to the browser that asked.
	 * Returns true when the frame was consumed: delivered to the origin, or a
	 * duplicate copy of an answer that already reached it (the daemon
	 * broadcasts to every pipe, so every browser's pipe sees every answer).
	 * False leaves the frame to normal forwarding: an answer this edge never
	 * forwarded a command for has no origin to correlate with.
	 */
	#routeAnswer(frame: Record<string, unknown>): boolean {
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (id === undefined || ANSWER_FRAME_TYPES[String(frame.type)] !== true) return false;
		const origin = this.#forwardOrigins.get(id);
		if (origin === undefined) return false;
		if (origin.delivered) return true;
		const target = this.#clients.get(origin.clientId)?.stream ?? null;
		// The origin has no live stream right now (drop-and-resume): keep the
		// record outstanding so its re-POST's replayed answer still lands.
		if (target === null) return true;
		origin.delivered = true;
		this.#sendAnswer(target, frame);
		return true;
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
	 * daemon would ring it (mirror of its RING_DELTAS, finding #5); priming
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
	 * unicast answers) but leaves no ring entry; the frame must be
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
	 * Broadcast one frame to every browser. Named clients ring EVERY delta,
	 * also while disconnected, so a Last-Event-ID resume replays the gap;
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
		if (this.#browsers.size === 0) this.#stopKeepalive();
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
	 * ones (evicting their cached rosters). Every daemon is tapped on its
	 * callback pair's mirrored "control" stream. Idempotent; runs on every
	 * registry change and once at construction.
	 */
	#reconcileDaemonTaps(): void {
		const live = new Set(this.#registry.list().map((entry) => entry.daemonId));
		let evicted = false;
		for (const [daemonId, unsubscribe] of this.#daemonTaps) {
			if (live.has(daemonId)) continue;
			unsubscribe();
			this.#daemonTaps.delete(daemonId);
			this.#daemonsAggregator.remove(daemonId);
			// A removed daemon's activity is gone too: never primed, never broadcast.
			this.#daemonActivity.delete(daemonId);
			evicted = true;
		}
		for (const entry of this.#registry.list()) {
			if (this.#daemonTaps.has(entry.daemonId)) continue;
			const handleFrame = (frame: ServerFrame): void => {
				// Derive realtime activity from the RAW daemon frames; the tap
				// sees them BEFORE the edge stamps sessionId on proxy pipes, and
				// never reads daemon_activity back (daemons never send it; the
				// pipe forwarder strips it like `daemons` broker rosters).
				switch (frame.type) {
					case "daemons":
						if (Array.isArray(frame.daemons)) this.#ingestDaemons(entry.daemonId, frame.daemons);
						break;
					case "state": {
						this.#setActivity(entry.daemonId, { streaming: frame.state?.isStreaming === true });
						// The session file the daemon is on is what respawn resumes
						// (`--resume <lastSessionFile>`); record it whenever it changes.
						// lastSessionPersisted is the daemon's report that the SDK has
						// written that file: sticky for it, reset when the file changes.
						const state = frame.state as
							| { sessionFile?: unknown; sessionPersisted?: unknown }
							| undefined;
						const sessionFile = state?.sessionFile;
						if (typeof sessionFile === "string" && sessionFile !== "") {
							const current = this.#registry.get(entry.daemonId);
							const persisted = state?.sessionPersisted === true;
							if (current?.lastSessionFile !== sessionFile) {
								this.#registry.update(entry.daemonId, {
									lastSessionFile: sessionFile,
									lastSessionPersisted: persisted ? true : undefined,
								});
							} else if (persisted && current?.lastSessionPersisted !== true) {
								this.#registry.update(entry.daemonId, { lastSessionPersisted: true });
							}
						}
						break;
					}
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
							this.#setActivity(entry.daemonId, { blocked: activity.openDialogIds.size > 0 });
						}
						break;
					}
					default:
						break;
				}
			};
			const transport = this.#transport;
			if (!transport) continue;
			// Daemons mirror their session frames onto the callback pair's
			// control stream; the unsubscribe tears the tap down on eviction.
			this.#daemonTaps.set(
				entry.daemonId,
				transport.onDaemonEnvelope(entry.daemonId, (envelope) => {
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
	 * frame always surfaces). Not broadcast on removal; the roster status
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
	 * one daemon. UNKNOWN (known:false) until the first derivable frame; a
	 * daemon with no observed activity cannot be proven idle, so callers
	 * refuse deletion while it is live. `live` reports whether the daemon's
	 * callback pair is currently up (the fleet observes every daemon's
	 * accepted work only through that pair). Read-only: never mutates.
	 */
	daemonActivity(daemonId: string): {
		streaming: boolean;
		blocked: boolean;
		known: boolean;
		live: boolean;
	} {
		const live = this.#transport?.pairStatus(daemonId).paired ?? false;
		const activity = this.#daemonActivity.get(daemonId);
		if (!activity) return { streaming: false, blocked: false, known: false, live };
		return {
			streaming: activity.streaming,
			blocked: activity.blocked,
			known: activity.known,
			live,
		};
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
	#handleStderr(daemonId: string): Response {
		const entry = this.#registry.get(daemonId);
		if (!entry) {
			return json({ error: "not found" }, 404);
		}
		return json({ text: this.#supervisor.stderrTail(daemonId) });
	}

	/**
	 * GET /ctl/sessions/{id}/download?path=…: session-file download over the
	 * session's callback pair. The fleet issues a capture bulk correlation and
	 * a download_bulk command on the transport control stream; the daemon
	 * streams the file back over POST /callback/bulk (multi-part under the 64
	 * MiB aggregate cap). Rides the server-level auth gate (BrowserAuth) and
	 * never touches the fleet's own filesystem. Unknown daemon → 404; missing
	 * transport → 503; no live pair or too many concurrent downloads → 503; a
	 * failed transfer (daemon-reported, cancelled, expired) → 502 with the reason.
	 */
	async #handleDownload(req: Request, daemonId: string): Promise<Response> {
		if (!this.#registry.get(daemonId)) return json({ error: "not found" }, 404);
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
			correlation = transport.createBulkCorrelation(daemonId, { capture: true });
		} catch (error) {
			const reason = error instanceof Error ? error.message : "bulk transport busy";
			return json({ error: `download unavailable: ${reason}` }, 503);
		}
		// A browser that goes away, or a daemon that never took the command,
		// fails the transfer now instead of holding its buffered parts until expiry.
		const onAbort = (): void => correlation.cancel("download request aborted");
		req.signal.addEventListener("abort", onAbort, { once: true });
		try {
			try {
				await transport.sendToDaemon(daemonId, {
					streamId: CALLBACK_CONTROL_STREAM_ID,
					kind: "command",
					payload: { type: "download_bulk", correlationId: correlation.correlationId, path },
				});
			} catch {
				correlation.cancel("download command not delivered");
				return json({ error: `download unavailable: ${daemonId} has no live callback pair` }, 503);
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
		const supervisorSnap = this.#supervisor.snapshot();
		const sessions = this.#registry.list().map((entry) => {
			const uptimeBase = entry.readyAt ?? entry.registeredAt;
			const status = this.#transport?.pairStatus(entry.daemonId);
			const session: Record<string, unknown> = {
				daemonId: entry.daemonId,
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
				configError: this.#config.loadError ?? null,
			},
			sessions,
			log: this.#eventLog.list(),
		};
	}
}
