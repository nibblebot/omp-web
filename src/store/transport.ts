import { COMMAND_DEDUP_WINDOW_MS } from "../../shared/protocol";
import type { ClientCommand, DaemonInfo, ServerFrame, WebMethodName } from "../../shared/protocol";
import type { DaemonLogsResult, DebugEntry, DebugLevel } from "../state";
import { setState, state } from "../state";
import { authedFetch } from "./auth";

/**
 * Transport domain (Phase 3 store facade split): the RPC/relay layer,
 * POST /command uplink, the call() id-keyed promise map, fleet attach, and
 * the per-daemon logs/stop/restart RPCs. The /events downlink itself
 * (connect() and its onmessage mux) stays in state.ts; this module owns the
 * module-level connection flags and pending maps the mux reads/settles.
 */

// ---------------------------------------------------------------------------
// Client-side debug ring (Debug panel): every transport lifecycle event lands
// here, oldest first; the panel renders the newest entry last. Capped ring.
// The oldest entries drop past DEBUG_RING_CAP.
// ---------------------------------------------------------------------------
export const DEBUG_RING_CAP = 300;

export function pushDebug(level: DebugLevel, source: DebugEntry["source"], message: string): void {
	setState("debugLog", (log) => [
		...log.slice(-(DEBUG_RING_CAP - 1)),
		{ ts: Date.now(), level, source, message },
	]);
}

let connected = false;

/** True while the /events stream is open (between first `open` and a terminal CLOSED). */
export function isConnected(): boolean {
	return connected;
}

/** Mark the /events stream connected/disconnected (connect/teardown in state.ts). */
export function setConnected(value: boolean): void {
	connected = value;
}

/** Off-loopback bearer token from the page URL (?token=…); loopback dev needs none. */
let token: string | null = null;

/** Set the bearer token from the page URL (connect() in state.ts parses it). */
export function setTransportToken(value: string | null): void {
	token = value;
}

/** One page-scoped client id: the fleet edge matches it across the /events
 *  stream and POST /command to route anonymous commands to the owning browser
 *  stream (a bare omp-session ignores both). Shown (truncated) in the Debug
 *  panel; not a secret, as it already rides the query string and headers. */
export const clientId = crypto.randomUUID();

/**
 * Uplink: POST one ClientCommand to /command (202 fire-and-forget accept;
 * answers ride the /events stream only). A non-2xx rejects here so the
 * caller's pending promise settles instead of hanging until timeout.
 */
export function postCommand(cmd: ClientCommand): Promise<void> {
	// Browser auth (P2.4): with a server-side session (signedIn/signedOut/
	// unknown) the /command uplink rides authedFetch — the session cookie is
	// the credential and a 401 transitions to signedOut (sign-in modal). When
	// auth is DISABLED the path stays a plain fetch: byte-identical behavior
	// to before this integration, no probe, no CSRF.
	const authOn = state.authStatus !== "disabled";
	const doFetch = authOn ? authedFetch : fetch;
	return doFetch("/command", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Omp-Client-Id": clientId,
			...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(cmd),
	}).then((res) => {
		if (!res.ok) {
			pushDebug("error", "command", `command "${cmd.type}" rejected (HTTP ${res.status})`);
			throw new Error(`command "${cmd.type}" rejected (HTTP ${res.status})`);
		}
	});
}

// ---------------------------------------------------------------------------
// call() relay: id-keyed promise map resolved by matching call_result frames.
// ---------------------------------------------------------------------------

/**
 * Replay cadence for a call whose answer never arrived. call_result is a
 * non-ringed unicast answer (server/sse-delivery.ts), so when the daemon-pipe
 * downlink drops it — drop-and-resume backpressure, an emission while the pipe
 * is mid-redial, a lost accept — nothing else replays it and the pending call
 * would hang until its own timeout. Re-POSTing the SAME command id recovers
 * it: the daemon dedups the id within COMMAND_DEDUP_WINDOW_MS (never
 * re-dispatching) and replays the answer it recorded, so a replay can neither
 * execute the command twice nor report a different outcome.
 */
const CALL_REPLAY_INTERVAL_MS = 5_000;

