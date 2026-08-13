/**
 * Slice B tests: CollabHostAdapter against a minimal inline relay stub and a
 * FakePort. Guests are real CollabSocket clients driven with a REAL generated
 * link from the adapter (parseCollabLink + importRoomKey).
 *
 * The inline relay stub is intentionally self-contained (slices run in
 * parallel; Slice A's relay is not imported).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import type { BusChannel } from "@oh-my-pi/pi-wire";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import {
	COLLAB_PROTO,
	ENVELOPE_HEADER_LENGTH,
	type CollabFrame,
	type CollabSessionState,
	parseCollabLink,
	rewriteEnvelopePeer,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	TRANSCRIPT_READ_CAP,
	CollabHostAdapter,
	type CollabHostStatus,
	type CollabSessionPort,
} from "./collab-host";

// ═══════════════════════════════════════════════════════════════════════════
// Minimal inline relay stub
// ═══════════════════════════════════════════════════════════════════════════

interface StubSocketData {
	roomId: string;
	role: "host" | "guest";
	peerId?: number;
}

interface StubRoom {
	host: ServerWebSocket<StubSocketData> | null;
	guests: Map<number, ServerWebSocket<StubSocketData>>;
	nextPeerId: number;
	ttl: Timer | null;
}

interface StubRelay {
	server: Server<StubSocketData>;
	dispose(): void;
}

function createStubRelay(options: { maxGuests?: number; orphanTtlMs?: number } = {}): StubRelay {
	const maxGuests = options.maxGuests ?? 64;
	const orphanTtlMs = options.orphanTtlMs ?? 60_000;
	const rooms = new Map<string, StubRoom>();

	const safeSend = (ws: ServerWebSocket<StubSocketData> | null, data: string | Uint8Array): void => {
		if (!ws) return;
		try {
			ws.send(data);
		} catch {
			// socket already closing/closed
		}
	};

	const server = Bun.serve<StubSocketData>({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			const match = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname);
			if (!match) return new Response("not found", { status: 404 });
			const role = url.searchParams.get("role");
			if (role !== "host" && role !== "guest") return new Response("bad role", { status: 400 });
			const upgraded = srv.upgrade(req, { data: { roomId: match[1]!, role } });
			return upgraded ? undefined : new Response("upgrade failed", { status: 500 });
		},
		websocket: {
			open(ws) {
				const roomId = ws.data.roomId;
				let room = rooms.get(roomId);
				if (!room) {
					room = { host: null, guests: new Map(), nextPeerId: 1, ttl: null };
					rooms.set(roomId, room);
				}
				if (ws.data.role === "host") {
					if (room.host) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					room.host = ws;
					if (room.ttl) {
						clearTimeout(room.ttl);
						room.ttl = null;
					}
					return;
				}
				if (!room.host) {
					ws.close(4004, "no such room");
					return;
				}
				if (room.guests.size >= maxGuests) {
					ws.close(4029, "room is full");
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				safeSend(room.host, JSON.stringify({ t: "peer-joined", peer: peerId }));
			},
			message(ws, raw) {
				if (typeof raw === "string") return;
				const room = rooms.get(ws.data.roomId);
				if (!room || raw.byteLength < ENVELOPE_HEADER_LENGTH) return;
				const bytes = toStrictBytes(raw);
				if (ws.data.role === "guest") {
					const peerId = ws.data.peerId;
					if (peerId === undefined) return;
					rewriteEnvelopePeer(bytes, peerId);
					safeSend(room.host, bytes);
					return;
				}
				const target = new DataView(bytes.buffer, bytes.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
				if (target === 0) {
					for (const guest of room.guests.values()) safeSend(guest, bytes);
				} else {
					const guest = room.guests.get(target);
					if (guest) safeSend(guest, bytes);
				}
			},
			close(ws) {
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "guest") {
					const peerId = ws.data.peerId;
					if (peerId === undefined) return;
					room.guests.delete(peerId);
					safeSend(room.host, JSON.stringify({ t: "peer-left", peer: peerId }));
					return;
				}
				if (room.host !== ws) return;
				room.host = null;
				room.ttl = setTimeout(() => {
					const current = rooms.get(ws.data.roomId);
					if (!current) return;
					for (const guest of current.guests.values()) {
						try {
							guest.close(4001, "room closed");
						} catch {
							// already closing/closed
						}
					}
					rooms.delete(ws.data.roomId);
				}, orphanTtlMs);
			},
		},
	});

	return {
		server,
		dispose() {
			// clearTimeout is a no-op for undefined handles.
			for (const room of rooms.values()) clearTimeout(room.ttl ?? undefined);
			rooms.clear();
			server.stop(true);
		},
	};
}

/** Bun's ws.send accepts BufferSource; give it a strict ArrayBuffer-backed view (no copy). */
function toStrictBytes(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	return raw.buffer instanceof ArrayBuffer
		? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
		: new Uint8Array(raw);
}

