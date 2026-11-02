import { open, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import {
	cfgCollabAutoStart,
	cfgCollabDisplayName,
	cfgCollabRelayUrl,
	cfgCollabWebUrl,
} from "@oh-my-pi/pi-coding-agent/collab/settings";
import { DEFAULT_RELAY_URL } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
	cleanup as postmortemCleanup,
	installProcessHandlers,
} from "@oh-my-pi/pi-utils/postmortem";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type {
	AvailableSlashCommand,
	ClientCommand,
	ServerFrame,
	SessionListEntry,
} from "#lib/wire/protocol";
import {
	COMMAND_DEDUP_ANSWER_CAP,
	COMMAND_DEDUP_ANSWER_BYTES,
	COMMAND_DEDUP_ID_CAP,
	COMMAND_DEDUP_WINDOW_MS,
	OMP_PROTO,
	OMP_SESSION_EXIT_RESUME_FAILED,
	OMP_SESSION_EXIT_SESSION_LOCKED,
	OMP_SESSION_PREFIX,
	CLIENT_BACKPRESSURE_BYTES,
	DELTA_SEQ_START,
	type StdoutContractLine,
} from "#lib/wire/protocol";
import {
	ackMessage,
	BROWSER_SOCKET_MAX_PAYLOAD_BYTES,
	BROWSER_SOCKET_PATH,
	browserCloseFor,
	nackMessage,
	parseBrowserSocketParams,
	parseClientMessage,
	seqFrameMessage,
} from "#lib/wire/browser-socket";
import { parseClientCommand } from "#lib/wire/client-command";
import { acquireFileLock, LockHeldError } from "#lib/platform/file-lock";
import type { FileLock } from "#lib/platform/file-lock";
import { isLoopbackHost } from "#lib/platform/hosts";
import { parseConfig, parseFleetStdin, type SessionConfig } from "./config";
import {
	discardAllStagedExports,
	isDownloadBulkCommand,
	serveDownloadBulk,
} from "./download-manifest";
import { type ClientCredentials, httpAuthorized, socketRefusal } from "./client-auth";
import { browserRequestAllowed } from "#lib/runtime/browser-guard";
import {
	CALLBACK_TRANSPORT_STREAM_ID,
	FleetCallback,
	type FleetCallbackStatus,
} from "./fleet-callback";
import { SessionLogTailer } from "./log-tailer";
import type { LifecycleMirror } from "./lifecycle-adapter";
import {
	MaterializeSessionError,
	materializeSessionToDir,
	sessionTreeExists,
} from "./session-materialize";
import { getAutonomyAdapter } from "./autonomy-adapter";
import { CollabHostAdapter, type CollabAccess } from "./collab-host";
import { chooseRelayUrl, decideAutoStart } from "./collab-policy";
import { createCollabSession } from "./collab-session";
import { createDaemonBroker } from "./daemon-broker";
import { gitCapability } from "./capabilities";
import { createWebMethods } from "./methods";
import { BOOT_HANDLE, type SessionEntry } from "./session-entry";
import { createSessionChangeGate } from "./session-change-gate";
import { unwatchSkills } from "./skill-methods";
import { loginWithCallbacks } from "./login";
import {
	broadcast,
	answeringTo,
	broadcastAnswer,
	broadcastHistory,
	broadcastTo,
	detachConsumer,
	notifyEvent,
	pendingCodeInputs,
	rejectOwnedCodeInputs,
	ringAfter,
	sendPaced,
	sendTo,
	setOnConsumerDetached,
	setOnStreamsEmpty,
	snapshotDeltaSeq,
	startKeepalive,
	streams,
	terminateConsumer,
	type ClientConsumer,
	type ClientSocketData,
	wakeDrainWaiter,
} from "./client-delivery";
import { clearSubagents } from "./subagent-mirror";
import { jobWidgetPrimeFrames } from "./job-widgets";
import {
	pendingUiRequestFrames,
	rejectEntryUiRequests,
	rejectStreamUiRequests,
	setCallbackBrowserStreamCount,
	webUiRequest,
} from "./ui-context";
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import type { CallbackEnvelope } from "#lib/wire/callback-protocol";
import { createSessionControl, type SessionControl } from "./session-control";
import { setOnFrameTap, setOnHistoryTap, streamingPrimeFrames } from "./client-delivery";
import { settingWriteReloadsHistory, transcriptHistoryFrames } from "./transcript-history";
import { initSdkTuiGlobals } from "./sdk-tui-globals";
import { initSettings } from "./settings-boot";
import { pinModelRoles } from "./model-role-pin";

// omp-session owns its process, like the omp CLI: since pi-utils 18.15.0 an embedding host
// gets the SDK's fatal handlers (cleanup before a fatal exit; benign worker IPC EPIPE and
// ERR_SOCKET_CLOSED contained) only by opting in. Its signal handlers are replaced at bind below.
installProcessHandlers();

// ---------------------------------------------------------------------------
// Bootstrap: one shared authStorage/modelRegistry pair (the SDK enforces the
// pairing), one Settings instance, then the single boot session. omp-session is
// de-muxed (Phase 6): every /ws socket is attached to that one session from
// open (connect = attached), which routes call/login_code/ui_response and
// all session-scoped frames. The constant handle "s1" survives only as the
// attached frame's client guard token (`attached.scope`); session-scoped
// frames carry no `scope` stamp on the wire.
// ---------------------------------------------------------------------------

let config: SessionConfig;
try {
	const argv = process.argv.slice(2);
	// The fleet hands the callback pair and listener token over stdin, never env or argv.
	const fleet = argv.includes("--fleet-stdin")
		? parseFleetStdin(await Bun.stdin.text())
		: undefined;
	config = parseConfig(argv, fleet);
} catch (err) {
	console.error(`omp-session: ${String(err)}`);
	process.exit(1);
}
// Non-loopback bind without a token is a startup hard error (R14).
if (!isLoopbackHost(config.host) && !config.token) {
	console.error(
		`omp-session: refusing to bind non-loopback address "${config.host}" without a token; pass --token or supply it in the --fleet-stdin payload`,
	);
	process.exit(1);
}
// The web host has no terminal: initialize the SDK's terminal globals before any session exists.
initSdkTuiGlobals();
// TUI default global config directory (~/.omp/agent; sdk.ts documents the same).
const agentDir = getAgentDir();
const sessionsDir = path.join(agentDir, "sessions");
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
const settings = await initSettings({ cwd: config.cwd, agentDir });
// This session keeps the model roles it starts with when another session writes config.yml.
pinModelRoles(settings);

