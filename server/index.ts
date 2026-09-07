import { open, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { discoverAuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { cleanup as postmortemCleanup } from "@oh-my-pi/pi-utils/postmortem";
import type { Server } from "bun";
import type {
	AvailableSlashCommand,
	ClientCommand,
	ServerFrame,
	SessionListEntry,
} from "../shared/protocol";
import {
	COMMAND_DEDUP_ANSWER_CAP,
	COMMAND_DEDUP_ID_CAP,
	COMMAND_DEDUP_WINDOW_MS,
	OMP_PROTO,
	OMP_SESSION_PREFIX,
	SSE_BACKPRESSURE_BYTES,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	type StdoutContractLine,
} from "../shared/protocol";
import { encodeSseEvent } from "../shared/sse";
import { acquireFileLock, LockHeldError } from "../shared/file-lock";
import type { FileLock } from "../shared/file-lock";
import { isLoopbackHost, parseConfig, type SessionConfig } from "./config";
import { FleetCallback, type FleetCallbackStatus } from "./fleet-callback";
import { SessionLogTailer } from "./log-tailer";
import {
	MaterializeSessionError,
	materializeSessionToDir,
	sessionTreeExists,
} from "./session-materialize";
import { CollabHostAdapter } from "./collab-host";
import { createRelay, type RelayHandle, type RelaySocketData } from "./collab-relay";
import { createCollabSession } from "./collab-session";
import { createDaemonBroker } from "./daemon-broker";
import { createWebMethods } from "./methods";
import { BOOT_HANDLE, type SessionEntry } from "./session-entry";
import {
	broadcast,
	broadcastAnswer,
	broadcastHistory,
	broadcastTo,
	detachConsumer,
	enqueuePaced,
	enqueueTo,
	ephemeralAborts,
	notifyEvent,
	pendingCodeInputs,
	ringAfter,
	sendHistoryPaced,
	setOnConsumerDetached,
	setOnStreamsEmpty,
	snapshotDeltaSeq,
	startKeepalive,
	streams,
	terminateStream,
	type SseConsumer,
} from "./sse-delivery";
import { clearSubagents } from "./subagent-mirror";
import { rejectEntryUiRequests, rejectStreamUiRequests, webUiRequest } from "./ui-context";
import { callbackError } from "../shared/callback-protocol";
import type { CallbackEnvelope } from "../shared/callback-protocol";
import { createDaemonControl, type DaemonControl } from "./daemon-control";
import {
	boundaryAcked,
	collectGitEvidence,
	enumerateLineageManifest,
	finalizeTailerBoundary,
	verifyLineageStructure,
} from "./quiesce-evidence";
import { flushAllWriters } from "./writer-flush";
import { setOnFrameTap } from "./sse-delivery";

// ---------------------------------------------------------------------------
// Bootstrap: one shared authStorage/modelRegistry pair (the SDK enforces the
// pairing), one Settings instance, then the single boot session. omp-session is
// de-muxed (Phase 6): every /events stream is attached to that one session from
// open (connect = attached), which routes call/login_code/ui_response and
// all session-scoped frames. The constant handle "s1" survives only as the
// attached frame's client guard token; session-scoped frames carry no
// sessionId on the wire.
// ---------------------------------------------------------------------------

let config: SessionConfig;
try {
	config = parseConfig(process.argv.slice(2));
} catch (err) {
	console.error(`omp-session: ${String(err)}`);
	process.exit(1);
}
// Non-loopback bind without a token is a startup hard error (R14).
if (!isLoopbackHost(config.host) && !config.token) {
	console.error(
		`omp-session: refusing to bind non-loopback address "${config.host}" without a token; pass --token or set OMP_SESSION_TOKEN`,
	);
	process.exit(1);
}
// Callback transport (P3.2): the flags that define a callback pair must
// arrive together; a partial set is a visible startup error, never a silent
// partial pair (a pair without its enrollment credential would dial and
// 401 forever; a URL without a workspace binds nothing). callbackProxy and
// callbackAllowHttp are optional refinements of an already-complete pair.
const callbackPairFields = [
	["callbackUrl", config.callbackUrl !== undefined],
	["callbackWorkspace", config.callbackWorkspace !== undefined],
	["callbackGeneration", config.callbackGeneration !== undefined],
	["callbackToken", config.callbackToken !== undefined],
] as const;
const missingCallback = callbackPairFields.filter(([, present]) => !present).map(([name]) => name);
if (missingCallback.length > 0 && missingCallback.length < callbackPairFields.length) {
	console.error(
		"omp-session: callback transport flags must be provided together",
		`missing: ${missingCallback.join(", ")}`,
	);
	process.exit(1);
}

// TUI default global config directory (~/.omp/agent; sdk.ts documents the same).
const agentDir = getAgentDir();
const sessionsDir = path.join(agentDir, "sessions");
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
const settings = await Settings.init({ cwd: config.cwd, agentDir });

/** Set once the boot session's provider/model/auth resolution completes (R8). */
let readyAt: number | null = null;
/** The single boot session; hello_ok's sessionFile comes from it. */
let bootEntry: SessionEntry | null = null;
/** omp-session version for hello_ok; read from package.json when resolvable, else "dev". */
const version = await resolveVersion();

// Idle auto-exit (R11): a 15s tick (default; the OMP_SESSION_TEST_IDLE_CHECK_MS
// env hook overrides it for tests) exits via shutdown() when the daemon has
// been continuously idle for config.idleTimeoutMs (0 disables).
let lastActivityAt = Date.now();
let idleTimer: ReturnType<typeof setInterval> | undefined;
/** Set once shutdown begins (signal or idle-exit); also read by the boot catch. */
let shuttingDown = false;

function markActivity(): void {
	lastActivityAt = Date.now();
}

/** Narrow an unknown value to a plain object (down-traffic control payloads). */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Boot gate: the OMP_SESSION| listening line prints BEFORE the boot session exists,
 * so early connectors (and the first requests) wait for registration. The
 * connect-implies-attached invariant holds even for streams that race boot.
 */
let resolveBootReady: () => void = () => {};
const bootReady = new Promise<void>((resolve) => {
	resolveBootReady = resolve;
});

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** omp-session version for hello_ok: package.json next to server/ when resolvable, else "dev". */
async function resolveVersion(): Promise<string> {
	try {
		const pkg = (await Bun.file(path.join(import.meta.dir, "..", "package.json")).json()) as {
			version?: unknown;
		};
		return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "dev";
	} catch {
		return "dev";
	}
}

/** True for 127.0.0.0/8, ::1, and IPv4-mapped IPv6 of the same (strict numeric parts). */
function isLoopbackIp(address: string | null | undefined): boolean {
	return address ? isLoopbackHost(address) : false;
}

// ---------------------------------------------------------------------------
// Collab relay (Slice A): rooms that forward opaque AES-GCM envelopes between
// a per-session host adapter and real omp TUI guests (`omp join <link>`).
// Relay sockets are typed {@link RelaySocketData} and are NEVER added to `streams`.
// ---------------------------------------------------------------------------

const relay: RelayHandle = createRelay({
	maxGuests: config.collabMaxGuests,
	maxRooms: config.collabMaxRooms,
	// Host upgrades create rooms, so they are gated exactly like /events and
	// /command (R14): loopback exempt; off-loopback peers need the bearer
	// token. Guests join by E2E room key, deliberately not gated.
	authorizeHost: (req, srv) => r14Authorized(req, srv),
});

// ---------------------------------------------------------------------------
// Extracted-module wiring (Phase 6 audit #7): each split module receives its
// boot-time deps explicitly: config/settings/authStorage/modelRegistry from
// the bootstrap above, plus the readiness clock. The delivery module's detach
// hooks are registered so stream teardown keeps rejecting stream-owned
// pending code inputs and UI requests exactly as before.
// ---------------------------------------------------------------------------

const daemonBroker = createDaemonBroker({ config, getReadyAt: () => readyAt });
const collabSession = createCollabSession({
	config,
	agentDir,
	authStorage,
	modelRegistry,
	settings,
	broker: daemonBroker,
});
const {
	methods: METHODS,
	readOnly: READ_ONLY,
	notReadyGated: NOT_READY_GATED,
	historyReload: HISTORY_RELOAD,
	getInFlightBash,
	getInFlightPython,
} = createWebMethods({
	settings,
	authStorage,
	collab: collabSession,
	broker: daemonBroker,
	materializeSession,
	sessionsDir,
	hasCallbackPair: () => fleetCallback !== null,
});
setOnStreamsEmpty(() => daemonBroker.stopDaemonPoll());
setOnConsumerDetached((stream, reason) => {
	// A UI request dies only when every stream it was shown to is gone.
	if (bootEntry) rejectStreamUiRequests(bootEntry, stream, reason);
});

// ---------------------------------------------------------------------------
// /events: register the consumer (connect = attached), prime it, and stream
// live deltas. The consumer registry and all delivery primitives live in
// sse-delivery.ts.
// ---------------------------------------------------------------------------

let nextConsumerId = 1;

/**
 * Prime a fresh /events stream: hello_ok first (daemon identity; HTTP-level
 * auth replaced the WS hello handshake), then the attach priming (attached →
 * history → state → collab_status → available_commands → ready), seqs 1..k
 * (k < SSE_DELTA_SEQ_START). `commands` is built BEFORE the stream opens so
 * every priming seq is assigned contiguously (no async gap between priming
 * and the delta era). Then resume per Last-Event-ID: only ring deltas with
 * seq > max(lastEventId, snapshotSeq - 1) replay. The snapshot mark (the
 * next delta seq at prime start) bounds the overlap so a resume never
 * re-delivers deltas whose effects are already inside the fresh priming
 * (finding #2: a completed turn's event deltas would otherwise duplicate
 * chat/tool items on top of the just-primed history).
 *
 * The history frame is the one potentially multi-megabyte payload (base64
 * image data URLs inside messages): it is chunked and paced to the consumer's
 * drain so a transcript over the 4 MiB backpressure cap still primes; a
 * synchronous single-frame prime would be terminated by enqueueTo and the
 * client could never attach (finding #11). Pacing lets the socket drain
 * between chunks; the sequence stays 1..k because priming seqs never reach
 * SSE_DELTA_SEQ_START.
 */
async function primeConsumer(
	consumer: SseConsumer,
	entry: SessionEntry,
	commands: AvailableSlashCommand[] | null,
	lastEventId: string | null,
): Promise<void> {
	// Snapshot the delta high-water mark BEFORE any priming is built: every
	// ringed delta with seq < snapshotSeq is fully reflected in the history/
	// state below, so replay must never deliver it again. Deltas >= snapshotSeq
	// arrived while the paced prime was in flight and ride the ring replay.
	const snapshotSeq = snapshotDeltaSeq();
	consumer.attached = entry.handle;
	let seq = 1;
	enqueueTo(
		consumer,
		encodeSseEvent(
			SSE_EVENT_NAME,
			{
				type: "hello_ok",
				proto: OMP_PROTO,
				name: config.name,
				cwd: config.cwd,
				pid: process.pid,
				version,
				...(entry.session.sessionFile ? { sessionFile: entry.session.sessionFile } : {}),
			},
			seq++,
		),
	);
	enqueueTo(
		consumer,
		encodeSseEvent(SSE_EVENT_NAME, { type: "attached", sessionId: BOOT_HANDLE }, seq++),
	);
	await sendHistoryPaced(consumer, entry.session.messages, () => seq++);
	await enqueuePaced(
		consumer,
		encodeSseEvent(
			SSE_EVENT_NAME,
			{
				type: "state",
				state: daemonBroker.buildStateSnapshot(entry.session),
				stats: entry.session.getSessionStats(),
			},
			seq++,
		),
	);
	// Current collab status, so a client attaching to a live room sees it immediately.
	await enqueuePaced(
		consumer,
		encodeSseEvent(
			SSE_EVENT_NAME,
			{
				type: "collab_status",
				status: collabSession.toWireStatus(entry.collab.adapter?.status ?? null),
			},
			seq++,
		),
	);
	if (commands !== null) {
		await enqueuePaced(
			consumer,
			encodeSseEvent(SSE_EVENT_NAME, { type: "available_commands", commands }, seq++),
		);
	}
	// Late attachers get `ready` appended to the priming sequence (R8).
	if (readyAt !== null) {
		await enqueuePaced(consumer, encodeSseEvent(SSE_EVENT_NAME, { type: "ready", readyAt }, seq++));
	}
	const last = lastEventId === null ? NaN : Number(lastEventId);
	// Replay floor: the client already has everything up to its Last-Event-ID
	// and the fresh priming carries everything before the snapshot, so only
	// deltas after max(last, snapshotSeq-1) are new. An absent/sub-1024 id
	// (fresh client, or a drop mid-prime) means priming carries full state up
	// to the snapshot, so the floor is just the snapshot mark; deltas that
	// arrived during the paced prime still replay exactly once.
	const resumeFrom =
		Number.isFinite(last) && last >= SSE_DELTA_SEQ_START
			? Math.max(last, snapshotSeq - 1)
			: snapshotSeq - 1;
	const replay = ringAfter(resumeFrom);
	// The ring keeps only the last SSE_RING_CAP deltas and evicts from the
	// head; a first entry above resumeFrom+1 means entries the client still
	// needs were evicted while the (paced) prime was in flight. Replaying the
	// tail would silently skip them, so drop and resume instead: the reconnect's
	// Last-Event-ID is a priming seq, so it lands below the new snapshot mark
	// and the fresh prime carries everything again.
	if (replay.length > 0 && replay[0].seq > resumeFrom + 1) {
		terminateStream(consumer, "ring eviction: resume window exceeded the replay ring");
		return;
	}
	for (const { value } of replay) enqueueTo(consumer, value);
}

/**
 * Open a GET /events SSE response: register the consumer (connect = attached
 * to the single boot session, exactly like the WS open), prime it, and stream
 * live deltas until the client goes away. The body's queuing strategy sizes
 * chunks in bytes so backpressure is measured against SSE_BACKPRESSURE_BYTES.
 */
async function openEventsResponse(req: Request): Promise<Response> {
	const entry = bootEntry!;
	// Build slash commands before the stream opens so the priming sequence is
	// written contiguously (seqs 1..k) with no async gap into the delta era.
	let commands: AvailableSlashCommand[] | null = null;
	try {
		commands = await buildAvailableSlashCommands(entry.session);
	} catch (err) {
		console.error("Failed to build available commands:", err);
	}
	const lastEventId = req.headers.get("last-event-id");
	let consumer: SseConsumer | undefined;
	const stream = new ReadableStream<Uint8Array>(
		{
			start: (controller) => {
				// The constructor's start callback types the controller as the
				// default/byte union; this stream is built with a default
				// source, so the default controller is the actual runtime type.
				const c: SseConsumer = {
					id: nextConsumerId++,
					controller: controller as ReadableStreamDefaultController<Uint8Array>,
					attached: null,
					unreadEstimate: 0,
				};
				consumer = c;
				streams.add(c);
				daemonBroker.startDaemonPoll();
				startKeepalive();
				// Connect = attached: a bare /events open reproduces the
				// single-session priming sequence (the bootReady gate admits
				// requests only after the boot session exists). hello_ok and
				// attached are enqueued synchronously above any await; only the
				// history chunking paces (large transcripts drain between
				// chunks).
				void primeConsumer(c, entry, commands, lastEventId).catch((err) => {
					console.error("Failed to prime /events stream:", err);
				});
			},
			cancel: () => {
				// Detach only: sessions outlive streams.
				if (consumer) detachConsumer(consumer, "stream closed");
			},
		},
		{ highWaterMark: SSE_BACKPRESSURE_BYTES, size: (chunk) => chunk?.byteLength ?? 0 },
	);
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"x-accel-buffering": "no",
		},
	});
}