// ═══════════════════════════════════════════════════════════════════════════
// FakePort
// ═══════════════════════════════════════════════════════════════════════════

const FAKE_HEADER: SessionHeader = {
	type: "session",
	id: "session-1",
	timestamp: "2026-08-06T00:00:00.000Z",
	cwd: "/fake/cwd",
};

function fakeEntry(id: string, thinkingLevel: string): SessionEntry {
	return { type: "thinking_level_change", id, parentId: null, timestamp: FAKE_HEADER.timestamp, thinkingLevel };
}

class FakePort implements CollabSessionPort {
	sessionId = "session-1";
	streaming = false;
	notices: { level: "info" | "warning" | "error"; message: string; source?: string }[] = [];
	prompts: { text: string; images: ImageContent[] | undefined; fromName: string }[] = [];
	agentCmds: { cmd: "chat" | "kill" | "revive"; agentId: string; text: string | undefined }[] = [];
	aborts = 0;
	transcriptFiles = new Map<string, string>();
	entryAppendedCb: ((entry: SessionEntry) => void) | null = null;
	#eventCbs = new Set<(event: AgentSessionEvent) => void>();
	#busCbs = new Set<(channel: BusChannel, data: unknown) => void>();

	getSessionId(): string {
		return this.sessionId;
	}

	getCwd(): string {
		return FAKE_HEADER.cwd;
	}

	getSessionName(): string | undefined {
		return "Fake Session";
	}

	isStreaming(): boolean {
		return this.streaming;
	}

	isAborting(): boolean {
		return false;
	}

	queuedMessageCount(): number {
		return 0;
	}

	getModel() {
		return undefined;
	}

	getThinkingLevel(): string | undefined {
		return undefined;
	}

	getContextUsage() {
		return undefined;
	}

	snapshot(): { header: SessionHeader; entries: SessionEntry[] } {
		return { header: FAKE_HEADER, entries: [fakeEntry("e1", "medium"), fakeEntry("e2", "high")] };
	}

	subscribe(cb: (event: AgentSessionEvent) => void): () => void {
		this.#eventCbs.add(cb);
		return () => this.#eventCbs.delete(cb);
	}

	onEntryAppended(cb: (entry: SessionEntry) => void): void {
		this.entryAppendedCb = cb;
	}

	subscribeBus(cb: (channel: BusChannel, data: unknown) => void): () => void {
		this.#busCbs.add(cb);
		return () => this.#busCbs.delete(cb);
	}