/** Set once the boot session's provider/model/auth resolution completes (R8). */
let readyAt: number | null = null;
/** The single boot session; hello_ok's sessionFile comes from it. */
let bootEntry: SessionEntry | null = null;
/** omp-session version for hello_ok; read from package.json when resolvable, else "dev". */
const version = await resolveVersion();

// Idle auto-exit (R11): a 15s tick (default; the OMP_SESSION_TEST_IDLE_CHECK_MS
// env hook overrides it for tests) exits via shutdown() when the session has
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
 * so early requests (socket upgrades) wait for registration. The
 * connect-implies-attached invariant holds even for sockets that race boot.
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

/** omp-session version for hello_ok: root package.json two levels up when resolvable, else "dev". */
async function resolveVersion(): Promise<string> {
	try {
		const pkg = (await Bun.file(path.join(import.meta.dir, "..", "..", "package.json")).json()) as {
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
// Extracted-module wiring (Phase 6 audit #7): each split module receives its
// boot-time deps explicitly: config/settings/authStorage/modelRegistry from
// the bootstrap above, plus the readiness clock. The delivery module's detach
// hooks are registered so stream teardown keeps rejecting stream-owned
// pending code inputs and UI requests exactly as before.
// ---------------------------------------------------------------------------

const attachmentGeneration = config.callbackGeneration ?? crypto.randomUUID();
const attachmentWorkspace = config.callbackWorkspace ?? config.cwd;
const daemonBroker = createDaemonBroker({
	config,
	getReadyAt: () => readyAt,
	getWebState: (session) => ({
		capabilities: { git: gitCapability(session.sessionManager.getCwd()) },
		sessionScope: {
			workspaceId: attachmentWorkspace,
			sessionId: session.sessionId,
			generation: String(attachmentGeneration),
		},
	}),
});
const collabSession = createCollabSession({
	config,
	agentDir,
	authStorage,
	modelRegistry,
	settings,
	broker: daemonBroker,
});
/** Fleet lifecycle mirror for acknowledged session deletion (no-op unpaired).
 *  Reads the callback pair and tailer declared below only when a deletion
 *  runs, long after module init. */
const lifecycleMirror: LifecycleMirror = {
	assertWritable: async () => {
		if (fleetCallback !== null && fleetCallback.status().state !== "ready") {
			throw new Error("Session lifecycle refused: fleet callback is not ready");
		}
	},
	purge: async (sessionId) => {
		logTailer?.forgetSession(sessionId);
		const callback = fleetCallback;
		if (callback === null) return;
		const result = callback.send({
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: "control",
			payload: { type: "session_deleted", sessionId },
		});
		if (result !== "sent") throw new Error(`Fleet cleanup notice not accepted (${result})`);
	},
};
const {
	methods: METHODS,
	readOnly: READ_ONLY,
	nameOnly: NAME_ONLY,
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
	cwd: config.cwd,
	hasCallbackPair: () => fleetCallback !== null,
	lifecycleMirror,
});
const sessionChangeGate = createSessionChangeGate(NOT_READY_GATED);
setOnStreamsEmpty(() => {
	// Callback-pair browsers are virtual streams outside this set; keep the
	// daemon roster poll alive while any of them remain.
	if ((sessionControl?.browserStreamCount() ?? 0) === 0) daemonBroker.stopDaemonPoll();
});
setOnConsumerDetached((stream, reason) => {
	// A UI request dies only when every stream it was shown to is gone.
	if (bootEntry) rejectStreamUiRequests(bootEntry, stream, reason);
});

// ---------------------------------------------------------------------------
// /ws: register the consumer (connect = attached), prime it, and stream
// live deltas. The consumer registry and all delivery primitives live in
// client-delivery.ts.
// ---------------------------------------------------------------------------

let nextConsumerId = 1;

/**
 * The attach priming frames, in order: hello_ok (session identity), attached,
 * history (one frame, or byte-bounded chunks), state, collab_status,
 * available_commands (when built), ready (once the boot session is ready).
 * One builder for both transports, so a direct /ws socket and a callback
 * browser stream always prime the same state. Snapshots the session when called.
 */
function primingFrames(
	entry: SessionEntry,
	commands: AvailableSlashCommand[] | null,
): Array<ServerFrame> {
	return [
		{
			type: "hello_ok",
			proto: OMP_PROTO,
			name: config.name,
			cwd: config.cwd,
			pid: process.pid,
			version,
			...(entry.session.sessionFile ? { sessionFile: entry.session.sessionFile } : {}),
		},
		{ type: "attached", scope: BOOT_HANDLE },
		...transcriptHistoryFrames(entry.session),
		...streamingPrimeFrames(entry),
		{
			type: "state",
			state: daemonBroker.buildStateSnapshot(entry),
			stats: entry.session.getSessionStats(),
		},
		// A dialog still open must reach a client that attaches after it was sent.
		...pendingUiRequestFrames(entry),
		// The running background jobs' widget glances (nothing while none runs).
		...jobWidgetPrimeFrames(entry),
		// The SDK's start-up model-fallback warning, once, to the first client that attaches.
		...collabSession.takeStartupNoticeFrames(),
		// Current collab status, so a client attaching to a live room sees it immediately.
		{
			type: "collab_status",
			status:
				entry.collab.adapter === null && entry.collab.refusal !== null
					? { state: "error", error: entry.collab.refusal }
					: collabSession.toWireStatus(entry.collab.adapter?.status ?? null),
		},
		...(commands !== null ? [{ type: "available_commands" as const, commands }] : []),
		// Late attachers get `ready` appended to the priming sequence (R8).
		...(readyAt !== null ? [{ type: "ready" as const, readyAt }] : []),
	];
}

/**
 * Prime a fresh browser socket: hello_ok first (session identity; HTTP-level
 * auth replaced the WS hello handshake), then the attach priming (attached →
 * history → state → collab_status → available_commands → ready), seqs 1..k
 * (k < DELTA_SEQ_START). `commands` is built BEFORE the socket upgrades so
 * every priming seq is assigned contiguously (no async gap between priming
 * and the delta era). Then resume per `after`: only ring deltas with
 * seq > max(after, snapshotSeq - 1) replay. The snapshot mark (the
 * next delta seq at prime start) bounds the overlap so a resume never
 * re-delivers deltas whose effects are already inside the fresh priming
 * (finding #2: a completed turn's event deltas would otherwise duplicate
 * chat/tool items on top of the just-primed history).
 *
 * The history frame is the one potentially multi-megabyte payload (base64
 * image data URLs inside messages): it is chunked and paced to the socket's
 * drain so a transcript over the 4 MiB backpressure cap still primes; a
 * synchronous single-frame prime would be closed 4503 by sendTo and the
 * client could never attach (finding #11). Pacing lets the socket drain
 * between chunks; the sequence stays 1..k because priming seqs never reach
 * DELTA_SEQ_START.
 */
async function primeConsumer(
	consumer: ClientConsumer,
	entry: SessionEntry,
	commands: AvailableSlashCommand[] | null,
	after: number | null,
): Promise<void> {
	// Snapshot the delta high-water mark BEFORE any priming is built: every
	// ringed delta with seq < snapshotSeq is fully reflected in the history/
	// state below, so replay must never deliver it again. Deltas >= snapshotSeq
	// arrived while the paced prime was in flight and ride the ring replay.
	const snapshotSeq = snapshotDeltaSeq();
	consumer.attached = entry.handle;
	let seq = 1;
	for (const [index, frame] of primingFrames(entry, commands).entries()) {
		const message = seqFrameMessage(seq++, JSON.stringify(frame));
		// hello_ok and attached land synchronously, before any await; the
		// rest (history chunks first) pace to the socket's drain.
		if (index < 2) sendTo(consumer, message);
		else await sendPaced(consumer, message);
	}
	// The socket closed while priming: nothing left to replay to.
	if (!streams.has(consumer)) return;
	// Replay floor: the client already has everything up to its `after` seq
	// and the fresh priming carries everything before the snapshot, so only
	// deltas after max(after, snapshotSeq-1) are new. An absent/sub-1024 seq
	// (fresh client, or a drop mid-prime) means priming carries full state up
	// to the snapshot, so the floor is just the snapshot mark; deltas that
	// arrived during the paced prime still replay exactly once.
	const resumeFrom =
		after !== null && after >= DELTA_SEQ_START ? Math.max(after, snapshotSeq - 1) : snapshotSeq - 1;
	const replay = ringAfter(resumeFrom);
	// The ring keeps only the last CLIENT_RING_CAP deltas and evicts from the
	// head; a first entry above resumeFrom+1 means entries the client still
	// needs were evicted while the (paced) prime was in flight. Replaying the
	// tail would silently skip them, so drop and resume instead: the reconnect's
	// `after` is a priming seq, so it lands below the new snapshot mark
	// and the fresh prime carries everything again.
	if (replay.length > 0 && replay[0].seq > resumeFrom + 1) {
		terminateConsumer(consumer, "ring eviction: resume window exceeded the replay ring");
		return;
	}
	for (const { value } of replay) sendTo(consumer, value);
}

/**
 * Answer a `GET /ws`: authenticate and proto-check the dial, then upgrade.
 * A refused dial is upgraded too and closed at once with its typed code in
 * `open` (a browser cannot read a non-101 status); only a request that is no
 * WebSocket upgrade at all gets an HTTP 400. Slash commands are built before
 * the upgrade so the priming sequence is written contiguously (seqs 1..k)
 * with no async gap into the delta era.
 */
async function upgradeClient(
	req: Request,
	srv: Server<ClientSocketData>,
	url: URL,
): Promise<Response | undefined> {
	if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return new Response(`${BROWSER_SOCKET_PATH} requires a WebSocket upgrade`, { status: 400 });
	}
	const params = parseBrowserSocketParams(url.searchParams);
	const refusal = socketRefusal(clientCredentials(req, srv), params);
	let commands: AvailableSlashCommand[] | null = null;
	if (refusal === null) {
		try {
			commands = await buildAvailableSlashCommands(bootEntry!.session);
		} catch (err) {
			console.error("Failed to build available commands:", err);
		}
	}
	if (!srv.upgrade(req, { data: { consumer: null, refusal, after: params.after, commands } })) {
		return new Response(`${BROWSER_SOCKET_PATH} WebSocket upgrade failed`, { status: 400 });
	}
	return undefined;
}

/** Refuse one client message that breaks the contract: close 4400. */
function closeProtocolViolation(ws: ServerWebSocket<ClientSocketData>, message: string): void {
	const { code, reason } = browserCloseFor("protocol_violation", message);
	ws.close(code, reason);
}

/**
 * Accept one parsed command from a socket: ack it, then dispatch. A duplicate
 * id inside COMMAND_DEDUP_WINDOW_MS is acked again without a re-dispatch.
 * When the original already answered, the recorded answer is replayed (the
 * duplicate is the client recovering a lost one); a duplicate that arrives
 * while the original is still in flight is a silent accept, since that answer
 * is still coming. The ack precedes any answer the dispatch emits.
 */
function acceptCommand(consumer: ClientConsumer, cmd: ClientCommand): void {
	markActivity();
	sendTo(consumer, ackMessage(cmd.id));
	// Answers go to the socket that sent the command, never to its siblings.
	answeringTo(consumer, () => {
		if (commandSeenRecently(cmd.id)) {
			const answer = commandAnswers.get(cmd.id);
			if (answer !== undefined) broadcastAnswer(answer.frame);
			return;
		}
		// Fire-and-forget accept: answers ride the socket only.
		void handleCommand(cmd).catch((err) => console.error("command dispatch failed:", err));
	});
}

/**
 * The browser-socket handler of the direct listener. Bun runs `open` inside
 * `server.upgrade`. perMessageDeflate stays off; `backpressureLimit` sits far
 * above anything the sendTo cap lets accumulate and never closes the socket
 * (the CLIENT_BACKPRESSURE_BYTES cap, not Bun, decides drop-and-resume).
 */
const clientSocketHandler: WebSocketHandler<ClientSocketData> = {
	maxPayloadLength: BROWSER_SOCKET_MAX_PAYLOAD_BYTES,
	perMessageDeflate: false,
	backpressureLimit: 4 * CLIENT_BACKPRESSURE_BYTES,
	closeOnBackpressureLimit: false,
	// Bun pings idle peers and reaps ones that never pong.
	idleTimeout: 120,
	open: (ws) => {
		const { refusal } = ws.data;
		if (refusal !== null) {
			ws.close(refusal.code, refusal.reason);
			return;
		}
		const entry = bootEntry!; // the fetch gate waited for bootReady
		const consumer: ClientConsumer = {
			id: nextConsumerId++,
			ws,
			attached: null,
			lastSendAt: Date.now(),
		};
		ws.data.consumer = consumer;
		streams.add(consumer);
		daemonBroker.startDaemonPoll();
		startKeepalive();
		// Connect = attached: a bare /ws open reproduces the single-session
		// priming sequence. hello_ok and attached are sent synchronously above
		// any await; only the history chunking paces (large transcripts drain
		// between chunks).
		void primeConsumer(consumer, entry, ws.data.commands, ws.data.after).catch((err) => {
			console.error("Failed to prime /ws socket:", err);
		});
	},
	message: (ws, message) => {
		const { consumer } = ws.data;
		if (consumer === null) return;
		if (typeof message !== "string") {
			closeProtocolViolation(ws, "binary messages are not part of the protocol");
			return;
		}
		const parsed = parseClientMessage(message, Buffer.byteLength(message, "utf8"));
		if (!parsed.ok) {
			if (parsed.id === null) closeProtocolViolation(ws, parsed.error);
			else sendTo(consumer, nackMessage(parsed.id, parsed.status, parsed.error));
			return;
		}
		acceptCommand(consumer, parsed.command);
	},
	// The socket's buffer emptied: a priming wait may resume.
	drain: (ws) => {
		if (ws.data.consumer !== null) wakeDrainWaiter(ws.data.consumer);
	},
	close: (ws) => {
		// Detach only: sessions outlive sockets. A terminated consumer is already detached.
		const { consumer } = ws.data;
		if (consumer !== null && streams.has(consumer)) detachConsumer(consumer, "socket closed");
	},
};

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

/** Record why collab cannot run for `entry` and tell its clients; late attachers see it in priming. */
function refuseCollab(entry: SessionEntry, reason: string): void {
	entry.collab.refusal = reason;
	broadcastTo(entry.handle, { type: "collab_status", status: { state: "error", error: reason } });
}

/** Host a room for `entry` through `relayUrl`. Shared by collab_start and collab.autoStart. */
async function startCollabForEntry(
	entry: SessionEntry,
	relayUrl: string,
	access: CollabAccess,
): Promise<void> {
	entry.collab.starting = true;
	entry.collab.refusal = null;
	broadcastTo(entry.handle, { type: "collab_status", status: { state: "starting" } });
	// collab.webUrl names the browser client for a relay; the public relay's web app is the default.
	const webUrl =
		cfgCollabWebUrl.get(settings).trim() ||
		(relayUrl === DEFAULT_RELAY_URL ? "https://my.omp.sh" : undefined);
	const adapter = new CollabHostAdapter(collabSession.buildCollabPort(entry), {
		hostName: cfgCollabDisplayName.get(settings).trim() || os.userInfo().username || "web",
		webUrl,
		onStatusChange: (status) => {
			// A room that ends (stop, session switch, relay drop) is no longer this session's adapter.
			if (status === null && entry.collab.adapter === adapter) entry.collab.adapter = null;
			broadcastTo(entry.handle, {
				type: "collab_status",
				status: collabSession.toWireStatus(status),
			});
		},
	});
	try {
		await adapter.start(relayUrl, access);
		entry.collab.adapter = adapter;
	} catch (err) {
		refuseCollab(entry, String(err));
	} finally {
		entry.collab.starting = false;
	}
}

/**
 * Dispose the boot session and cut every stream off it. Only invoked from
 * shutdown: streams are detached (never closed); pending ui_requests and the
 * pending login code inputs of those streams are rejected.
 */
async function closeSession(entry: SessionEntry, reason: string): Promise<void> {
	// Collab teardown before dispose: stop the adapter (guests get a bye).
	const adapter = entry.collab.adapter;
	entry.collab.adapter = null;
	if (adapter) await adapter.stop(reason).catch(() => {});
	getAutonomyAdapter(entry).dispose();
	unwatchSkills(entry);
	entry.session.beginDispose();
	await entry.session.dispose().catch(() => {});
	rejectEntryUiRequests(entry, reason);
	rejectOwnedCodeInputs(entry.handle, reason);
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
		// Test hook (OMP_SESSION_TEST_UI_REQUEST=1, see apps/session/config.ts):
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
				// Before the scope check: a send that races a session replacement is told so,
				// not advised to refresh (see session-change-gate.ts).
				sessionChangeGate.assertOpen(cmd.method);
				if (
					cmd.scope &&
					(cmd.scope.workspaceId !== attachmentWorkspace ||
						cmd.scope.generation !== String(attachmentGeneration) ||
						cmd.scope.sessionId !== entry.session.sessionId)
				)
					throw new Error("Stale session attachment; refresh before retrying");
				// Readiness gate (R8): prompt-family methods are rejected until
				// the boot session's provider/model/auth resolution completes.
				// The wire error is the literal string "not_ready".
				if (readyAt === null && Object.hasOwn(NOT_READY_GATED, cmd.method)) throw "not_ready";
				// Own-property lookup: an inherited name (`constructor`, `toString`) is not a method.
				const method = Object.hasOwn(METHODS, cmd.method) ? METHODS[cmd.method] : undefined;
				if (!method) throw new Error(`Unknown method: ${cmd.method}`);
				await sessionChangeGate.track(cmd.method, async () => {
					const result =
						cmd.method === "login"
							? await loginWithCallbacks(
									entry,
									cmd.args?.[0] as string,
									authStorage,
									async (providerId) => {
										// Online refresh re-runs discovery for the stored credential's
										// provider (device-login aliases can store under another id).
										await modelRegistry.refreshProvider(providerId, "online");
										await daemonBroker.broadcastAvailableCommands(entry);
									},
								)
							: await method(entry, cmd.args ?? [], cmd.streamId);
					// A settings write that changes the transcript (display.collapseCompacted) resyncs
					// history like a HISTORY_RELOAD method, so attached transcripts follow the setting.
					const reloadsHistory =
						Boolean(HISTORY_RELOAD[cmd.method]) || settingWriteReloadsHistory(cmd.method, cmd.args);
					// Post-mutation resync is best-effort: the mutation already
					// succeeded, so a resync failure must not fail the call.
					const resync = async () => {
						try {
							if (reloadsHistory)
								await broadcastHistory(entry.handle, transcriptHistoryFrames(entry.session));
							if (HISTORY_RELOAD[cmd.method] || !(READ_ONLY[cmd.method] || NAME_ONLY[cmd.method]))
								await daemonBroker.broadcastState(entry);
						} catch (err) {
							console.error("Post-mutation resync failed:", err);
							broadcast({ type: "error", error: `resync failed: ${String(err)}` });
						}
					};
					if (reloadsHistory) {
						// Resync BEFORE the call_result: picker success UI (notices,
						// modal close) must run after the transcript is replaced.
						await resync();
						answerCommand(cmd.id, { type: "call_result", id: cmd.id, ok: true, data: result });
					} else {
						answerCommand(cmd.id, { type: "call_result", id: cmd.id, ok: true, data: result });
						await resync();
					}
				});
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
					// attached tab dismisses the dialog and a resuming socket
					// (older `after`) replays end-after-request instead of
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
						firstMessage: i.firstMessage.slice(0, 500),
						...(i.status !== undefined ? { status: i.status } : {}),
					}))
					.sort((x, y) => y.modifiedAt - x.modifiedAt)
					.slice(0, 200);
				broadcastAnswer({ type: "sessions", id: cmd.id, sessions: sessionsList });
				break;
			}
			case "list_files": {
				broadcastAnswer({
					type: "files",
					id: cmd.id,
					files: await listFiles(cmd.query, cmd.limit ?? 50),
				});
				break;
			}
			case "spawn":
			case "spawn_resume":
			case "stop":
				// Fleet-edge commands on a bare omp-session (the registry lives
				// in omp-fleet, Phase 3).
				broadcastAnswer({ type: "error", error: "fleet-only command" });
				break;
			case "collab_start": {
				const entry = attachedEntry();
				if (!entry) throw new Error("Not attached to a session");
				// Idempotent: a room already starting or live answers with its current status.
				if (entry.collab.starting || entry.collab.adapter) {
					broadcastTo(entry.handle, {
						type: "collab_status",
						status: entry.collab.starting
							? { state: "starting" }
							: collabSession.toWireStatus(entry.collab.adapter?.status ?? null),
					});
					break;
				}
				// An explicit relayUrl (the ShareSheet's choice) wins over collab.relayUrl.
				// Unset stays undefined: the SDK default relay never applies implicitly.
				const configuredRelay = settings.isConfigured(cfgCollabRelayUrl)
					? cfgCollabRelayUrl.get(settings)
					: undefined;
				const relay = chooseRelayUrl(configuredRelay, cmd.relayUrl);
				if (!relay.ok) {
					refuseCollab(entry, relay.reason);
					break;
				}
				await startCollabForEntry(entry, relay.relayUrl, cmd.access ?? "control");
				break;
			}
			case "collab_stop": {
				const entry = attachedEntry();
				if (!entry) throw new Error("Not attached to a session");
				const adapter = entry.collab.adapter;
				// Idempotent: stopping a room that is not live reports where it stands.
				if (entry.collab.starting || !adapter) {
					broadcastTo(entry.handle, {
						type: "collab_status",
						status: entry.collab.starting ? { state: "starting" } : { state: "off" },
					});
					break;
				}
				entry.collab.adapter = null;
				// The adapter's teardown reports `off` through onStatusChange.
				await adapter.stop("collab stopped by web user");
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
			// Recorded like any other answer, so a re-sent command's replay reports the
			// real dispatch failure instead of a fabricated success.
			answerCommand(cmd.id, {
				type: "call_result",
				id: cmd.id,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		} else {
			broadcastAnswer({ type: "error", error: String(err) });
		}
	}
}