// Login callbacks are streaming (open_url + manual code input), so login is
// special-cased in dispatch. Pending code inputs are keyed per connection
// (the streams live at dispatch time) and are rejected on login settle, on
// every owning stream closing, on the attached session's close, and on shutdown.
let nextLoginRequestId = 1;

async function loginWithCallbacks(entry: SessionEntry, providerId: string): Promise<unknown> {
	const knownProvider = getOAuthProviders().find((p) => p.id === providerId);
	if (!knownProvider) throw new Error(`Unknown OAuth provider: ${providerId}`);
	// Track whether onAuth has fired. Providers that require interactive input
	// before a browser URL cannot be satisfied by the web UI; after onAuth,
	// prompt input is the pasted OAuth code/redirect URL path.
	let authEmitted = false;
	// The streams live at dispatch time own this login's code prompts; when
	// every one closes, the prompt dies with them.
	const promptStreams = new Set(streams);
	try {
		await authStorage.login(providerId as Parameters<AuthStorage["login"]>[0], {
			onAuth: (info) => {
				authEmitted = true;
				broadcastAnswer({
					type: "login_url",
					url: info.url,
					launchUrl: info.launchUrl,
					instructions: info.instructions,
				});
			},
			onProgress: (message) => notifyEvent(entry, message),
			onPrompt: (prompt) => {
				if (!authEmitted) {
					return Promise.reject(
						new Error(
							`Provider '${providerId}' requires interactive prompts ` +
								"which are not supported in the web UI. Use the terminal UI to log in.",
						),
					);
				}
				const requestId = `lr${nextLoginRequestId++}`;
				const { promise, resolve, reject } = Promise.withResolvers<string>();
				pendingCodeInputs.set(requestId, { streams: promptStreams, resolve, reject });
				broadcastAnswer({
					type: "login_code_request",
					requestId,
					title: prompt.message,
					placeholder: prompt.placeholder,
				});
				return promise;
			},
		});
		// Provider-scoped online refresh so the just-persisted credential
		// re-runs discovery instead of reusing a fresh authoritative cache row.
		await modelRegistry.refreshProvider(providerId, "online");
		await daemonBroker.broadcastAvailableCommands(entry);
		return { providerId };
	} finally {
		// Reject this call's leftover code inputs (already-resolved entries
		// were deleted by the login_code handler, so only stragglers remain).
		for (const [id, p] of pendingCodeInputs) {
			if (p.streams === promptStreams) {
				p.reject(new Error("login ended"));
				pendingCodeInputs.delete(id);
			}
		}
	}
}