/** One pending call: its answer settles it, its own command recovers it. */
interface PendingCall {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	/** Timeout handle (0 when the caller passed timeoutMs 0: no deadline). */
	timer: number;
	/** Replay handle (0 while no replay is armed). */
	replayTimer: number;
	/** The exact command to re-POST: verbatim, same id (the dedup key). */
	cmd: Extract<ClientCommand, { type: "call" }>;
	/** When the original POST went out: the at-most-once bound for replays. */
	firstPostAt: number;
}

export const pendingCalls = new Map<string, PendingCall>();

function clearCallTimers(pending: PendingCall): void {
	if (pending.timer !== 0) clearTimeout(pending.timer);
	if (pending.replayTimer !== 0) clearTimeout(pending.replayTimer);
}

/**
 * Settle one pending call from its correlated call_result (connect()'s mux
 * routes the frame here). Unknown ids — timed out, already settled by an
 * earlier copy of the answer, stale session — are ignored.
 */
export function settleCallResult(frame: Extract<ServerFrame, { type: "call_result" }>): void {
	const pending = pendingCalls.get(frame.id);
	if (!pending) return; // unknown id (timed out or stale): ignore
	pendingCalls.delete(frame.id);
	clearCallTimers(pending);
	if (frame.ok) pending.resolve(frame.data);
	else pending.reject(new Error(frame.error ?? "call failed"));
}

/** Re-POST an unanswered call, then re-arm: a recovered answer may be lost again. */
function scheduleCallReplay(id: string): void {
	const pending = pendingCalls.get(id);
	if (!pending) return;
	pending.replayTimer = window.setTimeout(() => {
		const current = pendingCalls.get(id);
		if (!current) return;
		current.replayTimer = 0;
		// At-most-once bound: past the dedup window the daemon no longer
		// remembers the id, so a re-POST could EXECUTE the command again.
		if (Date.now() - current.firstPostAt > COMMAND_DEDUP_WINDOW_MS) return;
		// A failed replay is not fatal: the call keeps its own deadline, and
		// the next tick re-POSTs again (the daemon replays its answer).
		void postCommand(current.cmd).catch(() => {});
		scheduleCallReplay(id);
	}, CALL_REPLAY_INTERVAL_MS);
}

export function rejectPendingCalls(err: Error): void {
	for (const [id, p] of pendingCalls) {
		clearCallTimers(p);
		p.reject(err);
		pendingCalls.delete(id);
	}
}

/**
 * True when a rejected call was superseded by a session/daemon switch. The
 * in-flight call's result is stale by design (state.ts rejects pending calls
 * with this message when an `attached` frame lands for another session).
 * Switching sessions is expected control flow, NEVER a user-facing error.
 */
export function isSessionSwitchSupersession(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)) === "session switched";
}

