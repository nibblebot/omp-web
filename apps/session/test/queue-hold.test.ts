/**
 * Regression tests for Stop + queue (hs2p, CORE-01/CORE-02/CMD-20): a Stop
 * withdraws the queue into a paused hold instead of dropping it, chips remove
 * by identity, and "Resume queue" sends the held messages in order.
 */

import { describe, expect, test } from "bun:test";
import { createWebMethods } from "../methods";
import {
	type HeldQueuedMessage,
	holdQueuedMessages,
	type QueueHost,
	resumeHeldQueue,
	takeQueuedMessage,
} from "../queue-hold";
import type { SessionEntry } from "../session-entry";

interface FakeQueue {
	steering: string[];
	followUp: string[];
}

/** A queue host over plain string lists; `failOn` makes that send reject after recording it. */
function fakeHost(queue: FakeQueue, failOn?: string) {
	const sent: string[] = [];
	const host: QueueHost = {
		clearQueue: () => ({
			steering: queue.steering.splice(0).map((text) => ({ text })),
			followUp: queue.followUp.splice(0).map((text) => ({ text })),
		}),
		takeQueuedMessage: (text, which) => {
			const list = which === "steering" ? queue.steering : queue.followUp;
			const index = list.indexOf(text);
			if (index < 0) return undefined;
			list.splice(index, 1);
			return { text };
		},
		steer: async (text) => {
			sent.push(`steer:${text}`);
			if (text === failOn) throw new Error("send failed");
		},
		followUp: async (text) => {
			sent.push(`follow:${text}`);
			if (text === failOn) throw new Error("send failed");
		},
	};
	return { host, sent };
}

const texts = (held: HeldQueuedMessage[]) => held.map((h) => h.message.text);

describe("holdQueuedMessages", () => {
	test("withdraws the queue for an interrupt, steers first then follow-ups", () => {
		const queue: FakeQueue = { steering: ["s1"], followUp: ["f1", "f2"] };
		const seen: Array<{ forInterrupt: boolean }> = [];
		const host = {
			clearQueue: (options: { forInterrupt: boolean }) => {
				seen.push(options);
				return fakeHost(queue).host.clearQueue(options);
			},
		};
		const held: HeldQueuedMessage[] = [];
		holdQueuedMessages(host, held);
		expect(seen).toEqual([{ forInterrupt: true }]);
		expect(held.map((h) => [h.kind, h.message.text])).toEqual([
			["steer", "s1"],
			["follow-up", "f1"],
			["follow-up", "f2"],
		]);
	});
});

describe("resumeHeldQueue", () => {
	test("sends held messages in order and empties the hold", async () => {
		const { host, sent } = fakeHost({ steering: [], followUp: [] });
		const held: HeldQueuedMessage[] = [
			{ kind: "steer", message: { text: "s1" } },
			{ kind: "follow-up", message: { text: "f1" } },
			{ kind: "follow-up", message: { text: "f2" } },
		];
		await resumeHeldQueue(host, held);
		expect(sent).toEqual(["steer:s1", "follow:f1", "follow:f2"]);
		expect(held).toEqual([]);
	});

	test("a failed send keeps the failed and unsent messages held", async () => {
		const { host, sent } = fakeHost({ steering: [], followUp: [] }, "f1");
		const held: HeldQueuedMessage[] = [
			{ kind: "steer", message: { text: "s1" } },
			{ kind: "follow-up", message: { text: "f1" } },
			{ kind: "follow-up", message: { text: "f2" } },
		];
		await expect(resumeHeldQueue(host, held)).rejects.toThrow("send failed");
		expect(sent).toEqual(["steer:s1", "follow:f1"]);
		expect(texts(held)).toEqual(["f1", "f2"]);
	});
});

describe("takeQueuedMessage removes by identity", () => {
	test("a paused ref removes the clicked duplicate, not the first match", () => {
		const { host } = fakeHost({ steering: [], followUp: [] });
		const held: HeldQueuedMessage[] = [
			{ kind: "follow-up", message: { text: "same" } },
			{ kind: "follow-up", message: { text: "other" } },
			{ kind: "follow-up", message: { text: "same" } },
		];
		const taken = takeQueuedMessage(host, held, { kind: "follow-up", text: "same", paused: 2 });
		expect(taken?.text).toBe("same");
		expect(texts(held)).toEqual(["same", "other"]);
	});

	test("a stale paused index never removes a different message", () => {
		const { host } = fakeHost({ steering: [], followUp: [] });
		const held: HeldQueuedMessage[] = [{ kind: "follow-up", message: { text: "a" } }];
		expect(
			takeQueuedMessage(host, held, { kind: "follow-up", text: "b", paused: 0 }),
		).toBeUndefined();
		expect(texts(held)).toEqual(["a"]);
	});

	test("a live ref goes through the SDK text match on its own queue", () => {
		const calls: Array<[string, string]> = [];
		const host = {
			takeQueuedMessage: (text: string, which: "steering" | "followUp") => {
				calls.push([text, which]);
				return { text };
			},
		};
		takeQueuedMessage(host, [], { kind: "steer", text: "s" });
		takeQueuedMessage(host, [], { kind: "follow-up", text: "f" });
		expect(calls).toEqual([
			["s", "steering"],
			["f", "followUp"],
		]);
	});
});