	subscribeAgents(): () => void {
		return () => {};
	}

	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.notices.push({ level, message, source });
	}

	async promptFromGuest(text: string, images: ImageContent[] | undefined, fromName: string): Promise<void> {
		this.prompts.push({ text, images, fromName });
	}

	async abort(): Promise<void> {
		this.aborts++;
	}

	listAgents() {
		return [
			{
				id: "main",
				kind: "main" as const,
				displayName: "Main",
				status: "idle" as const,
				hasSessionFile: false,
				createdAt: 0,
				lastActivity: 0,
			},
			{
				id: "sub-1",
				kind: "sub" as const,
				displayName: "Sub One",
				status: "running" as const,
				parentId: "tool-1",
				hasSessionFile: false,
				createdAt: 0,
				lastActivity: 0,
			},
		];
	}

	async agentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined): Promise<void> {
		this.agentCmds.push({ cmd, agentId, text });
	}

	resolveTranscriptFile(agentId: string): string | null {
		return this.transcriptFiles.get(agentId) ?? null;
	}

	/** Test hook: push an event through the subscribed taps. */
	emitEvent(event: AgentSessionEvent): void {
		for (const cb of this.#eventCbs) cb(event);
	}

	/**
	 * Test hook: emit on a task channel. Mirrors the real port contract
	 * (server/index.ts): a single subscribeBus call delivers BOTH task
	 * channels, so every registered callback sees every channel.
	 */
	emitBus(channel: BusChannel, data: unknown): void {
		for (const cb of this.#busCbs) cb(channel, data);
	}

	/** Test hook: fire the registered onEntryAppended slot. */
	fireEntryAppended(entry: SessionEntry): void {
		this.entryAppendedCb?.(entry);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

// Integration-style wait: real WebSocket I/O cannot be driven by fake timers,
// so poll for the observed condition (a frame arriving) instead of sleeping a
// fixed duration. The probe is re-evaluated every 10 ms until it yields or the
// deadline passes.
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error("waitFor timed out");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 10);
		await promise;
	}
}

function parseLink(link: string) {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

async function connectGuest(link: string, name: string): Promise<{ frames: CollabFrame[]; socket: CollabSocket }> {
	const parsed = parseLink(link);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const frames: CollabFrame[] = [];
	socket.onFrame = frame => {
		frames.push(frame);
	};
	socket.onOpen = () => {
		socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name,
			writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
		});
	};
	socket.connect();
	return { frames, socket };
}