// Roots for download_bulk (fleet-initiated session-file transfers). The only
// trust boundary on that channel: the canonical (realpath) target must live
// inside the system temp dir, the agent cwd (where bare-filename exports
// land), or a live session file's directory. Canonicalizing both sides closes
// symlink escapes that a lexical prefix check would miss.
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

/** The peer's credentials for the R14 gate (loopback is read from the socket peer address). */
function clientCredentials(req: Request, srv: Server<ClientSocketData>): ClientCredentials {
	return {
		loopback: isLoopbackIp(srv.requestIP(req)?.address),
		token: config.token,
		authorization: req.headers.get("authorization"),
		// The session serves no UI, so no browser origin is configured: only loopback names pass.
		browserAllowed: browserRequestAllowed(req, undefined),
	};
}

/**
 * R14 gate for every plain HTTP route: loopback is exempt; off-loopback
 * peers need the bearer token via the Authorization header. A missing or
 * wrong credential is a 401 with no hello window and no close codes.
 */
function r14Authorized(req: Request, srv: Server<ClientSocketData>): boolean {
	return httpAuthorized(clientCredentials(req, srv));
}

/**
 * Command idempotency (browser socket and callback pair): re-accept duplicates of a command id within
 * COMMAND_DEDUP_WINDOW_MS (ids capped at COMMAND_DEDUP_ID_CAP as a flood
 * backstop) without re-dispatching, and REPLAY the answer the original
 * already produced (answers capped at COMMAND_DEDUP_ANSWER_CAP, since each
 * one can be large).
 *
 * The replay is what makes the client's lost-answer recovery work. Answers are
 * unicast (call_result and friends) and deliberately NOT ringed, so a dropped
 * answer is recoverable only by re-sending the command; a dedup that re-accepts
 * the duplicate silently would leave that re-send unanswered forever. The
 * duplicate still never re-dispatches, so a replayed command executes once: the
 * id memory therefore outlives every answer, and only the id cap can lose one
 * (an evicted id would re-execute the command).
 */