describe("Stop preserves the queue (abort row)", () => {
	interface Abort {
		options: unknown[];
		subagentsAborted: string[];
		commandDrains: boolean[];
		/** How many SDK messages had been re-sent when each command drain ran. */
		sentAtDrain: number[];
	}

	function stopEntry(queue: FakeQueue, sent: string[]) {
		const aborts: Abort = { options: [], subagentsAborted: [], commandDrains: [], sentAtDrain: [] };
		const session = {
			clearQueue: () => ({
				steering: queue.steering.splice(0).map((text) => ({ text })),
				followUp: queue.followUp.splice(0).map((text) => ({ text })),
			}),
			abort: async (options: unknown) => {
				aborts.options.push(options);
			},
			getQueuedMessages: () => ({
				steering: [...queue.steering],
				followUp: [...queue.followUp],
				liveSteered: 0,
			}),
			steer: async (text: string) => {
				sent.push(`steer:${text}`);
			},
			followUp: async (text: string) => {
				sent.push(`follow:${text}`);
			},
		};
		const subagentSnapshots = new Map([
			["run", { status: "running" }],
			["done", { status: "completed" }],
		]);
		const entry = {
			session,
			pausedQueue: [],
			queuedCommands: { commands: [], paused: false, draining: false },
			subagentSnapshots,
		} as unknown as SessionEntry;
		const collab = {
			abortSubagent: async (_entry: SessionEntry, id: string) => {
				aborts.subagentsAborted.push(id);
			},
			drainCommands: async (e: SessionEntry) => {
				aborts.commandDrains.push(e.queuedCommands.paused);
				aborts.sentAtDrain.push(sent.length);
			},
		};
		const methods = createWebMethods({
			settings: {} as never,
			authStorage: {} as never,
			collab: collab as never,
			broker: {} as never,
			materializeSession: async () => ({ alreadyPresent: true as const }),
			sessionsDir: "/tmp/fleet-test-sessions",
			cwd: "/tmp/fleet-test-cwd",
			hasCallbackPair: () => false,
		}).methods;
		return { entry, aborts, methods };
	}

	test("Stop keeps queued follow-ups and steers paused, then Resume queue runs them in order", async () => {
		const queue: FakeQueue = { steering: ["s1"], followUp: ["f1", "f2"] };
		const sent: string[] = [];
		const { entry, methods } = stopEntry(queue, sent);

		await methods.abort!(entry, []);
		expect(queue).toEqual({ steering: [], followUp: [] });
		const snapshot = (await methods.getQueuedMessages!(entry, [])) as {
			paused: Array<{ kind: string; text: string }>;
		};
		expect(snapshot.paused.map((p) => [p.kind, p.text])).toEqual([
			["steer", "s1"],
			["follow-up", "f1"],
			["follow-up", "f2"],
		]);

		await methods.resumeQueue!(entry, []);
		expect(sent).toEqual(["steer:s1", "follow:f1", "follow:f2"]);
		expect(entry.pausedQueue).toEqual([]);
	});

	test("Stop holds a queued slash command; Resume queue releases it to the drain", async () => {
		const queue: FakeQueue = { steering: [], followUp: [] };
		const { entry, aborts, methods } = stopEntry(queue, []);
		await methods.abort!(entry, []);
		await methods.queueCommand!(entry, ["/add-dir /tmp/x"]);
		const held = (await methods.getQueuedMessages!(entry, [])) as {
			commands: string[];
			commandsPaused: boolean;
		};
		expect(held).toMatchObject({ commands: ["/add-dir /tmp/x"], commandsPaused: true });

		await methods.resumeQueue!(entry, []);
		expect(aborts.commandDrains).toEqual([true, false]);
		const released = (await methods.getQueuedMessages!(entry, [])) as { commandsPaused: boolean };
		expect(released.commandsPaused).toBe(false);
	});

	test("Resume queue re-sends held steers and follow-ups before it drains a queued command (U10b)", async () => {
		const queue: FakeQueue = { steering: ["s1"], followUp: ["f1", "f2"] };
		const sent: string[] = [];
		const { entry, aborts, methods } = stopEntry(queue, sent);
		await methods.abort!(entry, []);
		await methods.queueCommand!(entry, ["/add-dir /tmp/x"]);
		await methods.queueCommand!(entry, ["/remove-dir /tmp/y"]);
		expect(entry.queuedCommands.commands).toEqual(["/add-dir /tmp/x", "/remove-dir /tmp/y"]);

		await methods.resumeQueue!(entry, []);
		// The last drain (resume) saw all three held messages already re-sent; the
		// earlier drains ran while Stop still held everything.
		expect(aborts.sentAtDrain.at(-1)).toBe(3);
		expect(sent).toEqual(["steer:s1", "follow:f1", "follow:f2"]);
		expect(entry.queuedCommands.commands).toEqual(["/add-dir /tmp/x", "/remove-dir /tmp/y"]);
	});

	test("Stop aborts only active subagents, and keepSubagents leaves them running", async () => {
		const queue: FakeQueue = { steering: [], followUp: [] };
		const first = stopEntry(queue, []);
		await first.methods.abort!(first.entry, []);
		expect(first.aborts.subagentsAborted).toEqual(["run"]);

		const second = stopEntry(queue, []);
		await second.methods.abort!(second.entry, [{ keepSubagents: true }]);
		expect(second.aborts.subagentsAborted).toEqual([]);
		expect(second.aborts.options).toEqual([{ reason: expect.any(String) }]);
	});
});