const LIST_FILES_SKIP: Record<string, true> = { ".git": true, node_modules: true };
const LIST_FILES_CEILING = 10_000;

async function listFiles(query: string, limit: number): Promise<string[]> {
	const entries: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		if (entries.length >= LIST_FILES_CEILING) return;
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip
		}
		for (const d of dirents) {
			if (entries.length >= LIST_FILES_CEILING) return;
			if (LIST_FILES_SKIP[d.name]) continue;
			const rel = prefix ? `${prefix}/${d.name}` : d.name;
			if (d.isDirectory()) await walk(path.join(dir, d.name), rel);
			else entries.push(rel);
		}
	};
	await walk(config.cwd, "");
	const q = query.toLowerCase();
	return entries.filter((f) => f.toLowerCase().includes(q)).slice(0, limit);
}

/**
 * Dispose the boot session and cut every stream off it. Only invoked from
 * shutdown: streams are detached (never closed); pending ui_requests and the
 * pending login code inputs of those streams are rejected.
 */
async function closeSession(entry: SessionEntry, reason: string): Promise<void> {
	// Collab teardown before dispose: stop the adapter (guests get a bye) and
	// destroy the relay room (guests get room-closed + 4001).
	const adapter = entry.collab.adapter;
	const roomId = adapter?.status?.roomId;
	entry.collab.adapter = null;
	if (adapter) await adapter.stop(reason).catch(() => {});
	if (roomId) relay.closeRoom(roomId);
	entry.session.beginDispose();
	await entry.session.dispose().catch(() => {});
	rejectEntryUiRequests(entry, reason);
	for (const [id, p] of pendingCodeInputs) {
		let attachedHere = false;
		for (const stream of p.streams) {
			if (stream.attached === entry.handle) attachedHere = true;
		}
		if (attachedHere) {
			p.reject(new Error(reason));
			pendingCodeInputs.delete(id);
		}
	}
	for (const stream of streams) {
		if (stream.attached === entry.handle) stream.attached = null;
	}
}

/** The session this command's call/login_code/ui_response route to. */
function attachedEntry(): SessionEntry | undefined {
	return bootEntry ?? undefined;
}

