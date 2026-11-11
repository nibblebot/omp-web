/**
 * Per-session collab HOST adapter for the omp-web session.
 *
 * Mirrors `@oh-my-pi/pi-coding-agent/src/collab/host.ts` (CollabHost) wire
 * behavior against a slim `CollabSessionPort` abstraction over the session's
 * SDK sessions, minus all TUI concerns. Guests (real `omp join` clients)
 * connect through the session's relay room; this adapter taps the session's
 * event stream and append chokepoint and broadcasts entries/events/state to
 * them, and routes guest prompts/aborts/agent-cmds/ui-responses/transcript
 * fetches into the port.
 */

import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type {
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	ContextUsage,
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { stripImagesFromMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type {
	SessionEntry,
	SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
} from "@oh-my-pi/pi-coding-agent/collab/crypto";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabSessionState,
	type EncodedFrame,
	encodeFrame,
	encodeSnapshotChunk,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	serializeReplicatedEntry,
	serializeReplicatedEvent,
} from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

function isWireSessionEntry(entry: SessionEntry): entry is SessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}

const CONNECT_TIMEOUT_MS = 15_000;
/** Max bytes served per fetch-transcript reply (guest re-requests from `newSize`). */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft cap in UTF-8 bytes per `snapshot-chunk` frame (mirrors CollabHost): the
 * first MB of a snapshot takes ~3s through the default relay, so a 512 KB chunk
 * lands well under the guest's 30 s per-chunk progress timeout; oversized
 * single entries still ship in a chunk of their own.
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
/** Text of the `resync` error a shed guest gets (mirrors CollabHost, which keeps it private). */
const RESYNC_MESSAGE = "the host discarded your backlog; rejoin to resync";
/** Retry cadence for a resync error the send queue refused (mirrors CollabHost). */
const RESYNC_RETRY_MS = 1_000;

/** Agent roster entry the port exposes to collab guests. */
export interface CollabAgentRef {
	id: string;
	kind: "main" | "sub";
	displayName: string;
	status: "running" | "idle" | "parked" | "aborted";
	parentId?: string;
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
}

/**
 * The session's per-session surface the collab host adapter drives. The web
 * server (Slice C) implements this against a live SDK session; tests use a
 * fake.
 */
export interface CollabSessionPort {
	getSessionId(): string;
	getCwd(): string;
	getSessionName(): string | undefined;
	isStreaming(): boolean;
	isAborting(): boolean;
	queuedMessageCount(): number;
	getModel(): Model | undefined;
	getThinkingLevel(): string | undefined;
	getContextUsage(): ContextUsage | undefined; // {tokens, contextWindow, percent} | undefined
	/** sessionManager.snapshotForReplication() */
	snapshot(): { header: SessionHeader; entries: SessionEntry[] };
	/** session.subscribe; returns unsubscribe */
	subscribe(cb: (event: AgentSessionEvent) => void): () => void;
	/** sessionManager.onEntryAppended = cb (single slot; save+restore previous) */
	onEntryAppended(cb: (entry: SessionEntry) => void): void;
	/** BOTH task channels */
	subscribeBus(cb: (channel: BusChannel, data: unknown) => void): () => void;
	/** Fires when the roster may have changed */
	subscribeAgents(cb: () => void): () => void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	promptFromGuest(
		text: string,
		images: ImageContent[] | undefined,
		fromName: string,
	): Promise<void>;
	abort(): Promise<void>;
	listAgents(): CollabAgentRef[];
	agentCmd(
		cmd: "chat" | "kill" | "revive",
		agentId: string,
		text: string | undefined,
	): Promise<void>;
	resolveTranscriptFile(agentId: string): string | null;
}

/**
 * Outcome of {@link CollabHostAdapter.requestGuestUi}. `answered` carries the
 * guest's response (an `undefined` value is a genuine guest cancel);
 * `unavailable` means the collab channel went away (teardown, relay drop) or
 * the request was aborted before any guest answered; callers MUST NOT treat
 * it as a cancel.
 */
