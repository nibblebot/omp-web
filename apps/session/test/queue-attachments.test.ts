/**
 * Queue attachments (jx0b, hs2p): a queued slash command or busy-rejected prompt
 * keeps its images through the busy fallback, Stop's pause, Resume queue, run
 * now and the drain, and reaches the SDK prompt with the command. An image over
 * the existing per-image limit is refused with a notice, never queued or dropped.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { MAX_IMAGE_BYTES } from "#lib/wire/image-limits";
import type { QueuedMessagesSnapshot, ServerFrame } from "#lib/wire/protocol";
import { createCollabSession } from "../collab-session";
import type { SessionEntry } from "../session-entry";
import { setOnFrameTap } from "../client-delivery";

// The SDK goal controller needs a real AgentSession. The abort row reaches it through the
// autonomy adapter, so it is replaced here. The dynamic import must follow the mock.
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
const { createWebMethods } = await import("../methods");

const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
const image2 = { type: "image", data: "BBBB", mimeType: "image/jpeg" } as const;
/** Base64 text whose decoded size is just over the per-image limit. */
const oversized = {
	type: "image",
	data: "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8),
	mimeType: "image/png",
} as const;

const frames: ServerFrame[] = [];
setOnFrameTap((frame) => frames.push(frame as ServerFrame));
afterEach(() => {
	frames.length = 0;
});

/** Error texts broadcast so far. */
const errors = (): string[] => frames.flatMap((f) => (f.type === "error" ? [f.error] : []));

/** A session whose prompt records its calls; `busy` refuses prompts like a streaming turn. */
function fakeSession(
	options: {
		busy?: boolean;
		agent?: object;
		queued?: { steering: string[]; followUp: string[]; liveSteered: number };
	} = {},
) {
	const prompts: Array<{ text: string; images: unknown }> = [];
	const state = { busy: options.busy ?? false };
	const session = {
		get isStreaming() {
			return state.busy;
		},
		subscribe: () => () => undefined,
		prompt: async (text: string, opts?: { images?: unknown }) => {
			prompts.push({ text, images: opts?.images });
			if (state.busy) throw new AgentBusyError();
		},
		clearQueue: () => ({ steering: [], followUp: [] }),
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => [],
			appendCustomEntry: () => {},
			flush: async () => {},
		},
		abort: async () => {},
		getQueuedMessages: () => options.queued ?? { steering: [], followUp: [], liveSteered: 0 },
		agent: options.agent ?? {
			peekLiveSteeredMessages: () => [],
			peekSteeringQueue: () => [],
			peekFollowUpQueue: () => [],
		},
	};
	return { session: session as unknown as AgentSession, prompts, state };
}

function entryWith(session: AgentSession): SessionEntry {
	return {
		handle: "s1",
		cwd: "/tmp",
		session,
		pausedQueue: [],
		queuedCommands: { commands: [], paused: false, draining: false },
		subagentSnapshots: new Map(),
	} as unknown as SessionEntry;
}

function collab() {
	return createCollabSession({
		config: { idleTimeoutMs: 0 } as never,
		agentDir: "",
		authStorage: {} as never,
		modelRegistry: {} as never,
		settings: {} as never,
		broker: {
			broadcastState: async () => {},
			broadcastAvailableCommands: async () => {},
		} as never,
	});
}

function methodsFor(deps = collab()) {
	return createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: deps,
		broker: { broadcastState: async () => {} } as never,
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
	}).methods;
}

describe("busy fallback keeps images", () => {
	test("a busy prompt with images queues its text and images together", async () => {
		const { session } = fakeSession({ busy: true });
		const entry = entryWith(session);
		await collab().fireAndForgetPrompt(entry, "/skill:probe look", [image] as never);
		expect(entry.queuedCommands.commands).toEqual([{ text: "/skill:probe look", images: [image] }]);
		expect(errors()).toEqual([]);
	});

	test("a busy prompt with an over-limit image is refused with a notice and not queued", async () => {
		const { session } = fakeSession({ busy: true });
		const entry = entryWith(session);
		await collab().fireAndForgetPrompt(entry, "/skill:probe", [oversized] as never);
		expect(entry.queuedCommands.commands).toEqual([]);
		expect(errors().join("\n")).toMatch(/too large/i);
	});
});

describe("queueCommand carries images", () => {
	test("stores the images with the command; the snapshot carries only counts", async () => {
		const { session } = fakeSession({ busy: true });
		const entry = entryWith(session);
		const methods = methodsFor();
		await methods.queueCommand!(entry, ["/skill:a", [image]]);
		await methods.queueCommand!(entry, ["/add-dir /tmp/x"]);
		const snapshot = (await methods.getQueuedMessages!(entry, [])) as QueuedMessagesSnapshot;
		expect(snapshot.commands).toEqual(["/skill:a", "/add-dir /tmp/x"]);
		expect(snapshot.commandImageCounts).toEqual([1, 0]);
		expect(entry.queuedCommands.commands[0]?.images).toEqual([image]);
		expect(JSON.stringify(snapshot)).not.toContain(image.data);
	});

	test("an over-limit image is refused with a clear error and nothing is queued", async () => {
		const { session } = fakeSession({ busy: true });
		const entry = entryWith(session);
		await expect(methodsFor().queueCommand!(entry, ["/skill:a", [oversized]])).rejects.toThrow(
			/too large/i,
		);
		expect(entry.queuedCommands.commands).toEqual([]);
	});
});