async function waitForWelcome(guest: { frames: CollabFrame[] }) {
	const welcome = await waitFor(() => guest.frames.find(f => f.t === "welcome"));
	if (welcome.t !== "welcome") throw new Error("expected welcome frame");
	return welcome;
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite
// ═══════════════════════════════════════════════════════════════════════════

describe("CollabHostAdapter", () => {
	let relay: StubRelay;
	let port: FakePort;
	let adapter: CollabHostAdapter;
	let statuses: (CollabHostStatus | null)[];
	const guestSockets: CollabSocket[] = [];

	beforeEach(async () => {
		relay = createStubRelay();
		port = new FakePort();
		statuses = [];
		adapter = new CollabHostAdapter(port, {
			hostName: "TestHost",
			onStatusChange: status => statuses.push(status),
		});
		await adapter.start(`ws://127.0.0.1:${relay.server.port}`);
	});

	afterEach(async () => {
		await adapter.stop("test teardown");
		for (const socket of guestSockets) socket.close();
		guestSockets.length = 0;
		relay.dispose();
	});

	test("start → live status with parseable links and host-only participants", () => {
		expect(adapter.isLive).toBe(true);
		const status = adapter.status;
		expect(status).not.toBeNull();
		if (!status) throw new Error("status null after start");
		expect(status.state).toBe("live");
		expect(status.relayUrl).toBe(`ws://127.0.0.1:${relay.server.port}`);
		expect(status.roomId).toMatch(/^[A-Za-z0-9_-]{10,64}$/);

		const parsed = parseLink(status.link);
		expect(parsed.roomId).toBe(status.roomId);
		expect(parsed.writeToken).toBeDefined();

		const view = parseLink(status.viewLink);
		expect(view.roomId).toBe(status.roomId);
		expect(view.writeToken).toBeUndefined();

		expect(status.participants).toEqual([{ name: "TestHost", role: "host" }]);
		expect(statuses.at(-1)).toEqual(status);
		expect(adapter.participantCount).toBe(1);
		expect(adapter.writableGuestCount).toBe(0);
	});

	test("guest hello → welcome (proto 3, entryCount 2) + snapshot chunks ending final:true", async () => {
		const guest = await connectGuest(adapter.status!.link, "Alice");
		guestSockets.push(guest.socket);

		const welcome = await waitForWelcome(guest);
		expect(welcome.proto).toBe(COLLAB_PROTO);
		expect(welcome.entryCount).toBe(2);
		expect(welcome.readOnly).toBeUndefined();
		expect(welcome.state.participants).toEqual([
			{ name: "TestHost", role: "host" },
			{ name: "Alice", role: "guest" },
		]);
		expect(welcome.agents.map(a => a.kind)).toEqual(["main", "sub"]);

		const chunks = await waitFor(() => {
			const all = guest.frames.filter(f => f.t === "snapshot-chunk");
			return all.length > 0 && all.at(-1)!.final ? all : undefined;
		});
		expect(chunks.at(-1)!.final).toBe(true);
		const entries = chunks.flatMap(c => (c.t === "snapshot-chunk" ? c.entries : []));
		expect(entries.map(e => e.id)).toEqual(["e1", "e2"]);
		expect(entries.map(e => e.type)).toEqual(["thinking_level_change", "thinking_level_change"]);

		expect(port.notices.some(n => n.message.includes("Alice joined the collab session"))).toBe(true);
		expect(adapter.participantCount).toBe(2);
		expect(adapter.writableGuestCount).toBe(1);
		expect(adapter.status?.participants).toEqual([
			{ name: "TestHost", role: "host" },
			{ name: "Alice", role: "guest" },
		]);
	});

	test("guest prompt routes to port.promptFromGuest with (text, images, name)", async () => {
		const guest = await connectGuest(adapter.status!.link, "Bob");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		guest.socket.send({ t: "prompt", text: "hello from collab" });
		await waitFor(() => port.prompts[0]);
		expect(port.prompts[0]).toEqual({ text: "hello from collab", images: undefined, fromName: "Bob" });

		const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
		guest.socket.send({ t: "prompt", text: "with image", images: [image] });
		await waitFor(() => port.prompts[1]);
		expect(port.prompts[1]).toEqual({ text: "with image", images: [image], fromName: "Bob" });
	});

	test("view-link guest is read-only: welcome.readOnly + targeted prompt rejection", async () => {
		const guest = await connectGuest(adapter.status!.viewLink, "Viewer");
		guestSockets.push(guest.socket);

		const welcome = await waitForWelcome(guest);
		expect(welcome.readOnly).toBe(true);
		expect(port.notices.some(n => n.message.includes("Viewer joined the collab session (read-only)"))).toBe(true);
		expect(adapter.writableGuestCount).toBe(0);

		guest.socket.send({ t: "prompt", text: "nope" });
		const err = await waitFor(() => guest.frames.find(f => f.t === "error"));
		if (err.t !== "error") throw new Error("expected error frame");
		expect(err.message).toBe("prompting is disabled on a read-only link");
		expect(port.prompts).toHaveLength(0);

		// No writable peers → ui requests are declined up front.
		expect(adapter.requestGuestUi({ kind: "select", title: "t", options: ["x"] })).toBeNull();
	});

	test("AgentSessionEvent through port.subscribe reaches the guest as an event frame", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		port.emitEvent({ type: "notice", level: "info", message: "hi from the host" });
		const ev = await waitFor(() => guest.frames.find(f => f.t === "event"));
		if (ev.t !== "event") throw new Error("expected event frame");
		expect(ev.event.type).toBe("notice");
	});

	test("bus events: exactly one frame per guest per event, both task channels delivered", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		// Regression: start() used to subscribeBus once per channel while the
		// port contract delivers BOTH task channels per call, so every bus
		// frame was broadcast to each guest twice.
		const lifecycleData = { id: "sub-1", agent: "Sub One", status: "running" };
		port.emitBus(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycleData);
		// The progress event doubles as an ordering barrier: broadcast is a
		// FIFO send and the relay forwards per connection in order, so once
		// the progress frame arrives every lifecycle frame (duplicates from
		// the old bug included) has already reached the guest. No timers.
		const progressData = { index: 0, agent: "Sub One", status: "running" };
		port.emitBus(TASK_SUBAGENT_PROGRESS_CHANNEL, progressData);

		const progress = await waitFor(() =>
			guest.frames.find(f => f.t === "bus" && f.channel === TASK_SUBAGENT_PROGRESS_CHANNEL),
		);
		if (progress.t !== "bus") throw new Error("expected bus frame");
		expect(progress.data).toEqual(progressData);
		expect(
			guest.frames.filter(f => f.t === "bus" && f.channel === TASK_SUBAGENT_PROGRESS_CHANNEL),
		).toHaveLength(1);

		const lifecycle = guest.frames.find(
			f => f.t === "bus" && f.channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL,
		);
		if (!lifecycle || lifecycle.t !== "bus") throw new Error("expected lifecycle bus frame");
		expect(lifecycle.data).toEqual(lifecycleData);
		expect(
			guest.frames.filter(f => f.t === "bus" && f.channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL),
		).toHaveLength(1);
	});

	test("onEntryAppended fires → guest receives an entry frame", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		port.fireEntryAppended({
			type: "custom_message",
			id: "e3",
			parentId: null,
			timestamp: FAKE_HEADER.timestamp,
			customType: "test",
			content: "hello entry",
			display: true,
		});
		const entry = await waitFor(() => guest.frames.find(f => f.t === "entry"));
		if (entry.t !== "entry") throw new Error("expected entry frame");
		expect(entry.entry.type).toBe("custom_message");
		expect(entry.entry.id).toBe("e3");
	});

	test("agent_end event → debounced state frame including the guest participant", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		// The hello itself schedules a state broadcast; absorb it first.
		await waitFor(() => guest.frames.find(f => f.t === "state"));
		const stateCount = guest.frames.filter(f => f.t === "state").length;

		// Change port state so the agent_end broadcast is not JSON-deduped.
		port.streaming = true;
		port.emitEvent({ type: "agent_end", messages: [] });
		await waitFor(() => {
			const states = guest.frames.filter(f => f.t === "state");
			return states.length > stateCount ? states : undefined;
		});
		const state = guest.frames.filter(f => f.t === "state").at(-1);
		if (!state || state.t !== "state") throw new Error("expected state frame");
		expect(state.state.participants).toEqual([
			{ name: "TestHost", role: "host" },
			{ name: "Eve", role: "guest" },
		]);
		expect(state.state.isStreaming).toBe(true);
		expect(state.state.sessionName).toBe("Fake Session");
		expect(state.state.cwd).toBe("/fake/cwd");
	});

	test("requestGuestUi → ui-request to guest; ui-response settles; ui-request-end sent", async () => {
		const guest = await connectGuest(adapter.status!.link, "Uli");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		const promise = adapter.requestGuestUi({ kind: "select", title: "Pick", options: ["A", "B"] });
		expect(promise).not.toBeNull();
		const req = await waitFor(() => guest.frames.find(f => f.t === "ui-request"));
		if (req.t !== "ui-request") throw new Error("expected ui-request frame");
		expect(req.request.kind).toBe("select");
		expect(req.request.title).toBe("Pick");
		expect(typeof req.request.reqId).toBe("number");

		guest.socket.send({ t: "ui-response", reqId: req.request.reqId, value: "B" });
		const result = await promise!;
		expect(result).toEqual({ kind: "answered", value: "B" });
		await waitFor(() => guest.frames.find(f => f.t === "ui-request-end" && f.reqId === req.request.reqId));
	});

	test("stop sends bye then clears status", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		await adapter.stop("bye now");
		const bye = await waitFor(() => guest.frames.find(f => f.t === "bye"));
		if (bye.t !== "bye") throw new Error("expected bye frame");
		expect(bye.reason).toBe("bye now");

		expect(adapter.status).toBeNull();
		expect(adapter.isLive).toBe(false);
		expect(statuses.at(-1)).toBeNull();
		// Teardown cleared the single onEntryAppended slot.
		expect(port.entryAppendedCb).toBeNull();
	});

	test("session switched: changed sessionId stops the adapter with bye 'session switched'", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		port.sessionId = "session-2";
		// The next broadcast hits the session-switch guard.
		port.emitEvent({ type: "notice", level: "info", message: "nudge" });
		const bye = await waitFor(() => guest.frames.find(f => f.t === "bye"));
		if (bye.t !== "bye") throw new Error("expected bye frame");
		expect(bye.reason).toBe("session switched");
		expect(port.notices.some(n => n.message === "Collab ended: session switched" && n.level === "warning")).toBe(true);
		expect(adapter.status).toBeNull();
	});

	test("fetch-transcript: missing file, incremental read, trim-to-newline, and oversized entry", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		// Unknown agent → terminal "no transcript available".
		guest.socket.send({ t: "fetch-transcript", reqId: 1, agentId: "none", fromByte: 0 });
		const missing = await waitFor(() => guest.frames.find(f => f.t === "transcript" && f.reqId === 1));
		if (missing.t !== "transcript") throw new Error("expected transcript frame");
		expect(missing.error).toBe("no transcript available");
		expect(missing.newSize).toBe(0);

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-host-test-"));
		try {
			// Small file: full text, newSize = size; re-fetch at EOF returns empty.
			const small = path.join(dir, "small.jsonl");
			await fs.writeFile(small, "line1\nline2\n");
			port.transcriptFiles.set("main", small);
			guest.socket.send({ t: "fetch-transcript", reqId: 2, agentId: "main", fromByte: 0 });
			const full = await waitFor(() => guest.frames.find(f => f.t === "transcript" && f.reqId === 2));
			if (full.t !== "transcript") throw new Error("expected transcript frame");
			expect(full.text).toBe("line1\nline2\n");
			expect(full.newSize).toBe(12);
			expect(full.error).toBeUndefined();
			guest.socket.send({ t: "fetch-transcript", reqId: 3, agentId: "main", fromByte: 12 });
			const eof = await waitFor(() => guest.frames.find(f => f.t === "transcript" && f.reqId === 3));
			if (eof.t !== "transcript") throw new Error("expected transcript frame");
			expect(eof.text).toBe("");
			expect(eof.newSize).toBe(12);

			// File larger than the read cap with a complete first line: reply is
			// trimmed to the last newline and newSize advances by the trimmed bytes.
			const trimmed = path.join(dir, "trimmed.jsonl");
			await fs.writeFile(trimmed, `line1\n${"y".repeat(TRANSCRIPT_READ_CAP)}`);
			port.transcriptFiles.set("trim", trimmed);
			guest.socket.send({ t: "fetch-transcript", reqId: 4, agentId: "trim", fromByte: 0 });
			const tr = await waitFor(() => guest.frames.find(f => f.t === "transcript" && f.reqId === 4));
			if (tr.t !== "transcript") throw new Error("expected transcript frame");
			expect(tr.text).toBe("line1\n");
			expect(tr.newSize).toBe(6);
			expect(tr.error).toBeUndefined();

			// Single line larger than the cap with no newline in the read window:
			// terminal TRANSCRIPT_ENTRY_TOO_LARGE_ERROR.
			const huge = path.join(dir, "huge.jsonl");
			await fs.writeFile(huge, `${"x".repeat(TRANSCRIPT_READ_CAP + 100)}\n`);
			port.transcriptFiles.set("huge", huge);
			guest.socket.send({ t: "fetch-transcript", reqId: 5, agentId: "huge", fromByte: 0 });
			const over = await waitFor(() => guest.frames.find(f => f.t === "transcript" && f.reqId === 5));
			if (over.t !== "transcript") throw new Error("expected transcript frame");
			expect(over.error).toBe(`transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`);
			expect(over.text).toBe("");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("agent-cmd routes to the port; read-only peers are rejected", async () => {
		const guest = await connectGuest(adapter.status!.link, "Eve");
		guestSockets.push(guest.socket);
		await waitForWelcome(guest);

		guest.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "sub-1", text: "hello sub" });
		await waitFor(() => port.agentCmds[0]);
		expect(port.agentCmds[0]).toEqual({ cmd: "chat", agentId: "sub-1", text: "hello sub" });

		guest.socket.send({ t: "agent-cmd", cmd: "kill", agentId: "main" });
		await waitFor(() => port.agentCmds[1]);
		expect(port.agentCmds[1]).toEqual({ cmd: "kill", agentId: "main", text: undefined });

		const viewer = await connectGuest(adapter.status!.viewLink, "Viewer");
		guestSockets.push(viewer.socket);
		await waitForWelcome(viewer);
		viewer.socket.send({ t: "agent-cmd", cmd: "revive", agentId: "sub-1" });
		const err = await waitFor(() => viewer.frames.find(f => f.t === "error"));
		if (err.t !== "error") throw new Error("expected error frame");
		expect(err.message).toBe("agent control is disabled on a read-only link");
		expect(port.agentCmds).toHaveLength(2);
	});
});