async function handleCommand(cmd: ClientCommand): Promise<void> {
	try {
		// Test hook (OMP_SESSION_TEST_UI_REQUEST=1, see server/config.ts):
		// deterministically create a web ui_request so integration tests can
		// exercise the dialog round-trip + ring invalidation (finding #16)
		// without a model turn. Only accepted when the hook env is set; a
		// fleet edge's allowlist rejects it for browsers.
		if (config.uiRequestTestHook && (cmd as { type?: string }).type === "test_ui_request") {
			const entry = attachedEntry();
			if (!entry) throw new Error("Not attached to a session");
			void webUiRequest(entry, "confirm", {
				title: "test dialog",
				message: "finding #16 regression",
			}).catch((err) => {
				broadcast({ type: "error", error: `test_ui_request failed: ${String(err)}` });
			});
			return;
		}
		switch (cmd.type) {
			case "call": {
				const entry = attachedEntry();
				if (!entry) throw new Error("Not attached to a session");
				// Readiness gate (R8): prompt-family methods are rejected until
				// the boot session's provider/model/auth resolution completes.
				// The wire error is the literal string "not_ready".
				if (readyAt === null && NOT_READY_GATED[cmd.method]) throw "not_ready";
				const method = METHODS[cmd.method];
				if (!method) throw new Error(`Unknown method: ${cmd.method}`);
				const data =
					cmd.method === "login"
						? await loginWithCallbacks(entry, cmd.args?.[0] as string)
						: await method(entry, cmd.args ?? [], cmd.streamId);
				// Post-mutation resync is best-effort: the mutation already
				// succeeded, so a resync failure must not fail the call.
				const resync = async () => {
					try {
						if (HISTORY_RELOAD[cmd.method]) await broadcastHistory(entry);
						if (HISTORY_RELOAD[cmd.method] || !READ_ONLY[cmd.method])
							await daemonBroker.broadcastState(entry);
					} catch (err) {
						console.error("Post-mutation resync failed:", err);
						broadcast({ type: "error", error: `resync failed: ${String(err)}` });
					}
				};
				if (HISTORY_RELOAD[cmd.method]) {
					// Resync BEFORE the call_result: picker success UI (notices,
					// modal close) must run after the transcript is replaced.
					await resync();
					answerCommand(cmd.id, { type: "call_result", id: cmd.id, ok: true, data });
				} else {
					answerCommand(cmd.id, { type: "call_result", id: cmd.id, ok: true, data });
					await resync();
				}
				break;
			}
			case "login_code": {
				const pending = pendingCodeInputs.get(cmd.requestId);
				if (pending) {
					pendingCodeInputs.delete(cmd.requestId);
					pending.resolve(cmd.code);
				}
				break;
			}
			case "ui_response": {
				const entry = attachedEntry();
				const pending = entry?.pendingUiRequests.get(cmd.id);
				if (entry && pending) {
					entry.pendingUiRequests.delete(cmd.id);
					if (cmd.error !== undefined) pending.reject(new Error(cmd.error));
					else pending.resolve(cmd.result);
					// Finding #16: broadcast the ringed ui_request_end so every
					// attached tab dismisses the dialog and a resuming stream
					// (older Last-Event-ID) replays end-after-request instead of
					// a stale dialog whose answer would no-op.
					broadcastTo(entry.handle, { type: "ui_request_end", id: cmd.id });
				}
				break;
			}
			case "list_sessions": {
				// Scope to the bound project root (config.cwd) like the TUI's
				// --resume picker (main.ts): never surface other projects'
				// sessions, even when this project has none (issue #3099).
				const infos = await SessionManager.list(config.cwd);
				const sessionsList: SessionListEntry[] = infos
					.map((i) => ({
						path: i.path,
						id: i.id,
						name: i.title,
						cwd: i.cwd,
						modifiedAt: i.modified.getTime(),
						messageCount: i.messageCount,
					}))
					.sort((x, y) => y.modifiedAt - x.modifiedAt)
					.slice(0, 200);
				broadcastAnswer({ type: "sessions", sessions: sessionsList });
				break;
			}
			case "list_files": {
				broadcastAnswer({ type: "files", files: await listFiles(cmd.query, cmd.limit ?? 50) });
				break;
			}
			case "spawn":
			case "spawn_resume":
			case "stop":
			case "list_projects":
				// Fleet-edge commands on a bare omp-session (the registry lives
				// in omp-fleet, Phase 3).
				broadcastAnswer({ type: "error", error: "fleet-only command" });
				break;
			case "collab_start": {
				const entry = attachedEntry();
				if (!entry) throw new Error("Not attached to a session");
				if (entry.collab.starting || entry.collab.adapter) {
					throw new Error("collab already active for this session");
				}
				entry.collab.starting = true;
				broadcastTo(entry.handle, { type: "collab_status", status: { state: "starting" } });
				const adapter = new CollabHostAdapter(collabSession.buildCollabPort(entry), {
					hostName: config.collabHostname ?? (os.userInfo().username || "web"),
					onStatusChange: (status) =>
						broadcastTo(entry.handle, {
							type: "collab_status",
							status: collabSession.toWireStatus(status),
						}),
				});
				try {
					// Join links advertise collabUrl (or localhost); the host
					// socket always connects to the local relay so a public
					// collabUrl never hairpins off-loopback (the R14 host
					// gate requires a bearer token there, which the adapter
					// has no way to present).
					await adapter.start(relayBaseUrl(), `ws://localhost:${server.port}`);
					entry.collab.adapter = adapter;
				} catch (err) {
					broadcastTo(entry.handle, {
						type: "collab_status",
						status: { state: "error", error: String(err) },
					});
				} finally {
					entry.collab.starting = false;
				}
				break;
			}
			case "collab_stop": {
				const entry = attachedEntry();
				if (!entry) throw new Error("Not attached to a session");
				if (entry.collab.starting) throw new Error("collab is starting");
				const adapter = entry.collab.adapter;
				if (!adapter) throw new Error("collab is not active");
				// Capture the room id BEFORE stop clears the adapter status.
				const roomId = adapter.status?.roomId;
				entry.collab.adapter = null;
				await adapter.stop("collab stopped by web user");
				if (roomId) relay.closeRoom(roomId);
				broadcastTo(entry.handle, { type: "collab_status", status: { state: "off" } });
				break;
			}
			case "daemon_logs": {
				// Per-daemon log tail/head, answered by unicast daemon_logs_result.
				try {
					const client = await daemonClientForProject(cmd.projectDir);
					const result = await client.request({
						op: "logs",
						name: cmd.name,
						lines: cmd.lines,
						head: cmd.head ?? false,
						grep: cmd.grep,
						follow: false,
						timeoutMs: 30_000,
					});
					if (result.op !== "logs") throw new Error("unexpected daemon broker response");
					answerCommand(cmd.id, {
						type: "daemon_logs_result",
						id: cmd.id,
						ok: true,
						text: result.text,
						cursor: result.cursor,
						state: result.state,
					});
				} catch (err) {
					answerCommand(cmd.id, {
						type: "daemon_logs_result",
						id: cmd.id,
						ok: false,
						error: String(err),
					});
				}
				break;
			}
			case "daemon_stop": {
				try {
					const client = await daemonClientForProject(cmd.projectDir);
					const result = await client.request({
						op: "stop",
						name: cmd.name,
						timeoutMs: cmd.timeoutMs ?? 10_000,
					});
					if (result.op !== "stop") throw new Error("unexpected daemon broker response");
					answerCommand(cmd.id, {
						type: "daemon_control_result",
						id: cmd.id,
						ok: true,
						daemon: await daemonBroker.daemonInfoWithEndpoint(
							client,
							cmd.projectDir,
							result.daemon,
						),
					});
				} catch (err) {
					answerCommand(cmd.id, {
						type: "daemon_control_result",
						id: cmd.id,
						ok: false,
						error: String(err),
					});
				}
				break;
			}
			case "daemon_restart": {
				try {
					const client = await daemonClientForProject(cmd.projectDir);
					const result = await client.request({ op: "restart", name: cmd.name });
					if (result.op !== "restart") throw new Error("unexpected daemon broker response");
					answerCommand(cmd.id, {
						type: "daemon_control_result",
						id: cmd.id,
						ok: true,
						daemon: await daemonBroker.daemonInfoWithEndpoint(
							client,
							cmd.projectDir,
							result.daemon,
						),
					});
				} catch (err) {
					answerCommand(cmd.id, {
						type: "daemon_control_result",
						id: cmd.id,
						ok: false,
						error: String(err),
					});
				}
				break;
			}
			default:
				throw new Error(`Unknown command: ${JSON.stringify(cmd)}`);
		}
	} catch (err) {
		if (cmd.type === "call") {
			// Finding #59: EVERY failed call answers with the id-keyed
			// call_result, even without an attached session entry. The
			// client correlates call() promises only with call_result; a bare
			// error frame here would leave the promise hanging until timeout.
			// Recorded like any other answer, so a re-POST replay reports the
			// real dispatch failure instead of a fabricated success.
			answerCommand(cmd.id, { type: "call_result", id: cmd.id, ok: false, error: String(err) });
		} else {
			broadcastAnswer({ type: "error", error: String(err) });
		}
	}
}

