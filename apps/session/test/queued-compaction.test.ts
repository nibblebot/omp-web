/**
 * Queued compaction (SDK 18.14.1, "/compact sent with the follow-up key while the agent works runs when
 * it yields"): `queueCompaction` parks the request in the entry's command queue; it fires once the
 * run has yielded, through the same adapter as an idle `/compact`; follow-ups sent after it run after it;
 * removing it, Stop, a session change or a tree move before it fires means it never compacts.
 *
 * The session is a fake with a real in-memory SessionManager, so the conversation position and the
 * transcript resync are the SDK's own; the turn is driven by hand (`startTurn` / `endTurn`).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ServerFrame } from "#lib/wire/protocol";
import { setOnFrameTap, setOnHistoryTap } from "../client-delivery";
import { createCollabSession } from "../collab-session";
import type { WebMethods } from "../methods";
import type { SessionEntry } from "../session-entry";

// The abort row reaches the SDK goal controller, which needs a real AgentSession.
mock.module("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal", () => ({
	RpcGoalController: class {
		constructor(_session: unknown) {}
		async reconcile(): Promise<void> {}
		observe(): void {}
		stopForHostAbort(): void {}
		async beginSessionChange(): Promise<void> {}
		async endSessionChange(_options?: { detachedRun?: boolean }): Promise<void> {}
	},
}));
// Dynamic imports: they must follow the mock above, which a static import would hoist past.
const { createWebMethods } = await import("../methods");
const { dropHeldQueue } = await import("../queue-hold");

const frames: ServerFrame[] = [];
let resyncs = 0;
setOnFrameTap((frame) => frames.push(frame as ServerFrame));
setOnHistoryTap(async () => {
	resyncs += 1;
});
afterEach(() => {
	frames.length = 0;
	resyncs = 0;
});

const errors = (): string[] => frames.flatMap((f) => (f.type === "error" ? [f.error] : []));
const notices = (): string[] =>
	frames.flatMap((f) => (f.type === "event" && f.event.type === "notice" ? [f.event.message] : []));

/** The command drain has finished: nothing is waiting on the turn, a poll or a compaction. */
async function settled(h: Harness): Promise<void> {
	await until(() => !h.entry.queuedCommands.draining);
}

/** Waits for a condition the queue's own yield poll settles; bounded, never a guessed delay. */
async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
	if (!condition()) throw new Error(`condition not met; frames: ${JSON.stringify(frames)}`);
}

interface Harness {
	entry: SessionEntry;
	log: string[];
	compactCalls: Array<{ instructions: string | undefined; options: unknown }>;
	sessionManager: SessionManager;
	state: {
		streaming: boolean;
		pendingAsync: boolean;
		queued: number;
		polls: number;
		compactError?: Error;
	};
	startTurn(): void;
	endTurn(): void;
	methods: WebMethods["methods"];
}