describe("queued images survive Stop, Resume, run now and the drain", () => {
	test("a command queued during a turn runs at turn end with its images", async () => {
		const fake = fakeSession({ busy: true });
		const entry = entryWith(fake.session);
		const deps = collab();
		await methodsFor(deps).queueCommand!(entry, ["/skill:probe describe", [image]]);
		expect(fake.prompts).toEqual([]);

		fake.state.busy = false;
		await deps.drainCommands(entry);
		expect(fake.prompts).toEqual([{ text: "/skill:probe describe", images: [image] }]);
		expect(entry.queuedCommands.commands).toEqual([]);
	});

	test("Stop pauses the command with its images; Resume queue sends them", async () => {
		const fake = fakeSession({ busy: true });
		const entry = entryWith(fake.session);
		const deps = collab();
		const methods = methodsFor(deps);
		await methods.abort!(entry, []);
		await methods.queueCommand!(entry, ["/skill:probe describe", [image, image2]]);
		const held = (await methods.getQueuedMessages!(entry, [])) as QueuedMessagesSnapshot;
		expect(held.commandsPaused).toBe(true);
		expect(held.commandImageCounts).toEqual([2]);
		expect(fake.prompts).toEqual([]);

		fake.state.busy = false;
		await methods.resumeQueue!(entry, []);
		expect(fake.prompts).toEqual([{ text: "/skill:probe describe", images: [image, image2] }]);
	});

	test("run now on a paused command sends it with its images and leaves the rest held", async () => {
		const fake = fakeSession();
		const entry = entryWith(fake.session);
		entry.queuedCommands.paused = true;
		entry.queuedCommands.commands.push(
			{ text: "/skill:one", images: [image] },
			{ text: "/skill:two", images: [image2] },
		);
		await methodsFor().runQueuedCommandNow!(entry, [{ index: 1, text: "/skill:two" }]);
		expect(fake.prompts).toEqual([{ text: "/skill:two", images: [image2] }]);
		expect(entry.queuedCommands.commands).toEqual([{ text: "/skill:one", images: [image] }]);
	});

	test("run now while the queue runs sends the command with its images first", async () => {
		const fake = fakeSession();
		const entry = entryWith(fake.session);
		entry.queuedCommands.commands.push(
			{ text: "/skill:one" },
			{ text: "/skill:two", images: [image2] },
		);
		await methodsFor().runQueuedCommandNow!(entry, [{ index: 1, text: "/skill:two" }]);
		expect(fake.prompts).toEqual([
			{ text: "/skill:two", images: [image2] },
			{ text: "/skill:one", images: undefined },
		]);
	});
});

describe("steer, follow-up and paused chips report image counts only", () => {
	const userMessage = (text: string, images: unknown[] = []) => ({
		role: "user",
		content: [{ type: "text", text }, ...images],
	});
	const agent = {
		peekLiveSteeredMessages: () => [],
		peekSteeringQueue: () => [userMessage("s1"), userMessage("s2", [image])],
		peekFollowUpQueue: () => [userMessage("f1", [image, image2])],
	};

	test("counts align with the chip texts and the snapshot holds no image bytes", async () => {
		const fake = fakeSession({
			agent,
			queued: { steering: ["s1", "s2"], followUp: ["f1"], liveSteered: 0 },
		});
		const entry = entryWith(fake.session);
		entry.pausedQueue.push({
			kind: "follow-up",
			message: { text: "held", images: [image2] },
		});
		entry.queuedCommands.commands.push({ text: "/skill:a", images: [image, image2] });
		const snapshot = (await methodsFor().getQueuedMessages!(entry, [])) as QueuedMessagesSnapshot;
		expect(snapshot.steeringImageCounts).toEqual([0, 1]);
		expect(snapshot.followUpImageCounts).toEqual([2]);
		expect(snapshot.commandImageCounts).toEqual([2]);
		expect(snapshot.paused).toEqual([{ kind: "follow-up", text: "held", imageCount: 1 }]);
		const wire = JSON.stringify(snapshot);
		expect(wire).not.toContain('"data"');
		expect(wire).not.toContain(image.data);
		expect(wire).not.toContain(image2.data);
		expect(wire).not.toContain('"images"');
	});

	test("take and pop hand the removed message back with its images", async () => {
		const fake = fakeSession({ agent });
		const session = fake.session as unknown as {
			takeQueuedMessage: (text: string, queue: string) => unknown;
			popLastQueuedMessage: () => unknown;
		};
		session.takeQueuedMessage = (text) => ({ text, images: [image] });
		session.popLastQueuedMessage = () => undefined;
		const entry = entryWith(fake.session);
		entry.pausedQueue.push(
			{ kind: "steer", message: { text: "held-steer", images: [image2] } },
			{ kind: "follow-up", message: { text: "held-follow", images: [image, image2] } },
		);
		const methods = methodsFor();
		expect(await methods.takeQueued!(entry, [{ kind: "follow-up", text: "f1" }])).toEqual({
			text: "f1",
			images: [image],
		});
		expect(
			await methods.takeQueued!(entry, [{ kind: "steer", text: "held-steer", paused: 0 }]),
		).toEqual({ text: "held-steer", images: [image2] });
		expect(await methods.popLastQueuedMessage!(entry, [])).toEqual({
			text: "held-follow",
			images: [image, image2],
		});
	});
});