// /download streams a server-side file (used by /export). The only trust
// boundary on this unauthenticated server: the canonical (realpath) target
// must live inside the system temp dir, the agent cwd (where bare-filename
// exports land), or a live session file's directory. Canonicalizing both
// sides closes symlink escapes that a lexical prefix check would miss.
async function canonicalRoots(): Promise<string[]> {
	const roots = [os.tmpdir(), config.cwd, process.cwd()];
	const sessionFile = bootEntry?.session.sessionFile;
	if (sessionFile) roots.push(path.dirname(sessionFile));
	const out: string[] = [];
	for (const root of roots) {
		out.push(await realpath(root).catch(() => root));
	}
	return out;
}

function isInside(resolved: string, roots: string[]): boolean {
	return roots.some((root) => {
		const rel = path.relative(root, resolved);
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
}

/**
 * Authorization header check: the scheme is case-insensitive (`bearer`/
 * `Bearer`), but the token value is compared EXACTLY, consistent with the
 * ?token= query path (regression: the whole header used to be lowercased,
 * accepting wrong-case tokens).
 */
function bearerHeaderOk(header: string | null, token: string): boolean {
	if (header === null) return false;
	return header.slice(0, 7).toLowerCase() === "bearer " && header.slice(7) === token;
}

/** Bearer check for plain-HTTP paths (/download): Authorization header or ?token=. */
function bearerOk(req: Request): boolean {
	const header = req.headers.get("authorization");
	if (bearerHeaderOk(header, config.token!)) return true;
	return new URL(req.url).searchParams.get("token") === config.token;
}

/**
 * R14 gate for the agent-driving endpoints (/events, /command): loopback is
 * exempt; off-loopback peers need the bearer token via Authorization header
 * or ?token=. A missing or wrong credential is a 401 with no hello window
 * and no close codes.
 */
function r14Authorized(req: Request, srv: Server<RelaySocketData>): boolean {
	if (isLoopbackIp(srv.requestIP(req)?.address)) return true;
	if (!config.token) return true;
	if (bearerHeaderOk(req.headers.get("authorization"), config.token)) return true;
	return new URL(req.url).searchParams.get("token") === config.token;
}

/**
 * POST /command idempotency: re-accept duplicates of a command id within
 * COMMAND_DEDUP_WINDOW_MS (ids capped at COMMAND_DEDUP_ID_CAP as a flood
 * backstop) without re-dispatching, and REPLAY the answer the original
 * already produced (answers capped at COMMAND_DEDUP_ANSWER_CAP, since each
 * one can be large).
 *
 * The replay is what makes the client's lost-answer recovery work. Answers are
 * unicast (call_result and friends) and deliberately NOT ringed, so a dropped
 * answer is recoverable only by re-POSTing the command; a dedup that re-accepts
 * the duplicate silently would leave that re-POST unanswered forever. The
 * duplicate still never re-dispatches, so a replayed command executes once: the
 * id memory therefore outlives every answer, and only the id cap can lose one
 * (an evicted id would re-execute the command).
 */
const commandDedup = new Map<string, number>();

/** Recorded answers by command id, replayed to duplicates (same window as the dedup). */
const commandAnswers = new Map<string, { frame: ServerFrame; at: number }>();

/** Drop the oldest remembered keys past `cap` (insertion order is age order). */
function capRemembered<K, V>(map: Map<K, V>, cap: number): void {
	while (map.size > cap) {
		const oldest = map.keys().next();
		if (oldest.done) return;
		map.delete(oldest.value);
	}
}

/**
 * Record one id-keyed answer so a later duplicate POST can replay it, then
 * broadcast it. Every answer the daemon emits for a command id goes through
 * here: the replay must return the ORIGINAL outcome (success data or the real
 * dispatch error), never a re-execution.
 */
function answerCommand(id: string | undefined, frame: ServerFrame): void {
	if (typeof id === "string" && id.length > 0) {
		const now = Date.now();
		for (const [key, entry] of commandAnswers) {
			if (now - entry.at > COMMAND_DEDUP_WINDOW_MS) commandAnswers.delete(key);
		}
		commandAnswers.set(id, { frame, at: now });
		capRemembered(commandAnswers, COMMAND_DEDUP_ANSWER_CAP);
	}
	broadcastAnswer(frame);
}

function commandSeenRecently(id: string | undefined): boolean {
	if (typeof id !== "string" || id.length === 0) return false;
	const now = Date.now();
	for (const [key, at] of commandDedup) {
		if (now - at > COMMAND_DEDUP_WINDOW_MS) commandDedup.delete(key);
	}
	if (commandDedup.has(id)) return true;
	commandDedup.set(id, now);
	capRemembered(commandDedup, COMMAND_DEDUP_ID_CAP);
	return false;
}

const server = Bun.serve<RelaySocketData>({
	port: config.port,
	hostname: config.host,
	// SSE responses are long-lived and quiet between 15s keepalive pings;
	// Bun's default 10s fetch idleTimeout would kill them mid-stream.
	idleTimeout: 0,
	async fetch(req, srv) {
		// Boot gate: the OMP_SESSION| listening line prints before the boot session
		// exists; the first requests (and /events opens) wait for registration
		// so connect-implies-attached holds for streams that race boot.
		await bootReady;
		const url = new URL(req.url);
		// Collab relay rooms (/r/<roomId>?role=host|guest) upgrade here; the
		// relay returns null for every other pathname so web handling
		// continues. Host upgrades can be refused before the handshake
		// (off-loopback without the bearer token → 401; new host room past
		// the cap → 503). Surface that response.
		const relayResult = relay.handleUpgrade(url, srv, req);
		if (relayResult !== null) {
			if (relayResult.handled) return;
			return new Response(relayResult.reason, { status: relayResult.status });
		}
		// Agent-driving transport (OMP_PROTO 2): GET /events down (SSE),
		// POST /command up (one ClientCommand per request, 202 accept).
		if (url.pathname === "/events") {
			if (!r14Authorized(req, srv)) return new Response("Unauthorized", { status: 401 });
			return openEventsResponse(req);
		}
		if (url.pathname === "/command") {
			if (req.method !== "POST") return new Response("Not found", { status: 404 });
			if (!r14Authorized(req, srv)) return new Response("Unauthorized", { status: 401 });
			markActivity();
			let cmd: ClientCommand;
			try {
				cmd = JSON.parse(await req.text()) as ClientCommand;
			} catch {
				return new Response("Malformed JSON", { status: 400 });
			}
			// Idempotent accept: a duplicate id is 202 without a re-dispatch.
			// When the original already answered, the recorded answer is
			// replayed (the duplicate is the client recovering a lost one); a
			// duplicate that arrives while the original is still in flight is
			// a silent accept, since that answer is still coming.
			if (commandSeenRecently(cmd.id)) {
				const answer = commandAnswers.get(cmd.id);
				if (answer !== undefined) broadcastAnswer(answer.frame);
				return Response.json({ commandId: cmd.id }, { status: 202 });
			}
			// Quiesce admission barrier (P7.3): once deletion quiesce begins,
			// every new command is rejected with an explicit typed failure,
			// never silently dropped, never queued past the gate.
			if (daemonControl !== null && daemonControl.status().admissionBarrier) {
				return Response.json(
					{
						commandId: cmd.id,
						error: {
							code: "writer_active",
							message: "command rejected: quiesce admission barrier",
						},
					},
					{ status: 409 },
				);
			}
			// Fire-and-forget accept: answers ride the /events stream only.
			void handleCommand(cmd).catch((err) => console.error("command dispatch failed:", err));
			return Response.json({ commandId: cmd.id }, { status: 202 });
		}
		// /download: off-loopback requests require the token too when one is
		// set (Authorization header or ?token=; downloads are plain fetch).
		const loopback = isLoopbackIp(srv.requestIP(req)?.address);
		if (!loopback && config.token && !bearerOk(req))
			return new Response("Unauthorized", { status: 401 });
		if (url.pathname === "/download") {
			const requested = url.searchParams.get("path");
			if (!requested) return new Response("Missing path", { status: 400 });
			// Relative export paths are written by the agent into its cwd (or the
			// server's process cwd when the session dir lives there); absolute
			// paths are used as-is.
			const resolved = path.isAbsolute(requested) ? requested : path.resolve(config.cwd, requested);
			let canonical = await realpath(resolved).catch(() => null);
			if (!canonical && !path.isAbsolute(requested)) {
				canonical = await realpath(path.resolve(process.cwd(), requested)).catch(() => null);
			}
			if (!canonical) return new Response("Not found", { status: 404 });
			const fileStat = await stat(canonical).catch(() => null);
			if (!fileStat?.isFile()) return new Response("Not found", { status: 404 });
			if (!isInside(canonical, await canonicalRoots()))
				return new Response("Forbidden", { status: 403 });
			return new Response(Bun.file(canonical));
		}
		// No static or HTML route: the daemon serves the wire API only, so
		// everything else (including "/") points at the fleet, the only
		// web UI server.
		return new Response(
			"omp-web: this is a session daemon (no web UI). Start the fleet with `omp-web` and open the Web UI URL it prints.\n",
			{ status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
		);
	},
	websocket: {
		// Only collab relay sockets reach these handlers: the agent-driving
		// channel is SSE (/events) + POST (/command), and every upgraded
		// socket carries RelaySocketData (audit #18: the old "web" variant
		// of the union was never constructed).
		open(ws) {
			relay.handleOpen(ws);
		},
		close(ws) {
			relay.handleClose(ws);
		},
		message(ws, raw) {
			relay.handleMessage(ws, raw);
		},
	},
});

// ---------------------------------------------------------------------------
// R6b: the OMP_SESSION| listening contract line goes to STDOUT immediately after
// bind, BEFORE session creation (the spawner learns the endpoint early and is
// typically already connected when `ready` arrives). Human logs go to stderr.
// ---------------------------------------------------------------------------

const listeningLine: StdoutContractLine = {
	event: "listening",
	bind: config.host,
	port: server.port!,
	url: `ws://${config.host}:${server.port}`,
};
if (config.advertise) listeningLine.advertise = config.advertise;
console.log(`${OMP_SESSION_PREFIX}${JSON.stringify(listeningLine)}`);
console.error(`omp-session listening on http://localhost:${server.port}`);

// pi-utils' postmortem installs its own SIGINT/SIGTERM/SIGHUP handlers at
// import time (run SDK cleanup, then exitProcess(130/143/129)); they preempt
// omp-session's graceful shutdown with the default-disposition exit code. omp-session owns
// these signals from bind onward (BEFORE the boot-session await below, so a
// kill during session creation cannot skip disposal): drop the import-time
// handlers, run the same SDK cleanup callbacks inside our shutdown
// (postmortemCleanup never exits), and exit 0. The shutdown function is
// hoisted and every binding it touches is already initialized.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	for (const listener of process.listeners(sig)) process.removeListener(sig, listener);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());

// ---------------------------------------------------------------------------
// Session-file locking: a second omp-session on the same session file fails
// loudly (exit 1) instead of racing the holder and clobbering state. The
// --resume file is locked before the boot session exists; the live session
// file is locked right after createSession (a no-op when it duplicates the
// resume lock, or when the session is in-memory and has no file). All locks
// are released in shutdown().
// ---------------------------------------------------------------------------

const sessionLocks: FileLock[] = [];
const heldSessionLockPaths = new Set<string>();

/**
 * Acquire a lock on `file` (path + ".lock") unless it is already held by this
 * process. A live holder exits with the documented "locked by another
 * omp-session" error; a signal racing boot takes the shutdown exit path.
 */
function acquireSessionLock(file: string | undefined): void {
	if (!file || heldSessionLockPaths.has(file)) return;
	try {
		const lock = acquireFileLock(`${file}.lock`, `omp-session ${config.name}`);
		heldSessionLockPaths.add(file);
		sessionLocks.push(lock);
	} catch (err) {
		// A signal during boot runs shutdown() concurrently; that shutdown is
		// the exit path, not this lock failure.
		if (shuttingDown) process.exit(0);
		if (err instanceof LockHeldError) {
			console.error(
				`omp-session: session file ${file} is locked by another omp-session (pid ${err.holderPid})`,
			);
			process.exit(1);
		}
		throw err;
	}
}

/**
 * Diagnostic note for a refused `--resume`: the SDK rejects a switch whose
 * recorded cwd differs from this process's (the daemon's project dir is
 * spawn-bound), and that is the one refusal an operator can neither guess nor
 * fix from a bare "returned false". Reads the file's head for the session
 * header, compares resolved paths, and returns an empty string when there is
 * nothing to add. Never throws.
 */
async function resumeCwdNote(file: string, cwd: string): Promise<string> {
	try {
		const handle = await open(file, "r");
		try {
			const buffer = new Uint8Array(8 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const head = new TextDecoder().decode(buffer.subarray(0, bytesRead));
			for (const line of head.split("\n")) {
				if (!line.trimStart().startsWith('{"type":"session"')) continue;
				const header = JSON.parse(line) as { cwd?: unknown };
				if (typeof header.cwd !== "string" || header.cwd === "") return "";
				if (path.resolve(header.cwd) === path.resolve(cwd)) return "";
				return ` (the session was recorded under ${header.cwd}, this daemon runs ${cwd})`;
			}
			return "";
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Boot (R8): fresh session (or --resume switch, R3), then the readiness gate
// clears in the background once provider/model/auth resolution completes.
// ---------------------------------------------------------------------------

async function bootReadiness(entry: SessionEntry): Promise<void> {
	try {
		await modelRegistry.awaitBackgroundRefresh();
	} catch (err) {
		console.error("omp-session: background model refresh failed:", err);
	}
	// Test hook: hold the gate open so tests exercise not_ready deterministically.
	if (config.readyDeferMs > 0) await sleep(config.readyDeferMs);
	readyAt = Date.now();
	// Stamp readyAt into every state snapshot, then announce the gate.
	void daemonBroker.broadcastState(entry, true);
	broadcast({ type: "ready", readyAt });
}

let bootSession: SessionEntry;
/** Callback transport pair to the fleet (P3.2); started after the boot
 *  session exists, stopped in shutdown(). Null = no callback flags. */
let fleetCallback: FleetCallback | null = null;
/** Session-lineage log tailer (P3.7), streamed over the callback pair.
 *  Constructed with the callback (never without it); started after the
 *  pair starts, stopped before it stops in shutdown(). Null = no callback
 *  flags / tailer failed to construct. */
let logTailer: SessionLogTailer | null = null;
/**
 * Callback control broker (P3.3/P3.5/P4.5): per-browser virtual streams,
 * command routing, control mirror, and the quiesce state machine. Created
 * only when the callback pair exists; null otherwise.
 */
let daemonControl: DaemonControl | null = null;

/**
 * P8.9 wake: materialize a session's stored transcripts from the fleet log
 * store into the agent sessions dir when the transcript is cold/missing, so
 * the caller can resume it. Returns `{ alreadyPresent: true }` when the
 * session tree exists locally (warm, no transfer needed) and throws a typed
 * error when materialization is impossible (no ready callback pair, or the
 * fleet lacks the session).
 */
async function materializeSession(
	_entry: SessionEntry,
	args: { sessionId?: string },
): Promise<{ files: number; bytes: number } | { alreadyPresent: true }> {
	const sessionId = typeof args?.sessionId === "string" ? args.sessionId : "";
	if (sessionId.length === 0) {
		throw new MaterializeSessionError("invalid_request", "materializeSession requires a sessionId");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
		throw new MaterializeSessionError("invalid_request", `unsafe sessionId: ${sessionId}`);
	}
	// Warm: the session tree is already present locally, nothing to do.
	if (sessionTreeExists(sessionsDir, sessionId)) {
		return { alreadyPresent: true };
	}
	const callback = fleetCallback;
	if (callback === null) {
		throw new MaterializeSessionError(
			"unavailable",
			"materialization unavailable: no callback pair is active",
		);
	}
	try {
		const result = await materializeSessionToDir(sessionsDir, sessionId, callback);
		// A materialized session should be resumable; surface the outcome.
		return result;
	} catch (error) {
		if (error instanceof MaterializeSessionError) throw error;
		if (error instanceof Error) {
			const code = (error as Error & { code?: unknown }).code;
			if (code === "unavailable" || code === "invalid_request" || code === "retryable") {
				throw new MaterializeSessionError(
					code as "unavailable" | "invalid_request" | "retryable",
					error.message,
				);
			}
		}
		throw new MaterializeSessionError("unavailable", `materialization failed: ${String(error)}`);
	}
}
// Lock the --resume session file before the boot session exists so a second
// omp-session pointed at the same file fails loudly instead of racing it.
// Only absolute paths are locked here; the live file (which may be identical)
// is locked right after createSession below.
if (config.resume && path.isAbsolute(config.resume)) acquireSessionLock(config.resume);
try {
	bootSession = await collabSession.createSession(config.cwd);
} catch (err) {
	// A signal during boot runs shutdown() concurrently; the torn-down SDK
	// state fails createSession. That is the shutdown, not a boot failure.
	if (shuttingDown) process.exit(0);
	console.error("Failed to start agent session:", err);
	process.exit(1);
}
bootEntry = bootSession;
// Lock the live session file (no-op when it duplicates the --resume lock, or
// when the session is in-memory and sessionFile is undefined).
acquireSessionLock(bootSession.session.sessionFile);
if (config.resume) {
	try {
		const ok = await bootEntry.session.switchSession(config.resume);
		if (ok) {
			clearSubagents(bootEntry);
			await daemonBroker.broadcastAvailableCommands(bootEntry);
		} else {
			console.error(
				`omp-session: --resume ${config.resume}: session switch returned false; starting fresh${await resumeCwdNote(config.resume, config.cwd)}`,
			);
		}
	} catch (err) {
		console.error(`omp-session: --resume ${config.resume} failed (${String(err)}); starting fresh`);
	}
}
resolveBootReady();
void bootReadiness(bootEntry);

// ---------------------------------------------------------------------------
// Callback transport (P3.2): with all four callback flags set, dial the
// fleet's callback pair. The daemon drives the pair (POST /callback/up +
// GET /callback/down); the HTTP/SSE listener above stays fully functional;
// the callback is additive, not a replacement, in this pass. Started AFTER
// the boot session + readiness resolve so the pair speaks for a live
// workspace. start() resolves when the fleet's pair_ready lands; readiness
// and failures log to stderr (stdout is reserved for OMP_SESSION| lines).
// ---------------------------------------------------------------------------
if (config.callbackUrl !== undefined) {
	// Down-traffic router: log controls (log_ack/log_gap) apply to the
	// tailer; stream_open/close, quiesce_begin and every kind:"command"
	// envelope go to the control broker. Reads the mutable bindings at
	// invocation (constructed before FleetCallback below).
	const routeDown = (envelope: CallbackEnvelope): void => {
		if (envelope.kind === "control") {
			const payload = envelope.payload;
			const type = isObject(payload) ? payload.type : "";
			if (type === "log_ack" || type === "log_gap") {
				logTailer?.handleControl(envelope.streamId, envelope.payload);
				return;
			}
		}
		daemonControl?.handleEnvelope(envelope);
	};

	const callbackSend = (
		streamId: string,
		kind: CallbackEnvelope["kind"],
		payload: unknown,
		onEmittedSeq?: (seq: number) => void,
	): ReturnType<FleetCallback["send"]> => {
		const callback = fleetCallback;
		if (callback === null) return "stopped";
		return callback.send({
			streamId,
			kind,
			payload,
			...(onEmittedSeq !== undefined ? { onEmittedSeq } : {}),
		});
	};

	fleetCallback = new FleetCallback(
		{
			url: config.callbackUrl,
			workspaceId: config.callbackWorkspace!,
			generation: config.callbackGeneration!,
			token: config.callbackToken,
			...(config.callbackProxy !== undefined ? { proxy: config.callbackProxy } : {}),
			...(config.callbackAllowHttp ? { allowHttp: true } : {}),
		},
		{
			onStatus: (status: FleetCallbackStatus) => {
				console.error(
					`omp-session: callback pair ${status.state} (workspace ${status.workspaceId} gen ${status.generation}${status.connectionId !== null ? `, connection ${status.connectionId}` : ""})`,
				);
			},
			onError: (error, context) => {
				console.error(
					`omp-session: callback ${context.phase} failed: ${error.code} ${error.message}`,
				);
			},
			onEnvelope: (envelope) => routeDown(envelope),
			onControl: (envelope) => routeDown(envelope),
		},
	);
	// P3.7 session log tailing: the SDK's per-project sessions layout is a
	// cwd-encoded subdir under the agent's sessions root (main JSONL at
	// `<sessionsRoot>/<encoded-cwd>/`, its artifact subtree alongside), so
	// the tailer watches the sessions ROOT (matching the manifest traversal
	// in runtime/export-sessions.ts) and resolves each session's project
	// dir there. Constructed with the pair before start() so no window
	// exists where frames could emit before this handler is live. A missing
	// agent dir is not fatal here: the tailer logs the failure and keeps
	// polling until the dir appears.
	try {
		logTailer = new SessionLogTailer({
			sessionsDir,
			send: (streamId, payload) => callbackSend(streamId, "frame", payload),
		});
	} catch (err) {
		console.error(
			`omp-session: log tailer unavailable (${err instanceof Error ? err.message : String(err)}); session logs will not stream`,
		);
	}
	// Control broker (P3.3/P3.5/P4.5): mounted after the tailer so log
	// controls are routed first; broker handles stream_open/close, quiesce,
	// and command dispatch over the pair. Command answers flow through the
	// broadcast mirror (the frame tap), so handleCommand resolves undefined
	// and the tap forwards the answer frames.
	daemonControl = createDaemonControl({
		getEntry: () =>
			bootEntry === null
				? undefined
				: { disposeQuiesce: () => closeSession(bootEntry!, "quiesce") },
		handleCommand: async (command: unknown) => {
			await handleCommand(command as ClientCommand);
			return undefined; // Answers flow through the broadcast mirror tap.
		},
		flushWriters: () =>
			flushAllWriters({
				entry: bootEntry!,
				registry: bootEntry!.agentRegistry,
				mainSessionFile: bootEntry!.session.sessionFile ?? null,
			}),
		finalizeTailer: async () => {
			if (logTailer === null) {
				throw callbackError("unavailable", "log tailer unavailable for quiesce");
			}
			return finalizeTailerBoundary(logTailer);
		},
		waitForAckedBoundary: async (boundary, timeoutMs) => {
			const deadline = Date.now() + timeoutMs;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const poll = (): void => {
				if (logTailer !== null) {
					const acked = logTailer.ackedOffsets();
					if (boundaryAcked(boundary, acked)) {
						resolve();
						return;
					}
				}
				if (Date.now() > deadline) {
					reject(
						callbackError(
							"retryable",
							"timed out waiting for fleet log_acks to cover the flush boundary",
						),
					);
					return;
				}
				setTimeout(poll, 200);
			};
			poll();
			return promise;
		},
		verifyLineage: async () => {
			verifyLineageStructure(sessionsDir);
			const files = enumerateLineageManifest(sessionsDir);
			let resolvedCommit = "";
			try {
				const proc = Bun.spawn(["git", "-C", config.cwd, "rev-parse", "HEAD"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				resolvedCommit = new TextDecoder()
					.decode(await new Response(proc.stdout).arrayBuffer())
					.trim();
			} catch {
				resolvedCommit = "";
			}
			return {
				manifestFiles: files,
				provenance: {
					workspaceId: config.callbackWorkspace!,
					workspaceName: config.name,
					resolvedCommit,
					generatedAt: Date.now(),
				},
			};
		},
		collectGitEvidence: async () => {
			const result = await collectGitEvidence(config.cwd);
			if (!result.ok) {
				return {
					ok: false,
					error: { code: result.error!.code, message: result.error!.message },
				};
			}
			return { ok: true, git: result.evidence };
		},
		primeStream: (streamId) => {
			// Re-prime burst: the same frame set the direct SSE priming sends.
			const entry = bootEntry;
			if (entry === null) {
				console.error(`omp-session: cannot prime ${streamId}: no boot session`);
				return;
			}
			const ctl = daemonControl;
			if (ctl === null) return;
			const publish = (frame: Record<string, unknown>): void => ctl.publish(streamId, frame);
			publish({
				type: "hello_ok",
				proto: OMP_PROTO,
				name: config.name,
				cwd: config.cwd,
				pid: process.pid,
				version,
				...(entry.session.sessionFile ? { sessionFile: entry.session.sessionFile } : {}),
			});
			publish({ type: "attached", sessionId: BOOT_HANDLE });
			publish({
				type: "state",
				state: daemonBroker.buildStateSnapshot(entry.session),
				stats: entry.session.getSessionStats(),
			});
			publish({
				type: "collab_status",
				status: collabSession.toWireStatus(entry.collab.adapter?.status ?? null),
			});
			if (readyAt !== null) publish({ type: "ready", readyAt });
		},
		send: callbackSend,
		pairLive: () => fleetCallback !== null && fleetCallback.status().state === "ready",
		mainSessionFile: null,
	});
	// Register the mirror tap: every broadcast/broadcastAnswer/broadcastTo
	// frame is forwarded verbatim: to the "control" stream (fleet activity +
	// fanout correlation) AND every open browser stream (ringed deltas ring
	// for reconnect replay). Tap must never throw into delivery.
	setOnFrameTap((frame) => {
		const ctl = daemonControl;
		if (ctl !== null) ctl.mirror(frame as Record<string, unknown>);
	});
	// Once the pair is ready (fleet pair_ready observed) start streaming
	// session logs over it; tailer start() is sync (initial scan + watcher).
	void fleetCallback.start().then(() => {
		logTailer?.start();
		daemonControl?.onPairChange();
	});
}

// ---------------------------------------------------------------------------
// Idle auto-exit (R11): a 15s tick (default; the OMP_SESSION_TEST_IDLE_CHECK_MS
// env hook overrides it for tests) exits via shutdown() once the daemon has
// been continuously idle for config.idleTimeoutMs (0 disables). Idle = ALL
// suppression conditions false; any socket message or suppression resets the
// activity clock.
// ---------------------------------------------------------------------------

function isIdleSuppressed(): boolean {
	if (streams.size > 0) return true;
	if (getInFlightBash() > 0 || getInFlightPython() > 0) return true;
	if (bootEntry) {
		if (bootEntry.session.isStreaming) return true;
		if (bootEntry.session.queuedMessageCount > 0) return true;
		if (bootEntry.pendingUiRequests.size > 0) return true;
		if (ephemeralAborts.get(bootEntry)?.size) return true;
		if (bootEntry.collab.adapter?.isLive || bootEntry.collab.starting) return true;
	}
	return false;
}

function idleCheckTick(): void {
	if (config.idleTimeoutMs <= 0) return;
	if (isIdleSuppressed()) {
		markActivity();
		return;
	}
	if (Date.now() - lastActivityAt >= config.idleTimeoutMs) {
		console.error(`omp-session: idle for ${config.idleTimeoutMs}ms; shutting down`);
		void shutdown();
	}
}

lastActivityAt = Date.now();
if (config.idleTimeoutMs > 0) idleTimer = setInterval(idleCheckTick, config.idleCheckMs);

/** Collab relay base URL: env-overridable, defaults to this server's own port. */
function relayBaseUrl(): string {
	return config.collabUrl ?? `ws://localhost:${server.port}`;
}

// Graceful shutdown: dispose the boot session via closeSession (beginDispose
// is the sync admission barrier; dispose is idempotent), then exit.
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	if (idleTimer) clearInterval(idleTimer);
	// Stop the log tailer BEFORE the callback pair so no chunk frames queue
	// into a half-torn transport, then stop the pair (its own stop is sync).
	if (logTailer !== null) logTailer.stop();
	if (daemonControl !== null) daemonControl.stop();
	if (fleetCallback !== null) fleetCallback.stop();
	if (bootEntry) await closeSession(bootEntry, "server shutting down");
	server.stop();
	// Release session-file locks before the SDK postmortem cleanup runs so a
	// crash-free exit never leaves a live lock behind.
	for (const lock of sessionLocks) lock.release();
	// Run the SDK's registered postmortem cleanup callbacks (browser/pty/MCP
	// teardown etc.) without exiting; the exit is ours below.
	await postmortemCleanup().catch(() => {});
	process.exit(0);
}
