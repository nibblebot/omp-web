import { commandMessage } from "#lib/wire/browser-socket";
import { COMMAND_DEDUP_WINDOW_MS } from "#lib/wire/protocol";
import { commandBytes, commandTooLargeMessage, MAX_COMMAND_BYTES } from "#lib/wire/command-limits";
import type {
	ClientCommand,
	DaemonInfo,
	ServerFrame,
	SessionScope,
	WebMethodName,
} from "#lib/wire/protocol";
import { READ_ONLY_METHODS } from "#lib/wire/protocol";
import { createSignal } from "solid-js";
import type { DaemonLogsResult, DebugEntry, DebugLevel } from "../state";
import { setState, state } from "../state";
import { expireSession } from "./auth";

/**
 * Transport domain (Phase 3 store facade split): the RPC/relay layer,
 * the in-band command uplink over the browser socket, the call() id-keyed
 * promise map, fleet attach, and the per-daemon logs/stop/restart RPCs.
 * The socket itself (connect() and its frame mux) stays in state.ts; this
 * module owns the module-level connection flags, the outbox of commands not
 * yet acked, and the pending maps the mux reads/settles.
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

/** True while the browser socket is open (between its `open` and the drop that ends it). */
export function isConnected(): boolean {
	return connected;
}

/** Mark the browser socket connected/disconnected (connect/teardown in state.ts). */
export function setConnected(value: boolean): void {
	connected = value;
}

/** One page-scoped client id: the browser socket's `client` query parameter,
 *  which keys the server's replay ring across reconnects (a bare omp-session
 *  ignores it). Shown (truncated) in the Debug panel; not a secret, as it
 *  already rides the query string. */
export const clientId = crypto.randomUUID();

// ---------------------------------------------------------------------------
// Uplink: commands ride the browser socket as `{"cmd":...}`; the server answers
// acceptance in band (`ack`, or `nack` with an HTTP-like status), and answers
// to calls arrive as id-keyed frames. A command that is not acked when the
// socket drops stays in the outbox and goes out again, under the SAME id,
// after the next open while it is inside COMMAND_DEDUP_WINDOW_MS (the server
// dedups the id and replays its answer, never re-dispatching).
// ---------------------------------------------------------------------------

/** The send side of the open browser socket. */
interface Uplink {
	send(data: string): void;
}

let uplink: Uplink | null = null;
/** Which open socket `uplink` is (0 before the first); an outbox entry sent on this one is not re-sent. */
let uplinkGen = 0;