export type CollabGuestUiResult =
	| { kind: "answered"; value: CollabUiResponseValue; by: string; peer: number }
	| { kind: "unavailable" };

/** Web-visible host status; `null` (see `onStatusChange`) when the room is not live. */
export interface CollabHostStatus {
	state: "live" | "error";
	error?: string;
	access: CollabAccess;
	link: string;
	viewLink: string;
	/** Browser deep links; present only when the adapter has a `webUrl`. */
	browserLink?: string;
	browserViewLink?: string;
	relayUrl: string;
	roomId: string;
	participants: CollabParticipant[]; // [{name: hostName, role:"host"}, ...guests {name, role:"guest", readOnly?}]
}

/** `control` rooms mint a write token and advertise both links; `view` rooms advertise only the read link. */
export type CollabAccess = "view" | "control";

export interface CollabHostAdapterOptions {
	hostName: string;
	/** Browser client base for deep links (`collab.webUrl`, or the public relay's web app). Omit when no browser client serves the relay. */
	webUrl?: string;
	onStatusChange?: (status: CollabHostStatus | null) => void;
}

export class CollabHostAdapter {
	#port: CollabSessionPort;
	#opts: CollabHostAdapterOptions;
	#socket: CollabSocket | null = null;
	#link = "";
	#viewLink = "";
	#relayUrl = "";
	#roomId = "";
	#writeToken: Uint8Array | null = null;
	#access: CollabAccess = "control";
	#browserLink: string | undefined;
	#browserViewLink: string | undefined;
	#sessionId = "";
	/** True once the socket first opened; cleared on teardown. Gates `status`. */
	#live = false;
	#unsubscribe?: () => void;
	#busUnsubscribers: (() => void)[] = [];
	#agentsUnsubscribe?: () => void;
	#peers = new Map<number, { name: string; canWrite: boolean }>();
	#uiReqSeq = 0;
	#pendingUi = new Map<
		number,
		{
			request: CollabUiRequest;
			settle(result: CollabGuestUiResult): void;
			/** Writable peers the request was admitted for and that can still answer it. */
			recipients: Set<number>;
			/** Survives a relay reconnect: the local dialog behind it is still open. */
			retainOnReconnect?: boolean;
		}
	>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	/** Shed peers whose resync error the send queue refused, retried until one is admitted. */
	#unnotified = new Set<number>();
	#resyncRetry: Timer | null = null;
	#stopped = false;
	/** Set when stop() begins; guest traffic is refused from then on, before teardown finishes. */
	#stopping = false;
	/** Bumped on every `message_start`; keys a streaming message's superseding updates. */
	#messageSeq = 0;

	constructor(port: CollabSessionPort, opts: CollabHostAdapterOptions) {
		this.#port = port;
		this.#opts = opts;
	}

	/** Live status with current participants; `null` when not live. */
	get status(): CollabHostStatus | null {
		if (!this.#live || !this.#socket) return null;
		return {
			state: "live",
			access: this.#access,
			link: this.#link,
			viewLink: this.#viewLink,
			browserLink: this.#browserLink,
			browserViewLink: this.#browserViewLink,
			relayUrl: this.#relayUrl,
			roomId: this.#roomId,
			participants: this.participants,
		};
	}
	/** Guests share one roster: a repeated display name gets a numeric suffix so every participant stays distinct. */
	#uniqueGuestName(base: string, fromPeer: number): string {
		const taken = new Set<string>([this.#opts.hostName]);
		for (const [peerId, peer] of this.#peers) {
			if (peerId !== fromPeer) taken.add(peer.name);
		}
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
		return name;
	}

	/** The host's own display name (the web user's name in collab dialogs). */
	get hostName(): string {
		return this.#opts.hostName;
	}

	get isLive(): boolean {
		return this.#live && !this.#stopped && this.#socket !== null;
	}

	/** Number of connected guests that hold a valid write token. */
	get writableGuestCount(): number {
		let count = 0;
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) count++;
		}
		return count;
	}