const commandDedup = new Map<string, number>();

/**
 * Recorded answers by command id, replayed to duplicates (same window as the
 * dedup). Bounded by count AND approximate serialized bytes (see
 * COMMAND_DEDUP_ANSWER_BYTES).
 */
const commandAnswers = new Map<string, { frame: ServerFrame; at: number; bytes: number }>();
let commandAnswerBytes = 0;

function forgetAnswer(id: string): void {
	const entry = commandAnswers.get(id);
	if (!entry) return;
	commandAnswerBytes -= entry.bytes;
	commandAnswers.delete(id);
}

/** Drop the oldest remembered keys past `cap` (insertion order is age order). */
function capRemembered<K, V>(map: Map<K, V>, cap: number): void {
	while (map.size > cap) {
		const oldest = map.keys().next();
		if (oldest.done) return;
		map.delete(oldest.value);
	}
}

/**
 * Record one id-keyed answer so a later duplicate command can replay it, then
 * broadcast it. Every answer the session emits for a command id goes through
 * here: the replay must return the ORIGINAL outcome (success data or the real
 * dispatch error), never a re-execution.
 */
function answerCommand(id: string | undefined, frame: ServerFrame): void {
	if (typeof id === "string" && id.length > 0) {
		const now = Date.now();
		for (const [key, entry] of commandAnswers) {
			if (now - entry.at > COMMAND_DEDUP_WINDOW_MS) forgetAnswer(key);
		}
		forgetAnswer(id);
		const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		commandAnswers.set(id, { frame, at: now, bytes });
		commandAnswerBytes += bytes;
		for (const key of commandAnswers.keys()) {
			if (
				commandAnswers.size <= COMMAND_DEDUP_ANSWER_CAP &&
				commandAnswerBytes <= COMMAND_DEDUP_ANSWER_BYTES
			)
				break;
			forgetAnswer(key);
		}
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

// ---------------------------------------------------------------------------
// Session-file locking: a second omp-session on the same session file fails
// loudly (exit OMP_SESSION_EXIT_SESSION_LOCKED, which spawners treat as
// deterministic: no retry) instead of racing the holder and clobbering state. The
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
			// The last stderr line is the user-facing reason: the fleet
			// supervisor surfaces it verbatim to the browser that asked.
			console.error(
				`omp-session: session file ${file} is locked by another omp-session (pid ${err.holderPid}); it is already open elsewhere (another omp-web or dev fleet), close it there and retry`,
			);
			process.exit(OMP_SESSION_EXIT_SESSION_LOCKED);
		}
		throw err;
	}
}