/** One command waiting for its ack. */
interface OutboundCommand {
	cmd: ClientCommand;
	/** The `{"cmd":...}` message, encoded once for every (re-)send. */
	text: string;
	/** When the command was first issued: the at-most-once bound for re-sends. */
	firstAt: number;
	/** `uplinkGen` of the socket that last carried it; 0 = never sent. */
	sentGen: number;
	waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

/** Unacked commands by id (every ClientCommand carries one). */
const outbox = new Map<string, OutboundCommand>();

/** Bind (an open socket) or unbind (null: any drop) the command uplink. Does not send: see resendUnsettled. */
export function setUplink(next: Uplink | null): void {
	uplink = next;
	if (next !== null) uplinkGen++;
}

/** Forget the uplink and every unacked command without settling them (test isolation between files sharing a process). */
export function resetUplink(): void {
	uplink = null;
	outbox.clear();
}

function transmit(entry: OutboundCommand): void {
	if (uplink === null) return;
	try {
		uplink.send(entry.text);
		entry.sentGen = uplinkGen;
	} catch {
		// The socket is going away: the entry stays unsent and the next open re-sends it.
	}
}

function settleOutbound(id: string): OutboundCommand | undefined {
	const entry = outbox.get(id);
	if (entry !== undefined) outbox.delete(id);
	return entry;
}

/** The server accepted command `id` (the old 202). */
export function acknowledgeCommand(id: string): void {
	for (const w of settleOutbound(id)?.waiters ?? []) w.resolve();
}

/**
 * The server refused command `id` with an HTTP-like status (the old non-2xx).
 * 413 keeps the server's payload-too-large wording; 401 means the session is
 * gone (sign-in modal, as a 401 on any authed fetch does).
 */
export function refuseCommand(id: string, status: number, error: string): void {
	const entry = settleOutbound(id);
	if (entry === undefined) return;
	const message =
		status === 413 && error !== ""
			? error
			: `command "${entry.cmd.type}" rejected (HTTP ${status})`;
	pushDebug("error", "command", `command "${entry.cmd.type}" rejected (HTTP ${status})`);
	if (status === 401) expireSession();
	for (const w of entry.waiters) w.reject(new Error(message));
}

/** Fail every unacked command (a drop with no reconnect to come). */
export function rejectOutbound(err: Error): void {
	for (const [id, entry] of outbox) {
		outbox.delete(id);
		for (const w of entry.waiters) w.reject(err);
	}
}

/**
 * Uplink: send one ClientCommand over the browser socket. Resolves when the
 * server acks it (answers ride the downlink as frames); rejects on a nack, on
 * an oversize command (refused before sending), or when it stays unacked past
 * COMMAND_DEDUP_WINDOW_MS of socket drops. With no open socket the command
 * waits for the next open.
 */
export function sendCommand(cmd: ClientCommand): Promise<void> {
	const bytes = commandBytes(cmd);
	if (bytes > MAX_COMMAND_BYTES) {
		return Promise.reject(new Error(commandTooLargeMessage(bytes, MAX_COMMAND_BYTES)));
	}
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let entry = outbox.get(cmd.id);
	if (entry === undefined) {
		entry = { cmd, text: commandMessage(cmd), firstAt: Date.now(), sentGen: 0, waiters: [] };
		outbox.set(cmd.id, entry);
	}
	entry.waiters.push({ resolve, reject });
	transmit(entry);
	return promise;
}

/**
 * After a (re)open: send again what the previous socket left unsettled, under
 * the same ids. Unacked commands go out again; a call that was acked but has
 * no answer yet is re-sent too (the server replays the answer it recorded). Both
 * fail with "Disconnected" once past COMMAND_DEDUP_WINDOW_MS, when a re-send
 * could execute twice. A call parked as not attached is left to the attach
 * path (retryNotAttachedCalls / resumeParkedMutations).
 */
export function resendUnsettled(): void {
	if (uplink === null) return;
	const now = Date.now();
	for (const [id, entry] of outbox) {
		if (now - entry.firstAt > COMMAND_DEDUP_WINDOW_MS) {
			outbox.delete(id);
			for (const w of entry.waiters) w.reject(new Error("Disconnected"));
		} else if (entry.sentGen !== uplinkGen) {
			transmit(entry);
		}
	}
	for (const [id, pending] of pendingCalls) {
		if (outbox.has(id) || pending.awaitingAttach || pending.awaitingState) continue;
		if (now - pending.firstPostAt > COMMAND_DEDUP_WINDOW_MS) {
			dropParkedCall(id, pending, new Error("Disconnected"));
		} else {
			sendCall(id);
		}
	}
}

// ---------------------------------------------------------------------------
// call() relay: id-keyed promise map resolved by matching call_result frames.
// ---------------------------------------------------------------------------

/**
 * Replay cadence for a call whose answer never arrived. call_result is a
 * non-ringed unicast answer, so when the edge-to-daemon pipe drops it (an
 * emission while the pipe is mid-redial) or the socket drops it (drop-and-
 * resume backpressure), nothing else replays it and the pending call would
 * hang until its own timeout. Re-sending the SAME command id recovers
 * it: the daemon dedups the id within COMMAND_DEDUP_WINDOW_MS (never
 * re-dispatching) and replays the answer it recorded, so a replay can neither
 * execute the command twice nor report a different outcome. A socket drop is
 * covered at the next open by resendUnsettled.
 */
const CALL_REPLAY_INTERVAL_MS = 5_000;

/** Edge answer for a call it could not forward: no pipe, so no session ran it. */
const NOT_ATTACHED = "not attached";

/** One pending call: its answer settles it, its own command recovers it. */
interface PendingCall {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	/** Timeout handle (0 when the caller passed timeoutMs 0: no deadline). */
	timer: number;
	/** Replay handle (0 while no replay is armed). */
	replayTimer: number;
	/** The exact command to re-send: verbatim, same id (the dedup key). */
	cmd: Extract<ClientCommand, { type: "call" }>;
	/** When the call was first sent: the at-most-once bound for replays. */
	firstPostAt: number;
	/** The edge answered NOT_ATTACHED: parked. An attach re-sends a read at once; a mutation waits for the attachment's `state` frame (awaitingState). */
	awaitingAttach: boolean;
	/** A parked mutation that has seen an `attached` frame: it runs only if the attachment's first `state` frame carries its scope, else it is dropped as "session switched". */
	awaitingState: boolean;
}

export const pendingCalls = new Map<string, PendingCall>();

// pendingCalls is a plain Map, so views over it (isSessionChanging) read this
// revision to re-run whenever a call is added or settles.
const [pendingRevision, bumpPendingRevision] = createSignal(0);

/** Subscribe the caller's reactive scope to pendingCalls changes. */
export function watchPendingCalls(): void {
	pendingRevision();
}

/** Remove one settled call and notify watchers. */
function forgetCall(id: string): void {
	pendingCalls.delete(id);
	// A call nobody waits for any more must not be re-sent after a reconnect.
	outbox.delete(id);
	bumpPendingRevision((rev) => rev + 1);
}

function clearCallTimers(pending: PendingCall): void {
	if (pending.timer !== 0) clearTimeout(pending.timer);
	if (pending.replayTimer !== 0) clearTimeout(pending.replayTimer);
}

/**
 * Settle one pending call from its correlated call_result (connect()'s mux
 * routes the frame here). Unknown ids, timed out, already settled by an
 * earlier copy of the answer, stale session, are ignored.
 */
export function settleCallResult(frame: Extract<ServerFrame, { type: "call_result" }>): void {
	const pending = pendingCalls.get(frame.id);
	if (!pending) return; // unknown id (timed out or stale): ignore
	// The command never reached a session, so the same id is safe to re-send.
	// Park the call: its replay timer keeps re-sending under the same id (never
	// past the dedup window), and an attach re-sends it at once.
	if (
		!frame.ok &&
		frame.error === NOT_ATTACHED &&
		Date.now() - pending.firstPostAt <= COMMAND_DEDUP_WINDOW_MS
	) {
		pending.awaitingAttach = true;
		// A read wants the answer for the session attached when it finally runs,
		// so it drops the scope of the attachment it was issued under (a new
		// generation would reject it as stale). A mutation keeps its scope: it
		// must never run on another attachment (resumeParkedMutations checks
		// it against the next attachment before it is posted again).
		if (READ_ONLY_METHODS[pending.cmd.method] === true && pending.cmd.scope !== undefined)
			pending.cmd = { ...pending.cmd, scope: undefined };
		return;
	}
	forgetCall(frame.id);
	clearCallTimers(pending);
	if (frame.ok) pending.resolve(frame.data);
	else pending.reject(new Error(frame.error ?? "call failed"));
}

/** Re-send an unanswered call, then re-arm: a recovered answer may be lost again. */
function scheduleCallReplay(id: string): void {
	const pending = pendingCalls.get(id);
	if (!pending) return;
	// One chain per call: re-arming replaces any timer already armed.
	clearTimeout(pending.replayTimer);
	pending.replayTimer = window.setTimeout(() => {
		const current = pendingCalls.get(id);
		if (!current) return;
		current.replayTimer = 0;
		// At-most-once bound: past the dedup window the daemon no longer
		// remembers the id, so a re-send could EXECUTE the command again.
		if (Date.now() - current.firstPostAt > COMMAND_DEDUP_WINDOW_MS) {
			if (current.awaitingAttach || current.awaitingState) {
				forgetCall(id);
				clearCallTimers(current);
				current.reject(new Error(NOT_ATTACHED));
			}
			return;
		}
		// A parked mutation never goes out from here: only the attachment's
		// `state` frame (resumeParkedMutations) may decide it still belongs to
		// the attachment it was made for. The timer stays armed for the window
		// bound above.
		// While the socket is down nothing goes out: resendUnsettled re-sends the
		// call at the next open, and this chain only bounds it by the window.
		if (uplink !== null && !isParkedMutation(current)) {
			// A failed replay is not fatal: the call keeps its own deadline, and
			// the next tick re-sends again (the daemon replays its answer).
			void sendCommand(current.cmd).catch(() => {});
		}
		scheduleCallReplay(id);
	}, CALL_REPLAY_INTERVAL_MS);
}

/** A mutation the edge refused as not attached and that has not been re-sent yet. */
function isParkedMutation(pending: PendingCall): boolean {
	return (
		(pending.awaitingAttach || pending.awaitingState) &&
		READ_ONLY_METHODS[pending.cmd.method] !== true
	);
}

function dropParkedCall(id: string, pending: PendingCall, err: Error): void {
	forgetCall(id);
	clearCallTimers(pending);
	pending.reject(err);
}

export function rejectPendingCalls(err: Error): void {
	for (const [id, p] of pendingCalls) {
		clearCallTimers(p);
		p.reject(err);
		forgetCall(id);
	}
}

/** Send a call under its own id and put it on the replay cadence. */
function sendCall(id: string): void {
	const pending = pendingCalls.get(id);
	if (!pending) return;
	sendCommand(pending.cmd).catch((err) => {
		if (pendingCalls.get(id) !== pending) return; // a racing answer already settled the call
		forgetCall(id);
		clearCallTimers(pending);
		pending.reject(err instanceof Error ? err : new Error(String(err)));
	});
	scheduleCallReplay(id);
}

/**
 * Re-send each call the edge answered NOT_ATTACHED. Runs on every `attached`
 * frame, so a call parked while the tab was detached goes out again under the
 * same id (the daemon dedups it and never ran the first copy). A parked read
 * goes out at once, without scope. A parked mutation keeps its scope and waits
 * for the attachment's first `state` frame (resumeParkedMutations). A call past
 * COMMAND_DEDUP_WINDOW_MS fails instead: a re-send could execute twice.
 */
export function retryNotAttachedCalls(): void {
	for (const [id, pending] of pendingCalls) {
		if (!pending.awaitingAttach) continue;
		pending.awaitingAttach = false;
		if (Date.now() - pending.firstPostAt > COMMAND_DEDUP_WINDOW_MS) {
			dropParkedCall(id, pending, new Error(NOT_ATTACHED));
			continue;
		}
		if (READ_ONLY_METHODS[pending.cmd.method] !== true) {
			pending.awaitingState = true;
			continue;
		}
		sendCall(id);
	}
}

/**
 * The attachment's first `state` frame has set `scope`: settle each parked
 * mutation. One made without a scope, or with this attachment's scope (a pair
 * blip that kept the attachment), goes out again under its own id. Any other
 * belongs to an attachment that is gone: it is dropped as "session switched"
 * (silent control flow, see isSessionSwitchSupersession) and never posted.
 */
export function resumeParkedMutations(scope: SessionScope | undefined): void {
	for (const [id, pending] of pendingCalls) {
		if (!pending.awaitingState) continue;
		pending.awaitingState = false;
		if (Date.now() - pending.firstPostAt > COMMAND_DEDUP_WINDOW_MS) {
			dropParkedCall(id, pending, new Error(NOT_ATTACHED));
			continue;
		}
		const made = pending.cmd.scope;
		if (
			made !== undefined &&
			(scope === undefined ||
				made.workspaceId !== scope.workspaceId ||
				made.sessionId !== scope.sessionId ||
				made.generation !== scope.generation)
		) {
			dropParkedCall(id, pending, new Error("session switched"));
			continue;
		}
		sendCall(id);
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
	// commands by id alone, so a shared id would swallow the other tab's command
	// and a replayed answer would settle the wrong tab's pending call.
	const id = `c${crypto.randomUUID()}`;
	// streamId tags server-side bash/python chunk frames so the client can
	// route them to the in-flight chat item (the bash item id).
	const cmd = {
		type: "call",
		id,
		method,
		args,
		scope: state.sessionScope ? { ...state.sessionScope } : undefined,
		...(streamId !== undefined ? { streamId } : {}),
	} satisfies ClientCommand;
	// OAuth/manual-code flows exceed any sane default; login passes 0.
	const timer =
		timeoutMs > 0
			? window.setTimeout(() => {
					const pending = pendingCalls.get(id);
					if (pending) clearCallTimers(pending);
					forgetCall(id);
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
		awaitingAttach: false,
		awaitingState: false,
	});
	bumpPendingRevision((rev) => rev + 1);
	sendCall(id);
	return promise;
}

// ---------------------------------------------------------------------------
// Fleet-edge attach. The edge answers `attach` with an id-keyed unicast
// `attach_result` frame (finding #28): the sessionId is the daemonId, and
// the daemon's own priming (history/state/available_commands) follows the
// proxied attached frame. A bare omp-session never receives attach (its
// sockets are attached from upgrade). An attach that never gets its keyed
// answer is settled by the DAEMON_TIMEOUT_MS backstop (#31-style pending
// map).
// ---------------------------------------------------------------------------
let pendingAttach: {
	id: string;
	/** The roster daemonId this attach targets (race guard for session clearing). */
	sessionId: string;
	resolve: (sessionId: string) => void;
	reject: (err: Error) => void;
	timer: number;
} | null = null;

/** Bumped by every attach request and every pending wake-then-attach (latest wins). */
let attachIntentSeq = 0;

/** Claim the latest attach intent; any later attach request supersedes it. */
export function claimAttachIntent(): number {
	return ++attachIntentSeq;
}

/** Whether `intent` is still the latest attach intent. */
export function isLatestAttachIntent(intent: number): boolean {
	return intent === attachIntentSeq;
}

/** The latest attach intent without claiming a new one: the intent of the attach request just made (attachSession claims its own). */
export function currentAttachIntent(): number {
	return attachIntentSeq;
}

type AttachCmd = Extract<ClientCommand, { type: "attach" }>;

function requestAttach(cmd: AttachCmd): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	attachIntentSeq++;
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
	sendCommand(cmd).catch((err) => {
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

/** Reject the in-flight attach waiter (stream teardown in state.ts); the
 *  attached-frame waiters give up too. */
export function rejectPendingAttach(err: Error): void {
	if (pendingAttach) {
		clearTimeout(pendingAttach.timer);
		pendingAttach.reject(err);
		// The waiter was told "Disconnected": its attach must not run after the reconnect.
		outbox.delete(pendingAttach.id);
		pendingAttach = null;
	}
	settleAttachedFrame("");
}

/** An attachment watch (see watchAttachment). */
interface AttachmentWatch {
	daemonId: string;
	/** The proxied `attached` frame for the daemon has landed. */
	attached: boolean;
	settle: (ready: boolean) => void;
}

const attachmentWatches = new Set<AttachmentWatch>();

/**
 * Watch for the NEXT attachment of `daemonId` to become usable. `done()`
 * resolves true once the proxied `attached` frame for the daemon has landed
 * AND that attachment's first `state` frame has set `state.sessionScope`, so a
 * call posted afterwards carries the new generation's scope. The attach_result
 * answer can land before both frames, and a call posted in that gap carries
 * the previous attachment's scope (a re-attach of the same daemon, such as a
 * wake after a UI stop, keeps the view) or is swept by the frame's "session
 * switched" rejection after the daemon already ran it; a non-idempotent call
 * (newSession) waits here instead of retrying. Register the watch BEFORE the
 * attach is posted so a fast frame is not missed. `done()` arms the
 * DAEMON_TIMEOUT_MS deadline, so a slow wake before it never counts against
 * the wait; it resolves false when an `attached` frame for another session
 * lands first, the stream tears down, the deadline passes, or `cancel()` ran.
 */
export function watchAttachment(daemonId: string): {
	done: () => Promise<boolean>;
	cancel: () => void;
} {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let timer = 0;
	const watch: AttachmentWatch = {
		daemonId,
		attached: false,
		settle: (ready) => {
			attachmentWatches.delete(watch);
			clearTimeout(timer);
			resolve(ready);
		},
	};
	attachmentWatches.add(watch);
	return {
		done: () => {
			if (attachmentWatches.has(watch)) {
				clearTimeout(timer);
				timer = window.setTimeout(() => watch.settle(false), DAEMON_TIMEOUT_MS);
			}
			return promise;
		},
		cancel: () => watch.settle(false),
	};
}

/** An `attached` frame landed (state.ts, after it updated currentSessionId and
 *  cleared the scope): a watch for another session gives up, a watch for this
 *  one now waits for the attachment's first `state` frame. "" = stream teardown,
 *  which ends every watch. */
export function settleAttachedFrame(sessionId: string): void {
	// Each watch deletes only itself, which Set iteration tolerates.
	for (const watch of attachmentWatches) {
		if (sessionId !== "" && sessionId === watch.daemonId) watch.attached = true;
		else watch.settle(false);
	}
}

/** A `state` frame was applied (state.ts, after the scope was set): each watch whose `attached` frame has landed is ready. */
export function settleAttachmentState(): void {
	for (const watch of attachmentWatches) if (watch.attached) watch.settle(true);
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
			void sendCommand({
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
	// A waiter that was told "Disconnected" must not have its command run after the reconnect.
	for (const [id, p] of pendingDaemonLogs) {
		clearTimeout(p.timer);
		p.reject(err);
		pendingDaemonLogs.delete(id);
		outbox.delete(id);
	}
	for (const [id, p] of pendingDaemonControl) {
		clearTimeout(p.timer);
		p.reject(err);
		pendingDaemonControl.delete(id);
		outbox.delete(id);
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
					reject(new Error("session process command timed out"));
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
	sendCommand({ ...cmd, id } satisfies ClientCommand).catch((err) => {
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
	sendCommand({ ...cmd, id } satisfies ClientCommand).catch((err) => {
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
	sendCommand({ ...cmd, id } satisfies ClientCommand).catch((err) => {
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
		(s) =>
			s === 404
				? "not a spawned session process, no stderr captured"
				: `stderr fetch failed (${s})`,
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