	/** Host + connected guests (mirrors CollabHost's status-line participant count). */
	get participantCount(): number {
		return this.#peers.size + 1;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: this.#opts.hostName, role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	/**
	 * Mirror a host-side question to writable guests. Set `retainOnReconnect`
	 * only for a request backed by a local dialog whose lifetime still owns the
	 * signal: the relay recreating the room (a transport reconnect) then keeps
	 * the request, and a writer that rejoins is handed it again. Without it the
	 * request settles `unavailable` on a recreate. Stop and session replacement
	 * always discard it.
	 *
	 * The send queue can refuse a targeted frame, so the request tracks which
	 * writers actually hold it; when every writer refused it, none can answer and
	 * it settles `unavailable` at once.
	 */
	requestGuestUi(
		request: CollabUiRequestDraft,
		signal?: AbortSignal,
		options?: { retainOnReconnect?: boolean },
	): Promise<CollabGuestUiResult> | null {
		if (!this.#admitGuestTraffic() || !this.#hasWritablePeers()) return null;
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		const recipients = new Set<number>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#endUiRequest(reqId, recipients);
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		for (const peerId of this.#sendWritablePeers({ t: "ui-request", request: fullRequest })) {
			recipients.add(peerId);
		}
		this.#pendingUi.set(reqId, {
			request: fullRequest,
			settle,
			recipients,
			retainOnReconnect: options?.retainOnReconnect,
		});
		if (recipients.size === 0) settle({ kind: "unavailable" });
		return promise;
	}