function harness(): Harness {
	const sessionManager = SessionManager.inMemory("/tmp");
	sessionManager.appendMessage({ role: "user", content: "first question", timestamp: 1 });
	const state = {
		streaming: false,
		pendingAsync: false,
		queued: 0,
		/** How often the drain has looked at the background-work gate. */
		polls: 0,
		compactError: undefined as Error | undefined,
	};
	const log: string[] = [];
	const compactCalls: Harness["compactCalls"] = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let compacting = false;
	const session = {
		settings: Settings.isolated(),
		model: {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "m",
			input: ["text", "image"],
			compat: {},
		},
		sessionManager,
		get sessionId() {
			return sessionManager.getSessionId();
		},
		get isStreaming() {
			return state.streaming;
		},
		get isCompacting() {
			return compacting;
		},
		isRetrying: false,
		isSessionTransitioning: false,
		hasAdmittedSubmission: false,
		hasPostPromptWork: false,
		get queuedMessageCount() {
			return state.queued;
		},
		hasPendingAsyncWork: () => {
			state.polls += 1;
			return state.pendingAsync;
		},
		waitForIdle: async () => {
			while (state.streaming) await Bun.sleep(1);
		},
		waitForSessionTransition: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		compact: async (instructions: string | undefined, options: unknown) => {
			log.push("compact");
			compactCalls.push({ instructions, options });
			compacting = true;
			try {
				await Bun.sleep(5);
				if (state.compactError) throw state.compactError;
				const kept = sessionManager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
				sessionManager.appendCompaction("summary", undefined, kept, 1000);
				return { summary: "summary", firstKeptEntryId: kept, tokensBefore: 1000 };
			} finally {
				compacting = false;
			}
		},
		prompt: async (text: string) => {
			log.push(`prompt:${text}`);
			state.streaming = true;
		},
		followUp: async (text: string) => {
			log.push(`followUp:${text}`);
		},
		steer: async (text: string) => {
			log.push(`steer:${text}`);
		},
		clearQueue: () => ({ steering: [], followUp: [] }),
		abort: async () => {},
		getQueuedMessages: () => ({ steering: [], followUp: [], liveSteered: 0 }),
		buildTranscriptSessionContext: (options: object) =>
			sessionManager.buildSessionContext({ transcript: true, ...options }),
		agent: {
			peekLiveSteeredMessages: () => [],
			peekSteeringQueue: () => [],
			peekFollowUpQueue: () => [],
		},
	} as unknown as AgentSession;

	const collab = createCollabSession({
		config: { idleTimeoutMs: 0 } as never,
		agentDir: "",
		authStorage: {} as never,
		modelRegistry: {} as never,
		settings: {} as never,
		broker: { broadcastState: async () => {}, broadcastAvailableCommands: async () => {} } as never,
	});
	const entry = {
		handle: "s1",
		cwd: "/tmp",
		session,
		eventBus: { on: () => () => {} },
		pausedQueue: [],
		queuedCommands: { commands: [], paused: false, draining: false },
		subagentSnapshots: new Map(),
	} as unknown as SessionEntry;
	// The real event wiring: `agent_end` drains the command queue, as in production.
	collab.wireSession(entry);
	const { methods } = createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab,
		broker: { broadcastState: async () => {} } as never,
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
	});
	return {
		entry,
		log,
		compactCalls,
		sessionManager,
		state,
		startTurn: () => {
			state.streaming = true;
			for (const listener of listeners) listener({ type: "agent_start" } as AgentSessionEvent);
		},
		endTurn: () => {
			state.streaming = false;
			for (const listener of listeners)
				listener({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		},
		methods,
	};
}

describe("queueCompaction while a turn streams", () => {
	test("queues as a chip, then compacts when the turn yields with the same mode and focus", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [
			{ mode: "soft", instructions: "keep the auth work" },
		]);

		expect(h.compactCalls).toEqual([]);
		const snapshot = (await h.methods.getQueuedMessages!(h.entry, [])) as {
			commands: string[];
		};
		expect(snapshot.commands).toEqual(["/compact soft keep the auth work"]);

		h.endTurn();
		await until(() => h.compactCalls.length === 1);
		expect(h.compactCalls[0]).toEqual({
			instructions: "keep the auth work",
			options: { mode: "soft" },
		});
		await until(
			() => h.entry.queuedCommands.commands.length === 0 && !h.entry.queuedCommands.draining,
		);
		expect(resyncs).toBe(1);
		expect(errors()).toEqual([]);
	});

	test("a bare /compact keeps the configured method order (no mode)", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{}]);
		h.endTurn();
		await until(() => h.compactCalls.length === 1);
		expect(h.compactCalls[0]).toEqual({ instructions: undefined, options: {} });
	});

	test("holds the compaction until retries, queued input and background work have settled", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]);
		h.state.pendingAsync = true;
		h.state.queued = 1;
		h.endTurn();
		// The drain has looked at the gate repeatedly and held.
		await until(() => h.state.polls >= 3);
		expect(h.compactCalls).toEqual([]);

		h.state.pendingAsync = false;
		const seen = h.state.polls;
		await until(() => h.state.polls >= seen + 3);
		expect(h.compactCalls).toEqual([]);
		h.state.queued = 0;
		await until(() => h.compactCalls.length === 1);
	});

	test("follow-ups sent after it run after it, in order; steers are not held", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.followUp!(h.entry, ["before"]);
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]);
		await h.methods.followUp!(h.entry, ["after one"]);
		await h.methods.followUp!(h.entry, ["after two"]);
		await h.methods.steer!(h.entry, ["steer now"]);

		// The earlier follow-up and the steer joined the running turn; the later ones wait behind the compaction.
		expect(h.log).toEqual(["followUp:before", "steer:steer now"]);
		const snapshot = (await h.methods.getQueuedMessages!(h.entry, [])) as { commands: string[] };
		expect(snapshot.commands).toEqual(["/compact soft", "after one", "after two"]);

		h.log.length = 0;
		h.endTurn();
		await until(() => h.log.includes("prompt:after one"));
		expect(h.log).toEqual(["compact", "prompt:after one"]);
		// The first held message started a turn; the second waits for it to end.
		h.endTurn();
		await until(() => h.log.includes("prompt:after two"));
		expect(h.log).toEqual(["compact", "prompt:after one", "prompt:after two"]);
	});

	test("with no compaction queued, follow-ups reach the session as before", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.followUp!(h.entry, ["plain"]);
		expect(h.log).toEqual(["followUp:plain"]);
		expect(h.entry.queuedCommands.commands).toEqual([]);
	});

	test("removing it before the turn yields cancels it", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]);
		await h.methods.takeQueuedCommand!(h.entry, [{ index: 0, text: "/compact soft" }]);
		expect(h.entry.queuedCommands.commands).toEqual([]);

		h.endTurn();
		await settled(h);
		expect(h.compactCalls).toEqual([]);
	});

	test("clear all cancels it", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{}]);
		await h.methods.clearQueue!(h.entry, []);
		h.endTurn();
		await settled(h);
		expect(h.compactCalls).toEqual([]);
	});

	test("Stop pauses it; Resume queue then runs it", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]);
		await h.methods.abort!(h.entry, []);
		h.endTurn();
		await settled(h);
		expect(h.compactCalls).toEqual([]);
		expect(h.entry.queuedCommands.commands).toHaveLength(1);

		await h.methods.resumeQueue!(h.entry, []);
		await until(() => h.compactCalls.length === 1);
		expect(h.entry.queuedCommands.commands).toEqual([]);
	});

	test("a session change before it fires drops it", async () => {
		const h = harness();
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]);
		dropHeldQueue(h.entry);
		h.endTurn();
		await settled(h);
		expect(h.compactCalls).toEqual([]);
	});

	test("a tree move before it fires never compacts the other branch, and says so", async () => {
		const h = harness();
		const origin = h.sessionManager.getLeafId()!;
		h.sessionManager.appendMessage({ role: "user", content: "second question", timestamp: 2 });
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]);
		// The conversation is rewound to before the position the request was sent at.
		h.sessionManager.branch(origin);
		h.sessionManager.appendMessage({ role: "user", content: "other path", timestamp: 3 });
		h.sessionManager.branch(h.sessionManager.getEntries()[0]!.id);

		h.endTurn();
		await until(() => notices().length === 1);
		expect(h.compactCalls).toEqual([]);
		expect(notices()[0]).toContain("/compact soft dropped");
	});

	test("a failing compaction reports the error and the held follow-up still goes out", async () => {
		const h = harness();
		h.state.compactError = new Error("summarizer unavailable");
		h.startTurn();
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]);
		await h.methods.followUp!(h.entry, ["after"]);
		h.endTurn();
		await until(() => h.log.includes("prompt:after"));
		expect(errors().join("\n")).toContain("summarizer unavailable");
		expect(resyncs).toBe(0);
	});

	test("a malformed request is refused at once and queues nothing", async () => {
		const h = harness();
		h.startTurn();
		await expect(h.methods.queueCompaction!(h.entry, [{ mode: "bogus" }])).rejects.toThrow(
			'unsupported compaction mode "bogus"',
		);
		await expect(
			h.methods.queueCompaction!(h.entry, [{ mode: "snapcompact", instructions: "focus" }]),
		).rejects.toThrow("does not take focus instructions");
		expect(h.entry.queuedCommands.commands).toEqual([]);
	});
});

describe("queueCompaction while idle", () => {
	test("runs at once, like an idle /compact", async () => {
		const h = harness();
		await h.methods.queueCompaction!(h.entry, [{ mode: "soft", instructions: "focus" }]);
		await until(() => h.compactCalls.length === 1);
		expect(h.compactCalls[0]).toEqual({ instructions: "focus", options: { mode: "soft" } });
		expect(h.entry.queuedCommands.commands).toEqual([]);
	});

	test("the call does not wait out the compaction", async () => {
		const h = harness();
		let answered = false;
		const call = h.methods.queueCompaction!(h.entry, [{ mode: "soft" }]).then(() => {
			answered = true;
		});
		await call;
		expect(answered).toBe(true);
		expect(h.compactCalls.length).toBeLessThanOrEqual(1);
		await until(() => h.compactCalls.length === 1);
	});
});