// A strict resume target (--resume, or the OMP_SESSION_RESUME env of a clone wake)
// names a transcript that must already exist. A missing one is
// refused here, before the lock and before bind, so no listening line prints and
// no .lock is left behind. --resume-unwritten (env: OMP_SESSION_RESUME_UNWRITTEN=1)
// opts into adopting the path instead (a never-prompted session keeps its identity).
if (
	config.resumeStrict &&
	config.resume &&
	path.isAbsolute(config.resume) &&
	!existsSync(config.resume)
) {
	console.error(`omp-session: --resume ${config.resume}: session file not found`);
	process.exit(OMP_SESSION_EXIT_RESUME_FAILED);
}
// Lock the --resume session file BEFORE bind, so a second omp-session
// pointed at the same file exits before printing its listening line: a
// spawner never resolves an endpoint (or dials) for a session that cannot
// own its session. Only absolute paths are locked here; the live file
// (which may be identical) is locked right after createSession below.
if (config.resume && path.isAbsolute(config.resume)) acquireSessionLock(config.resume);

// A fleet-managed session (--fleet-stdin, so callbackUrl is set) binds no
// listener: the fleet reaches it only over the callback WebSocket. A bare
// session binds the direct listener: the browser socket (GET /ws, OMP_PROTO 6)
// and nothing else; every other route answers the 404 pointer to the fleet.
const server =
	config.callbackUrl === undefined
		? Bun.serve<ClientSocketData>({
				port: config.port,
				hostname: config.host,
				// The only long-lived connections are WebSockets, whose idle reaping
				// lives in `websocket` below; plain requests keep no 10s cut-off.
				idleTimeout: 0,
				async fetch(req, srv) {
					// Boot gate: the OMP_SESSION| listening line prints before the boot session
					// exists; the first requests (and /ws upgrades) wait for registration
					// so connect-implies-attached holds for sockets that race boot.
					await bootReady;
					const url = new URL(req.url);
					// Agent-driving transport: one WebSocket per client; frames down,
					// in-band commands up (ack/nack replaces the old 202/4xx).
					if (url.pathname === BROWSER_SOCKET_PATH) return upgradeClient(req, srv, url);
					// Off-loopback peers need the bearer header on every non-wire route too,
					// so a tokened session answers no unauthenticated peer, not even its 404.
					if (!r14Authorized(req, srv)) return new Response("Unauthorized", { status: 401 });
					// No static or HTML route: the session serves the wire API only, so
					// everything else (including "/") points at the fleet, the only
					// web UI server.
					return new Response(
						"omp-web: this is a session process (no web UI). Start the fleet with `omp-web` and open the Web UI URL it prints.\n",
						{ status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
					);
				},
				websocket: clientSocketHandler,
			})
		: null;

// ---------------------------------------------------------------------------
// R6b: the OMP_SESSION| listening contract line goes to STDOUT immediately after
// bind, BEFORE session creation. Only a session with a direct listener prints it
// (a fleet-managed session binds none). The fleet does not parse it; it is
// informational for whoever launched the session. Human logs go to stderr.
// ---------------------------------------------------------------------------

if (server !== null) {
	const listeningLine: StdoutContractLine = {
		event: "listening",
		bind: config.host,
		port: server.port!,
	};
	console.log(`${OMP_SESSION_PREFIX}${JSON.stringify(listeningLine)}`);
	console.error(`omp-session listening on http://localhost:${server.port}`);
}

// installProcessHandlers adds SIGINT/SIGTERM/SIGHUP handlers (run SDK cleanup,
// then exitProcess(130/143/129)); they would preempt omp-session's graceful
// shutdown with the default-disposition exit code. omp-session owns these
// signals from bind onward (BEFORE the boot-session await below, so a kill
// during session creation cannot skip disposal): drop those handlers, run the
// same SDK cleanup callbacks inside our shutdown (postmortemCleanup never
// exits), and exit 0. The shutdown function is hoisted and every binding it
// touches is already initialized.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	for (const listener of process.listeners(sig)) process.removeListener(sig, listener);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());

/**
 * Diagnostic note for a refused `--resume`: the SDK rejects a switch whose
 * recorded cwd differs from this process's (the session's project dir is
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
				return ` (the session was recorded under ${header.cwd}, this session runs ${cwd})`;
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
/** Callback transport pair to the fleet; started after the boot
 *  session exists, stopped in shutdown(). Null = no callback flags. */
let fleetCallback: FleetCallback | null = null;
/** Session-lineage log tailer, streamed over the callback pair.
 *  Constructed with the callback (never without it); started after the
 *  pair starts, stopped before it stops in shutdown(). Null = no callback
 *  flags / tailer failed to construct. */
let logTailer: SessionLogTailer | null = null;
/** Bounded wait at shutdown for queued callback envelopes (the ShutdownControl ack) to reach the wire. */
const CALLBACK_DRAIN_MS = 1_000;
// Hard ceiling on a graceful shutdown: the callback drain (CALLBACK_DRAIN_MS,
// twice at most), the postmortem cleanup (its own 10 s deadline), and
// closeSession must all fit inside it. A step that never settles cannot keep
// the session alive past this point.
const SHUTDOWN_DEADLINE_MS = 20_000;
/** No-control-plane shutdown timer (C4): armed while no callback pair is ready. */
let controlGraceTimer: Timer | undefined;
/**
 * Callback control broker: per-browser virtual streams,
 * command routing, and control mirror. Created
 * only when the callback pair exists; null otherwise.
 */
let sessionControl: SessionControl | null = null;

/**
 * Wake: materialize a session's stored transcripts from the fleet log
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
// The SDK can fork a contested journal to a fresh sibling without ending the
// agent turn. Keep host locks and fleet's mirrored sessionFile in step with it.
bootSession.session.sessionManager.onPersistenceNotice((notice) => {
	acquireSessionLock(notice.to);
	notifyEvent(bootSession, `Session moved to ${notice.to} (${notice.reason})`, "warning");
	void daemonBroker.broadcastState(bootSession).catch((error) => {
		console.error("Failed to broadcast session persistence relocation:", error);
	});
});
if (config.resume) {
	const resumeFile = config.resume;
	let failure: string | undefined;
	try {
		if (!(await bootEntry.session.switchSession(resumeFile))) {
			failure = "session switch returned false";
		}
	} catch (err) {
		failure = `session switch threw (${String(err)})`;
	}
	if (failure !== undefined) {
		// Refuse rather than boot fresh: the fleet sees exit 78 (deterministic,
		// no retry) and no state frame, because the callback pair starts later.
		console.error(
			`omp-session: --resume ${resumeFile}: ${failure}; refusing to start fresh${await resumeCwdNote(resumeFile, config.cwd)}`,
		);
		await shutdown(OMP_SESSION_EXIT_RESUME_FAILED);
	}
	clearSubagents(bootEntry);
	await daemonBroker.broadcastAvailableCommands(bootEntry);
}
// collab.autoStart: host the boot session through the relay. Refused with a reason
// (logged and sent to clients) when no collab.relayUrl is set. Not awaited, so a slow
// or dead relay cannot hold the session's readiness gate.
const autoDecision = decideAutoStart(
	cfgCollabAutoStart.get(settings),
	chooseRelayUrl(
		settings.isConfigured(cfgCollabRelayUrl) ? cfgCollabRelayUrl.get(settings) : undefined,
	),
);
if (autoDecision.kind === "refuse") {
	console.error(autoDecision.reason);
	refuseCollab(bootEntry, autoDecision.reason);
} else if (autoDecision.kind === "start") {
	void startCollabForEntry(bootEntry, autoDecision.relayUrl, autoDecision.access);
}
resolveBootReady();
void bootReadiness(bootEntry);

// ---------------------------------------------------------------------------
// Callback transport: with all four callback flags set, dial the
// fleet's callback WebSocket (OMP_CALLBACK_PROTO 2, GET /callback/ws); the
// session binds no direct listener, the pair is its only transport. Started AFTER the boot session + readiness
// resolve so the pair speaks for a live workspace. start() resolves when the
// fleet's pair_ready lands; readiness and failures log to stderr (stdout is
// reserved for OMP_SESSION| lines).
// ---------------------------------------------------------------------------
if (config.callbackUrl !== undefined) {
	// Down-traffic router: log controls (log_ack/log_gap) apply to the
	// tailer; stream_open/close and every kind:"command" envelope go to
	// the control broker. Reads the mutable bindings at invocation
	// (constructed before FleetCallback below).
	const routeDown = (envelope: CallbackEnvelope): void => {
		if (envelope.kind === "control") {
			const payload = envelope.payload;
			const type = isObject(payload) ? payload.type : "";
			if (type === "log_ack" || type === "log_gap") {
				logTailer?.handleControl(envelope.streamId, envelope.payload);
				return;
			}
		}
		if (envelope.kind === "command" && isDownloadBulkCommand(envelope.payload)) {
			// Bulk transfers bypass the control broker: they stream on the bulk channel.
			const command = envelope.payload;
			const callback = fleetCallback;
			if (callback === null) return;
			void canonicalRoots().then((roots) =>
				serveDownloadBulk({
					correlationId: command.correlationId,
					path: command.path,
					cwd: config.cwd,
					roots,
					uploadParts: (input) => callback.requestBulkUploadParts(input),
					failControl: (payload) => {
						callbackSend(CALLBACK_CONTROL_STREAM_ID, "control", payload);
					},
				}),
			);
			return;
		}
		sessionControl?.handleEnvelope(envelope);
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
				// C4 grace: a ready pair cancels the no-control-plane timer; any other
				// live state (re)arms it. A terminal stop does not arm.
				if (status.state === "ready") {
					clearControlGrace();
					// Every pair-up (first pair, redial, a new control plane)
					// tells the fleet which session file this session is on: the
					// boot state broadcast predates the pair, and respawn resumes
					// the fleet's recorded lastSessionFile.
					const entry = bootEntry;
					if (sessionControl !== null && entry !== null) {
						sessionControl.publish("control", {
							type: "state",
							state: daemonBroker.buildStateSnapshot(entry),
							stats: entry.session.getSessionStats(),
						});
					}
				} else if (status.state !== "stopped") armControlGrace();
			},
			onError: (error, context) => {
				console.error(
					`omp-session: callback ${context.phase} failed: ${error.code} ${error.message}`,
				);
			},
			onEnvelope: (envelope) => routeDown(envelope),
			onControl: (envelope) => routeDown(envelope),
			onRejected: (error) => {
				console.error(
					`omp-session: fleet refused the callback pair: ${error.code} ${error.message}; shutting down`,
				);
				void shutdown();
			},
		},
	);
	// Session log tailing: the SDK's per-project sessions layout is a
	// cwd-encoded subdir under the agent's sessions root (main JSONL at
	// `<sessionsRoot>/<encoded-cwd>/`, its artifact subtree alongside), so
	// the tailer watches the sessions ROOT (matching the manifest traversal
	// in lib/session-files/export-sessions.ts) and resolves each session's project
	// dir there. Constructed with the pair before start() so no window
	// exists where frames could emit before this handler is live. A missing
	// agent dir is not fatal here: the tailer logs the failure and keeps
	// polling until the dir appears.
	if (config.logMirror) {
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
	}
	// Control broker: mounted after the tailer so log
	// controls are routed first; broker handles stream_open/close and
	// command dispatch over the pair. Command answers flow through the
	// broadcast mirror (the frame tap), so handleCommand resolves undefined
	// and the tap forwards the answer frames.
	sessionControl = createSessionControl({
		handleCommand: async (command: unknown) => {
			const cmd = parseClientCommand(command);
			markActivity();
			// Same idempotency window as the browser socket: a duplicate id replays the
			// recorded answer and is never re-dispatched.
			if (commandSeenRecently(cmd.id)) {
				const answer = commandAnswers.get(cmd.id);
				if (answer !== undefined) broadcastAnswer(answer.frame);
				return undefined;
			}
			await handleCommand(cmd);
			return undefined; // Answers flow through the broadcast mirror tap.
		},
		preparePriming: async () => {
			const entry = bootEntry;
			if (entry === null) throw new Error("no boot session to prime from");
			let commands: AvailableSlashCommand[] | null = null;
			try {
				commands = await buildAvailableSlashCommands(entry.session);
			} catch (err) {
				console.error("Failed to build available commands:", err);
			}
			return () => primingFrames(entry, commands);
		},
		bufferedBytes: (streamId) =>
			fleetCallback?.bufferedBytes(streamId) ?? { stream: 0, connection: 0 },
		onDrain: (listener) => fleetCallback?.onDrain(listener) ?? (() => {}),
		send: callbackSend,
		pairLive: () => fleetCallback !== null && fleetCallback.status().state === "ready",
		onShutdown: (reason) => {
			console.error(
				`omp-session: control plane requested shutdown${reason !== undefined ? ` (${reason})` : ""}`,
			);
			void shutdown();
		},
		onBrowserStreamsChange: (count) => {
			if (count > 0) daemonBroker.startDaemonPoll();
			else if (streams.size === 0) daemonBroker.stopDaemonPoll();
		},
	});
	// Browser presence for dialog/contribution guards: production browsers ride
	// the pair as virtual streams, invisible to the local /ws consumer set.
	setCallbackBrowserStreamCount(() => sessionControl?.browserStreamCount() ?? 0);
	// Register the mirror tap: every broadcast/broadcastAnswer/broadcastTo
	// frame is forwarded verbatim: to the "control" stream (fleet activity +
	// fanout correlation) AND every open browser stream (ringed deltas ring
	// for reconnect replay). Tap must never throw into delivery.
	setOnFrameTap((frame) => {
		const ctl = sessionControl;
		if (ctl !== null) ctl.mirror(frame as Record<string, unknown>);
	});
	// History resyncs reach the pair's browser streams through their own tap:
	// paced, and never onto the control stream.
	setOnHistoryTap(async (frames) => {
		await sessionControl?.publishHistory(frames);
	});
	// Once the pair is ready (fleet pair_ready observed) start streaming
	// session logs over it; tailer start() is sync (initial scan + watcher).
	void fleetCallback.start().then(
		() => {
			logTailer?.start();
		},
		() => {
			// stop() or supervisor exit before readiness. Both are already reported
			// through onError/onRejected, so the rejection is handled here; left
			// unhandled it would exit the session with status 1 during teardown.
		},
	);
}

// ---------------------------------------------------------------------------
// Idle auto-exit (R11): a 15s tick (default; the OMP_SESSION_TEST_IDLE_CHECK_MS
// env hook overrides it for tests) exits via shutdown() once the session has
// been continuously idle for config.idleTimeoutMs (0 disables). Idle = ALL
// suppression conditions false; any socket message or suppression resets the
// activity clock.
// ---------------------------------------------------------------------------

function isIdleSuppressed(): boolean {
	if (streams.size > 0) return true;
	if (sessionControl !== null && sessionControl.status().streams.length > 0) return true;
	if (getInFlightBash() > 0 || getInFlightPython() > 0) return true;
	if (bootEntry) {
		if (bootEntry.session.isStreaming) return true;
		if (bootEntry.session.queuedMessageCount > 0) return true;
		if (bootEntry.pendingUiRequests.size > 0) return true;
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

/** Arm the no-control-plane shutdown timer (C4). No-op when disabled or already armed. */
function armControlGrace(): void {
	if (controlGraceTimer !== undefined || config.controlGraceMs <= 0 || shuttingDown) return;
	controlGraceTimer = setTimeout(() => {
		controlGraceTimer = undefined;
		console.error(`omp-session: no control plane for ${config.controlGraceMs}ms; shutting down`);
		void shutdown();
	}, config.controlGraceMs);
}

function clearControlGrace(): void {
	clearTimeout(controlGraceTimer);
	controlGraceTimer = undefined;
}

// Graceful shutdown: dispose the boot session via closeSession (beginDispose
// is the sync admission barrier; dispose is idempotent), then exit with
// exitCode (0 for a signal; a refused --resume passes its failure code).

async function shutdown(exitCode = 0): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	setTimeout(() => process.exit(exitCode), SHUTDOWN_DEADLINE_MS);
	try {
		clearInterval(idleTimer);
		clearControlGrace();
		// Stop the log tailer and control broker first so nothing new queues, then
		// give queued envelopes (the ShutdownControl ack, final frames) a bounded
		// window to reach the wire before the pair closes.
		if (logTailer !== null) logTailer.stop();
		if (sessionControl !== null) sessionControl.stop();
		if (fleetCallback !== null) await fleetCallback.drain(CALLBACK_DRAIN_MS);
		if (fleetCallback !== null) fleetCallback.stop();
		if (bootEntry) await closeSession(bootEntry, "server shutting down");
		server?.stop();
		discardAllStagedExports();
		// Release session-file locks before the SDK postmortem cleanup runs so a
		// crash-free exit never leaves a live lock behind.
		for (const lock of sessionLocks) lock.release();
		// Run the SDK's registered postmortem cleanup callbacks (browser/pty/MCP
		// teardown etc.) without exiting; the exit is ours below.
		await postmortemCleanup().catch(() => {});
	} catch (cause) {
		console.error(
			`omp-session: shutdown step failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	} finally {
		process.exit(exitCode);
	}
}