	/**
	 * Tell every writable guest except `exceptPeer` that someone else answered
	 * the dialog they just lost. The collab protocol's `ui-request-end` carries
	 * no reason and the guest SDK renders only `error` frames, so the frame
	 * text is the user-facing message itself.
	 */
	announceDialogAnswered(by: string, exceptPeer?: number): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite && peerId !== exceptPeer) {
				socket.send({ t: "error", message: `Question answered by ${by}` }, peerId);
			}
		}
	}

	#hasWritablePeers(): boolean {
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) return true;
		}
		return false;
	}

	/** @returns the writable peers the queue admitted the frame for. */
	#sendWritablePeers(frame: CollabFrame): number[] {
		const socket = this.#socket;
		if (!socket) return [];
		const admitted: number[] = [];
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite && socket.send(frame, peerId)) admitted.push(peerId);
		}
		return admitted;
	}

	/**
	 * Dismiss a settled request on every writer. A holder the queue refused for
	 * capacity alone would keep the dialog open with nothing left to close it, so
	 * the end then falls back to a broadcast; guests ignore an end for a request
	 * they never held. A holder that left or was shed needs none: its rejoin
	 * clears every dialog.
	 */
	#endUiRequest(reqId: number, recipients: ReadonlySet<number>): void {
		const socket = this.#socket;
		if (!socket) return;
		const frame: CollabFrame = { t: "ui-request-end", reqId };
		const admitted = new Set(this.#sendWritablePeers(frame));
		for (const peerId of recipients) {
			if (admitted.has(peerId) || !this.#peers.get(peerId)?.canWrite) continue;
			if (!socket.isAdmitting(peerId)) continue;
			socket.send(frame);
			return;
		}
	}

	/**
	 * Drop {@link peer} from every pending request once it can no longer answer
	 * (departure, shed, or a hello without the write token). A request left with
	 * no holder settles `unavailable`, so the caller re-routes to the web dialog
	 * or ends it; a shed guest that rejoins is not handed it again.
	 */
	#dropAskRecipient(peer: number): void {
		for (const pending of [...this.#pendingUi.values()]) {
			if (!pending.recipients.delete(peer) || pending.recipients.size > 0) continue;
			pending.settle({ kind: "unavailable" });
		}
	}

	/** Generates room+key+token, connects to the relay; resolves once the socket first opens. Throws on connect failure. */
	async start(relayUrl: string, access: CollabAccess = "control"): Promise<void> {
		const rawKey = generateRoomKey();
		const writeToken = access === "control" ? generateWriteToken() : null;
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#access = access;
		this.#relayUrl = relayUrl;
		this.#roomId = roomId;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken ?? undefined);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		const webUrl = this.#opts.webUrl;
		this.#browserLink = webUrl
			? formatCollabWebLink(relayUrl, roomId, rawKey, writeToken ?? undefined, webUrl)
			: undefined;
		this.#browserViewLink = webUrl
			? formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl)
			: undefined;
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(rawKey);

		// The host dials the relay the operator configured (or the ShareSheet chose).
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key });
		this.#socket = socket;
		this.#sessionId = this.#port.getSessionId();

		const firstOpen = Promise.withResolvers<void>();
		let opened = false;
		socket.onOpen = () => {
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onRoomRecreated = () => this.#handleRoomRecreated();
		socket.onPeerOverload = (peer) => this.#handlePeerOverload(peer);
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = (msg) => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				// Transient relay drop: CollabSocket retries with backoff; keep
				// the taps and status as-is (no TUI status line to update).
				console.debug(`collab host relay connection lost (${reason}), reconnecting…`);
			} else {
				void this.#teardown();
				this.#port.emitNotice("warning", `Collab ended: ${reason}`, "collab");
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}

		this.#unsubscribe = this.#port.subscribe((event) => {
			if (event.type === "message_start") this.#messageSeq++;
			if (isWireAgentEvent(event)) {
				const frame: CollabFrame = { t: "event", event: serializeReplicatedEvent(event).value };
				// A notice carries no replica state, so the queue drops it under pressure
				// instead of shedding a guest. Each update carries the whole message so
				// far, so a newer one supersedes any still queued for the same message;
				// keyed per message so one message's last update is never superseded by
				// the next one's.
				if (event.type === "notice") this.#broadcastAdvisory(frame);
				else
					this.#broadcast(
						frame,
						event.type === "message_update" ? `message_update:${this.#messageSeq}` : undefined,
					);
			}
			this.#onEventForState(event);
		});
		// Port contract: one subscribeBus call covers BOTH task channels
		// (lifecycle + progress); subscribing per channel would broadcast
		// every bus frame to each guest twice.
		this.#busUnsubscribers.push(
			this.#port.subscribeBus((ch, data) => this.#broadcast({ t: "bus", channel: ch, data })),
		);
		this.#agentsUnsubscribe = this.#port.subscribeAgents(() => this.#scheduleAgentsBroadcast());
		this.#port.onEntryAppended((entry) => {
			if (isWireSessionEntry(entry))
				this.#broadcast({ t: "entry", entry: serializeReplicatedEntry(entry).value });
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		});
		this.#live = true;
		this.#opts.onStatusChange?.(this.status);
	}

	/** Sends {t:"bye",reason} then tears down (unsubscribe, clear taps/timers, settle pending ui, close socket, status → null). */
	async stop(reason: string): Promise<void> {
		if (this.#stopped || this.#stopping) return;
		this.#stopping = true;
		const socket = this.#socket;
		socket?.send({ t: "bye", reason });
		// teardown's socket.close() drops seals still pending on the async chain,
		// and a dropped bye leaves the guest to the relay's orphan TTL (60s). Wait
		// until the bye is sealed; close() then writes the prepared envelope ahead
		// of the close frame.
		await socket?.flush();
		await this.#teardown();
	}

	async #teardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#live = false;
		this.#restoreEntryAppendedSlot();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#agentsUnsubscribe?.();
		this.#agentsUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		this.#unnotified.clear();
		clearTimeout(this.#resyncRetry ?? undefined);
		this.#resyncRetry = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#peers.clear();
		this.#socket?.close();
		this.#socket = null;
		this.#opts.onStatusChange?.(null);
	}

	/**
	 * Restore (clear) the port's single onEntryAppended slot. The previous
	 * handler is not readable through the port API; every real wiring
	 * (index.ts, tests) leaves the slot empty, so clearing it equals restoring
	 * it, the adapter's equivalent of CollabHost's
	 * `sessionManager.onEntryAppended = undefined`. A port implementation that
	 * must preserve a handler of its own does the save/restore inside
	 * `onEntryAppended` per the interface contract.
	 */
	#restoreEntryAppendedSlot(): void {
		(this.#port as CollabSessionPort & { onEntryAppended(cb: null): void }).onEntryAppended(null);
	}

	/**
	 * Whether this room may still serve guests: it is not ending and the session
	 * it mirrors is still the active one. A session that moved on ends the room,
	 * once, so no guest frame or broadcast ever reaches a session this room never
	 * shared.
	 */
	#admitGuestTraffic(): boolean {
		if (this.#stopped || this.#stopping || !this.#socket) return false;
		if (this.#port.getSessionId() === this.#sessionId) return true;
		void this.stop("session switched");
		this.#port.emitNotice("warning", "Collab ended: session switched", "collab");
		return false;
	}

	/** `latestKey` queues the frame as the newest state under that key, replacing any still-queued older one. */
	#broadcast(frame: CollabFrame, latestKey?: string): void {
		if (!this.#admitGuestTraffic()) return;
		if (latestKey === undefined) this.#socket?.send(frame);
		else this.#socket?.sendLatest(latestKey, frame);
	}

	/**
	 * Broadcast a frame that carries no replica state (`state`, `agents`, notice
	 * events): the queue drops it under pressure instead of shedding a guest.
	 * @returns whether the queue admitted it.
	 */
	#broadcastAdvisory(frame: CollabFrame): boolean {
		if (!this.#admitGuestTraffic()) return false;
		return this.#socket?.broadcastAdvisory(frame) ?? false;
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		// Inbound frames act on the mirrored session (join snapshots, prompts,
		// aborts, agent control); none may reach a session this room never shared.
		if (!this.#admitGuestTraffic()) return;
		// Controls are dispatched while frames still decrypt, so a hello can land
		// after its sender's `peer-left`; acting on it would register a ghost.
		if (!this.#socket?.isServing(fromPeer)) return;
		// Served by the relay but not registered here: shed, its welcome was
		// refused, or its id predates a recreated room. Its frames would otherwise
		// be judged as a read-only peer's; tell it to rejoin instead.
		if (frame.t !== "hello" && !this.#peers.has(fromPeer)) {
			this.#sendResync(fromPeer);
			return;
		}
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
				break;
			case "prompt":
				this.#handlePrompt(frame.text, frame.images, fromPeer);
				break;
			case "abort":
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "ui-response":
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			default:
				console.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#socket?.send(
			{ t: "error", message: `${action} is disabled on a read-only link` },
			fromPeer,
		);
	}

	#handleHello(
		name: string,
		proto: number,
		writeToken: string | undefined,
		fromPeer: number,
	): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{
					t: "error",
					message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}`,
				},
				fromPeer,
			);
			return;
		}
		// A repeat hello from a joined peer is a rejoin (an SDK guest re-sends it
		// after a `resync` error or a welcome/snapshot timeout): it gets a fresh
		// welcome and snapshot like a first join.
		const registered = this.#peers.get(fromPeer);
		const cleanName = this.#uniqueGuestName(
			name.trim().slice(0, 64) || `guest-${fromPeer}`,
			fromPeer,
		);
		const canWrite = this.#verifyWriteToken(writeToken);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		const socket = this.#socket;
		if (!socket) return;
		// Snapshot and queue synchronously: live traffic queued after this cannot
		// overtake the snapshot, so the guest can't observe a gap between the
		// snapshot fragment and live traffic.
		const snapshot = this.#port.snapshot();
		const entries = snapshot.entries.filter(isWireSessionEntry);
		const entryJsons = this.#serializeJoinEntries(entries);
		const entryBytes = entryJsons.map((json) => Buffer.byteLength(json));
		const welcome = encodeFrame({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: snapshot.header,
			state: this.#buildState(),
			agents: this.#snapshotAgents(),
			entryCount: entries.length,
			readOnly: canWrite ? undefined : true,
		});
		// Welcome, chunks and replayed requests are one queue entry, so a session
		// larger than the guest's share of the send queue can still be joined.
		const replayed = canWrite ? [...this.#pendingUi.values()] : [];
		const asks = replayed.map((pending) =>
			encodeFrame({ t: "ui-request", request: pending.request }),
		);
		let retainedBytes = Buffer.byteLength(welcome);
		for (const bytes of entryBytes) retainedBytes += bytes;
		for (const ask of asks) retainedBytes += Buffer.byteLength(ask);
		const batch = this.#welcomeBatch(welcome, entryJsons, entryBytes, asks);
		if (!socket.sendBatch(batch, fromPeer, retainedBytes)) {
			// The guest applies nothing before a welcome, so record nothing for it either.
			if (registered) this.#peers.set(fromPeer, registered);
			else this.#peers.delete(fromPeer);
			console.debug("collab welcome batch was not admitted; peer left unregistered", { fromPeer });
			return;
		}
		if (canWrite) {
			for (const pending of replayed) pending.recipients.add(fromPeer);
		} else {
			// A hello without the write token demotes the peer; it can no longer answer.
			this.#dropAskRecipient(fromPeer);
		}
		this.#port.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#opts.onStatusChange?.(this.status);
		this.#scheduleStateBroadcast();
	}

	/**
	 * Serialize the join snapshot's entries once, each through
	 * {@link serializeReplicatedEntry} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength`. The shrunk JSON is the size the join is measured
	 * against. Past {@link WELCOME_IMAGE_STRIP_THRESHOLD}, images are stripped
	 * from the (already copied) entries and the entries are serialized again.
	 */
	#serializeJoinEntries(entries: (SessionEntry & WireSessionEntry)[]): string[] {
		const first = entries.map((entry) => serializeReplicatedEntry(entry).json);
		const totalLength = first.reduce((sum, json) => sum + json.length, 0);
		if (totalLength <= WELCOME_IMAGE_STRIP_THRESHOLD) return first;
		let stripped = 0;
		const restripped = entries.map((entry) => {
			if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			return serializeReplicatedEntry(entry).json;
		});
		console.info("collab welcome exceeded size threshold; stripped images", { stripped });
		return restripped;
	}

	/** The welcome, its snapshot chunks, then the replayed requests, as one lazily drained batch. */
	*#welcomeBatch(
		welcome: EncodedFrame,
		entryJsons: string[],
		entryBytes: number[],
		asks: readonly EncodedFrame[],
	): Generator<EncodedFrame> {
		yield welcome;
		yield* this.#snapshotChunks(entryJsons, entryBytes);
		yield* asks;
	}

	/**
	 * Slice pre-serialized join entries into byte-bounded `snapshot-chunk` frames.
	 * Every batch carries at least one entry, and the last batch is tagged
	 * `final: true` so the guest can finalize the replica. An empty snapshot
	 * still emits one `final` chunk so the guest never blocks on a missing
	 * terminator. Each batch's strings are released once its frame is built.
	 */
	*#snapshotChunks(entryJsons: string[], entryBytes: number[]): Generator<EncodedFrame> {
		if (entryJsons.length === 0) {
			yield encodeSnapshotChunk([], true);
			return;
		}
		let i = 0;
		while (i < entryJsons.length) {
			const start = i;
			let batchBytes = 0;
			while (i < entryJsons.length) {
				const bytes = entryBytes[i] ?? 0;
				if (i > start && batchBytes + bytes > SNAPSHOT_CHUNK_BYTES) break;
				batchBytes += bytes;
				i++;
			}
			const batch = entryJsons.slice(start, i);
			entryJsons.fill("", start, i);
			yield encodeSnapshotChunk(batch, i >= entryJsons.length);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		const pending = this.#pendingUi.get(reqId);
		if (pending) {
			// Only a peer the request was admitted for holds its dialog.
			if (!pending.recipients.has(fromPeer)) return;
			pending.settle({ kind: "answered", value, by: peer.name, peer: fromPeer });
			return;
		}
		// Already settled (or never existed): a writer that rejoined after the
		// broadcast `ui-request-end` resends its answer and would otherwise wait
		// forever, so end its dialog directly.
		this.#socket?.send({ t: "ui-request-end", reqId }, fromPeer);
	}

	#handlePrompt(text: string, images: ImageContent[] | undefined, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		this.#port.promptFromGuest(text, images, peer.name).catch((err) => {
			console.warn("collab guest prompt failed", { error: String(err) });
			this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
		});
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#port
			.abort()
			.then(() => this.#port.emitNotice("info", `${name} interrupted`, "collab"))
			.catch((err) => console.warn("collab guest abort failed", { error: String(err) }));
	}

	/**
	 * The relay recreated the room and reissues peer ids from 1, so every id in
	 * {@link #peers} is meaningless, and `#peers` is the permission registry: left
	 * populated, whoever takes a reissued id would inherit the `canWrite` of the
	 * guest that held it. Runs before the socket reports the open. Requests marked
	 * `retainOnReconnect` stay pending and are replayed to a writer that says
	 * hello again; the rest settle unavailable.
	 */
	#handleRoomRecreated(): void {
		if (this.#stopped) return;
		this.#unnotified.clear();
		if (this.#peers.size === 0 && this.#pendingUi.size === 0) return;
		// Identities first: settle() fans `ui-request-end` out over #peers, and those
		// ids belong to the room that just went away.
		this.#peers.clear();
		for (const pending of [...this.#pendingUi.values()]) {
			// Old-room ids may be reissued; only a writer that says hello again holds it.
			pending.recipients.clear();
			if (!pending.retainOnReconnect) pending.settle({ kind: "unavailable" });
		}
		this.#opts.onStatusChange?.(this.status);
		this.#scheduleStateBroadcast();
	}

	#handlePeerLeft(peer: number): void {
		const left = this.#peers.get(peer);
		this.#peers.delete(peer);
		// A request the leaver alone held settles unavailable, so the caller
		// re-routes to the web dialog or ends it. A reader leaving changes nothing:
		// it never held a dialog, and a request retained across a reconnect waits
		// for its writer to come back.
		this.#dropAskRecipient(peer);
		// Relay controls arrive outside the normal frame handler.
		if (!this.#admitGuestTraffic()) return;
		if (left) this.#port.emitNotice("info", `${left.name} left the collab session`, "collab");
		this.#opts.onStatusChange?.(this.status);
		this.#scheduleStateBroadcast();
	}

	/**
	 * The socket discarded this peer's backlog to keep the room alive (its share
	 * of the send queue ran out): drop it from the participants and the requests
	 * it held, and tell it to rejoin.
	 */
	#handlePeerOverload(peer: number): void {
		if (this.#stopped) return;
		const shed = this.#peers.get(peer);
		this.#peers.delete(peer);
		this.#dropAskRecipient(peer);
		if (!this.#admitGuestTraffic()) return;
		if (!this.#sendResync(peer)) {
			this.#unnotified.add(peer);
			this.#scheduleResyncRetry();
		}
		if (shed) {
			this.#port.emitNotice(
				"warning",
				`${shed.name} fell too far behind and was dropped; they can rejoin`,
				"collab",
			);
		}
		this.#opts.onStatusChange?.(this.status);
		this.#scheduleStateBroadcast();
	}

	/** @returns whether the queue admitted the resync error. */
	#sendResync(peer: number): boolean {
		if (this.#stopping || this.#stopped) return false;
		return this.#socket?.send({ t: "error", message: RESYNC_MESSAGE, resync: true }, peer) ?? false;
	}

	/**
	 * A guest that was live when shed has no welcome or snapshot timer running, so
	 * a refused resync error would leave it frozen. Retry until one is admitted,
	 * the peer leaves, or it says hello again.
	 */
	#scheduleResyncRetry(): void {
		if (this.#resyncRetry || this.#unnotified.size === 0) return;
		this.#resyncRetry = setTimeout(() => {
			this.#resyncRetry = null;
			if (this.#stopped) return;
			for (const peer of this.#unnotified) {
				if (!this.#socket?.isServing(peer) || this.#peers.has(peer) || this.#sendResync(peer)) {
					this.#unnotified.delete(peer);
				}
			}
			this.#scheduleResyncRetry();
		}, RESYNC_RETRY_MS);
	}

	#buildState(): CollabSessionState {
		return {
			isStreaming: this.#port.isStreaming(),
			isAborting: this.#port.isAborting(),
			queuedMessageCount: this.#port.queuedMessageCount(),
			sessionName: this.#port.getSessionName(),
			cwd: this.#port.getCwd(),
			model: this.#port.getModel(),
			thinkingLevel: this.#port.getThinkingLevel(),
			// The wire shape (SessionState.contextUsage) allows nulls; the local
			// CollabSessionState intersection narrows to non-null numbers, so the
			// contract's null fallback needs a cast to the session-side type.
			contextUsage: (this.#port.getContextUsage() ?? {
				tokens: null,
				contextWindow: null,
				percent: null,
			}) as CollabSessionState["contextUsage"],
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(
				() => this.#scheduleStateBroadcast(),
				STREAMING_STATE_INTERVAL_MS,
			);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return this.#port
			.listAgents()
			.filter(
				(ref): ref is CollabAgentRef & { kind: "main" | "sub" } =>
					ref.kind === "main" || ref.kind === "sub",
			)
			.map((ref) => ({
				id: ref.id,
				displayName: ref.displayName,
				kind: ref.kind,
				parentId: ref.parentId,
				status: ref.status,
				hasSessionFile: ref.hasSessionFile,
				createdAt: ref.createdAt,
				lastActivity: ref.lastActivity,
			}));
	}

	#scheduleAgentsBroadcast(): void {
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			// Advisory: dropped under queue pressure, so retry until admitted.
			const sent = this.#broadcastAdvisory({ t: "agents", agents: this.#snapshotAgents() });
			if (!sent && !this.#stopping) this.#scheduleAgentsBroadcast();
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(
		cmd: "chat" | "kill" | "revive",
		agentId: string,
		text: string | undefined,
		fromPeer: number,
	): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from port snapshots (CollabAgentRef.kind has
		// no `advisor`), but reject control by id defensively, mirroring
		// CollabHost's guard: a stale/malicious client must never chat/kill/
		// revive a read-only advisor transcript.
		const ref = this.#port.listAgents().find((a) => a.id === agentId);
		if (ref && ref.kind !== "main" && ref.kind !== "sub") {
			this.#socket?.send(
				{ t: "error", message: `${agentId}: advisor transcripts are read-only` },
				fromPeer,
			);
			return;
		}
		this.#port.agentCmd(cmd, agentId, text).catch((err) => {
			console.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#socket?.send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		});
	}

	/** Incremental transcript read mirroring CollabHost's readFileIncremental contract. */
	async #handleFetchTranscript(
		reqId: number,
		agentId: string,
		fromByte: number,
		fromPeer: number,
	): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		const file = this.#port.resolveTranscriptFile(agentId);
		if (!file) {
			reply("", fromByte, "no transcript available");
			return;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			console.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			// Advisory: a state the queue dropped stays undelivered, so the next
			// trigger sends it instead of deduping against it.
			if (this.#broadcastAdvisory({ t: "state", state })) this.#lastStateJson = json;
		}, STATE_DEBOUNCE_MS);
	}
}