export function call(
	method: WebMethodName,
	args: unknown[] = [],
	timeoutMs = 30_000,
	streamId?: number,
): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	// Page-unique: ids from two tabs must never collide. The daemon dedups
	// POSTs by id alone, so a shared id would swallow the other tab's command
	// and a replayed answer would settle the wrong tab's pending call.
	const id = `c${crypto.randomUUID()}`;
	// streamId tags server-side bash/python chunk frames so the client can
	// route them to the in-flight chat item (the bash item id).
	const cmd = {
		type: "call",
		id,
		method,
		args,
		...(streamId !== undefined ? { streamId } : {}),
	} satisfies ClientCommand;
	// OAuth/manual-code flows exceed any sane default; login passes 0.
	const timer =
		timeoutMs > 0
			? window.setTimeout(() => {
					const pending = pendingCalls.get(id);
					if (pending) clearCallTimers(pending);
					pendingCalls.delete(id);
					reject(new Error(`call "${method}" timed out`));
				}, timeoutMs)
			: 0;
	pendingCalls.set(id, {
		resolve,
		reject,
		timer,
		replayTimer: 0,
		cmd,
		firstPostAt: Date.now(),
	});
	postCommand(cmd).catch((err) => {
		const pending = pendingCalls.get(id);
		if (!pending) return; // a racing answer already settled the call
		pendingCalls.delete(id);
		clearCallTimers(pending);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	scheduleCallReplay(id);
	return promise;
}

// ---------------------------------------------------------------------------
// Fleet-edge attach. The edge answers `attach` with an id-keyed unicast
// `attach_result` frame (finding #28): the sessionId is the daemonId, and
// the daemon's own priming (history/state/available_commands) follows the
// proxied attached frame. A bare omp-session never receives attach (its
// sockets are attached from upgrade). An older edge that ignores the attach
// id never sends the keyed frame; the DAEMON_TIMEOUT_MS backstop settles
// the waiter then (#31-style pending map).
// ---------------------------------------------------------------------------
let pendingAttach: {
	id: string;
	/** The roster daemonId this attach targets (race guard for session clearing). */
	sessionId: string;
	resolve: (sessionId: string) => void;
	reject: (err: Error) => void;
	timer: number;
} | null = null;

type AttachCmd = Extract<ClientCommand, { type: "attach" }>;

function requestAttach(cmd: AttachCmd): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	// Latest-wins: a superseded attach resolves to whatever session is current.
	if (pendingAttach) {
		clearTimeout(pendingAttach.timer);
		pendingAttach.resolve(state.currentSessionId);
	}
	// Phase 5: an armed picker gate (a start:true onboarding sender ran but
	// could not know the spawned daemon's id) is stamped with the REAL
	// daemonId now that the attach fires; the attach_result handler matches
	// against exactly this.
	if (state.pendingSessionPicker !== null) setState("pendingSessionPicker", cmd.sessionId);
	const id = cmd.id;
	const timer =
		DAEMON_TIMEOUT_MS > 0
			? window.setTimeout(() => {
					if (pendingAttach?.id === id) {
						pendingAttach = null;
						// The armed gate's attach failed; disarm it.
						if (state.pendingSessionPicker === cmd.sessionId)
							setState("pendingSessionPicker", null);
						reject(new Error("attach timed out"));
					}
				}, DAEMON_TIMEOUT_MS)
			: 0;
	pendingAttach = { id, sessionId: cmd.sessionId, resolve, reject, timer };
	postCommand(cmd).catch((err) => {
		if (pendingAttach?.id === id) {
			clearTimeout(pendingAttach.timer);
			pendingAttach = null;
		}
		// The armed gate's attach failed; disarm it.
		if (state.pendingSessionPicker === cmd.sessionId) setState("pendingSessionPicker", null);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Attach this tab to a daemon in the roster; resolves with its handle. */
export function attachSession(sessionId: string): Promise<string> {
	return requestAttach({ type: "attach", id: crypto.randomUUID(), sessionId });
}

/** The roster daemonId of the in-flight attach, or null when idle. Used as
 *  the race guard for session clearing: a freshly waking daemon reads as
 *  "asleep" in lagging roster frames right after the user clicks wake-attach,
 *  so the clear must not fire while its attach is still settling. */
export function pendingAttachTarget(): string | null {
	return pendingAttach?.sessionId ?? null;
}

/** Reject the in-flight attach waiter (stream teardown in state.ts). */
export function rejectPendingAttach(err: Error): void {
	if (pendingAttach) {
		clearTimeout(pendingAttach.timer);
		pendingAttach.reject(err);
		pendingAttach = null;
	}
}

/**
 * Settle the id-keyed attach_result unicast (connect()'s mux routes the
 * frame here; finding #28). Unrelated global error frames never settle the
 * waiter. Unknown id = superseded/timed out: ignore.
 */
export function settleAttachResult(frame: Extract<ServerFrame, { type: "attach_result" }>): void {
	if (!pendingAttach || pendingAttach.id !== frame.id) return;
	clearTimeout(pendingAttach.timer);
	const pending = pendingAttach;
	pendingAttach = null;
	if (frame.ok && frame.sessionId !== undefined) {
		pending.resolve(frame.sessionId);
		pushDebug("info", "transport", `attach ok: ${frame.sessionId}`);
		// Phase 5: the onboarding daemon's attach settled; ask for
		// its sessions to decide new-vs-resume; the sessions answer
		// clears the gate (the flag stays set until then).
		if (state.pendingSessionPicker === frame.sessionId) {
			void postCommand({
				type: "list_sessions",
				id: crypto.randomUUID(),
			} satisfies ClientCommand).catch(() => {});
		} else if (state.pendingSessionPicker !== null) {
			// An armed gate settled against a DIFFERENT daemon: the
			// onboarding attach was superseded, so disarm before it can
			// fire the picker for the wrong daemon.
			setState("pendingSessionPicker", null);
		}
	} else {
		pending.reject(new Error(frame.error ?? "attach failed"));
		pushDebug("warn", "transport", `attach failed: ${frame.error ?? "unknown error"}`);
		// Phase 5: the armed gate's attach failed; disarm it.
		setState("pendingSessionPicker", null);
	}
}

// ---------------------------------------------------------------------------
// Daemon web exposure: per-daemon logs/stop/restart commands carry an explicit
// id and are answered by unicast daemon_logs_result / daemon_control_result
// frames, resolved through id-keyed pending maps (same timeout style as
// pendingCalls/call). Multiple commands may be in flight concurrently (e.g. a
// log refresh + a stop) so the maps are keyed by id rather than single-slot.
// ---------------------------------------------------------------------------

let nextDaemonCallId = 1;
export const pendingDaemonLogs = new Map<
	string,
	{ resolve: (r: DaemonLogsResult) => void; reject: (err: Error) => void; timer: number }
>();
export const pendingDaemonControl = new Map<
	string,
	{ resolve: (d: DaemonInfo) => void; reject: (err: Error) => void; timer: number }
>();

export function rejectPendingDaemons(err: Error): void {
	for (const [id, p] of pendingDaemonLogs) {
		clearTimeout(p.timer);
		p.reject(err);
		pendingDaemonLogs.delete(id);
	}
	for (const [id, p] of pendingDaemonControl) {
		clearTimeout(p.timer);
		p.reject(err);
		pendingDaemonControl.delete(id);
	}
}

type DaemonLogsCmd = Extract<ClientCommand, { type: "daemon_logs" }>;
type DaemonPending<T> = Map<
	string,
	{ resolve: (v: T) => void; reject: (err: Error) => void; timer: number }
>;

const DAEMON_TIMEOUT_MS = 30_000;

function registerDaemonPending<T>(
	resolve: (v: T) => void,
	reject: (err: Error) => void,
	map: DaemonPending<T>,
): { id: string; timer: number } {
	const id = `d${nextDaemonCallId++}`;
	const timer =
		DAEMON_TIMEOUT_MS > 0
			? window.setTimeout(() => {
					map.delete(id);
					reject(new Error("daemon command timed out"));
				}, DAEMON_TIMEOUT_MS)
			: 0;
	map.set(id, { resolve, reject, timer });
	return { id, timer };
}

/** Fetch daemon log text (default tail 200 lines); resolves with text + broker cursor + state. */
export function requestDaemonLogs(
	projectDir: string,
	name: string,
	opts: { lines?: number; head?: boolean; grep?: string } = {},
): Promise<DaemonLogsResult> {
	const { promise, resolve, reject } = Promise.withResolvers<DaemonLogsResult>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	const cmd: Omit<DaemonLogsCmd, "id"> = {
		type: "daemon_logs",
		projectDir,
		name,
		lines: opts.lines ?? 200,
		...(opts.head !== undefined ? { head: opts.head } : {}),
		...(opts.grep !== undefined ? { grep: opts.grep } : {}),
	};
	const { id, timer } = registerDaemonPending<DaemonLogsResult>(resolve, reject, pendingDaemonLogs);
	postCommand({ ...cmd, id } satisfies ClientCommand).catch((err) => {
		pendingDaemonLogs.delete(id);
		clearTimeout(timer);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Stop a daemon via its broker; resolves with the refreshed DaemonInfo. */
export function stopDaemon(projectDir: string, name: string): Promise<DaemonInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<DaemonInfo>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	const cmd: Omit<Extract<ClientCommand, { type: "daemon_stop" }>, "id"> = {
		type: "daemon_stop",
		projectDir,
		name,
	};
	const { id, timer } = registerDaemonPending<DaemonInfo>(resolve, reject, pendingDaemonControl);
	postCommand({ ...cmd, id } satisfies ClientCommand).catch((err) => {
		pendingDaemonControl.delete(id);
		clearTimeout(timer);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Restart a daemon via its broker; resolves with the refreshed DaemonInfo. */
export function restartDaemon(projectDir: string, name: string): Promise<DaemonInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<DaemonInfo>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	const cmd: Omit<Extract<ClientCommand, { type: "daemon_restart" }>, "id"> = {
		type: "daemon_restart",
		projectDir,
		name,
	};
	const { id, timer } = registerDaemonPending<DaemonInfo>(resolve, reject, pendingDaemonControl);
	postCommand({ ...cmd, id } satisfies ClientCommand).catch((err) => {
		pendingDaemonControl.delete(id);
		clearTimeout(timer);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

// ---------------------------------------------------------------------------
// Raw /ctl/* fetches (fleet control plane, proxied by vite to 127.0.0.1:4722).
// Every consumer used to re-implement the same error taxonomy: the proxy
// answers 502/504 when nothing listens on :4722 (the fleet is still booting or
// not running) and fetch() itself rejects with a TypeError when the proxy
// is down. Both are EXPECTED states that render as notices, not crashes.
// Centralized once here; the actions below add their per-endpoint status
// messages and body parsing.
// ---------------------------------------------------------------------------

/** GET one /ctl/* endpoint through the vite proxy with the shared fleet-
 *  unreachable taxonomy. `unreachable` is the message for BOTH the 502/504
 *  proxy answers and the fetch() network rejection; `statusError` maps any
 *  other non-2xx status to the endpoint's message. Resolves with the raw
 *  Response (the caller parses the body). */
export async function ctlFetch(
	path: string,
	unreachable: string,
	statusError: (status: number) => string,
	/** When set, non-2xx bodies carry the edge's reason ({ error }); read it
	 *  and return the message to throw instead of the status-only fallback. */
	readError?: (res: Response) => Promise<string>,
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(path);
	} catch (err) {
		// fetch() rejects with a TypeError ("Failed to fetch") when nothing
		// listens on :4722 (the fleet is not up). Expected.
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(/failed to fetch|networkerror|fetch failed/i.test(msg) ? unreachable : msg);
	}
	// 502/504: vite's /ctl proxy couldn't reach :4722, so no fleet server
	// (not running, or still booting). Expected.
	if (res.status === 502 || res.status === 504) throw new Error(unreachable);
	if (!res.ok) {
		if (readError) throw new Error(await readError(res));
		throw new Error(statusError(res.status));
	}
	return res;
}

/** GET /ctl/debug, fleet control-plane state (raw payload; the Debug panel
 *  normalizes it tolerantly). Rejects with the panel's established
 *  unreachable/HTTP message vocabulary. */
export async function fetchCtlDebug(): Promise<unknown> {
	const res = await ctlFetch(
		"/ctl/debug",
		"fleet control plane unreachable, no fleet server on :4722",
		(s) => `fleet control plane unreachable (HTTP ${s})`,
	);
	return (await res.json()) as unknown;
}

/** GET /ctl/sessions/{id}/stderr, a daemon's captured stderr tail. */
export async function fetchDaemonStderr(daemonId: string): Promise<{ text: string }> {
	const res = await ctlFetch(
		`/ctl/sessions/${encodeURIComponent(daemonId)}/stderr`,
		"fleet control plane unreachable, no fleet server on :4722",
		(s) => (s === 404 ? "not a spawned daemon, no stderr captured" : `stderr fetch failed (${s})`),
	);
	return (await res.json()) as { text: string };
}

/** GET /ctl/templates, the fleet's spawn template names. */
export async function fetchCtlTemplates(): Promise<string[]> {
	const res = await ctlFetch(
		"/ctl/templates",
		"fleet control plane unreachable, no fleet server on :4722",
		(s) => `templates fetch failed (${s})`,
	);
	return (await res.json()) as string[];
}
