/**
 * Regression tests for U10b (CMD-08): a forwarded slash command the SDK rejects
 * while a turn runs queues instead, runs in order once the turn ends, stays held
 * after Stop until Resume queue, and removes chips by index and text.
 */

import { describe, expect, test } from "bun:test";
import {
	type CommandQueueHost,
	drainQueuedCommands,
	hasQueuedCompaction,
	type QueuedCommand,
	type QueuedCommandState,
	removeQueuedCommand,
} from "../command-queue";

function state(commands: string[], paused = false): QueuedCommandState {
	return { commands: commands.map((text) => ({ text })), paused, draining: false };
}

function recordingHost(log: string[], streaming = false): CommandQueueHost {
	return {
		isStreaming: () => streaming,
		run: async (command) => {
			log.push(command.text);
		},
	};
}

describe("drainQueuedCommands", () => {
	test("runs queued commands in order when idle", async () => {
		const s = state(["/add-dir a", "/remove-dir b"]);
		const log: string[] = [];
		await drainQueuedCommands(s, recordingHost(log));
		expect(log).toEqual(["/add-dir a", "/remove-dir b"]);
		expect(s.commands).toEqual([]);
		expect(s.draining).toBe(false);
	});

	test("does not run while a turn is streaming", async () => {
		const s = state(["/add-dir a"]);
		const log: string[] = [];
		await drainQueuedCommands(s, recordingHost(log, true));
		expect(log).toEqual([]);
		expect(s.commands).toEqual([{ text: "/add-dir a" }]);
	});

	test("stays held while paused by Stop, then runs after resume", async () => {
		const s = state(["/add-dir a", "/remove-dir b"], true);
		const log: string[] = [];
		await drainQueuedCommands(s, recordingHost(log));
		expect(log).toEqual([]);
		expect(s.commands).toHaveLength(2);

		s.paused = false;
		await drainQueuedCommands(s, recordingHost(log));
		expect(log).toEqual(["/add-dir a", "/remove-dir b"]);
	});

	test("stops after a command that starts a model turn", async () => {
		const s = state(["/add-dir a", "/remove-dir b"]);
		const log: string[] = [];
		let streaming = false;
		const host: CommandQueueHost = {
			isStreaming: () => streaming,
			run: async (command) => {
				log.push(command.text);
				streaming = command.text === "/add-dir a";
			},
		};
		await drainQueuedCommands(s, host);
		expect(log).toEqual(["/add-dir a"]);
		expect(s.commands).toEqual([{ text: "/remove-dir b" }]);
	});

	test("a re-entrant drain returns while one is in progress", async () => {
		const s = state(["/add-dir a", "/remove-dir b"]);
		const log: string[] = [];
		const gate = Promise.withResolvers<void>();
		const host: CommandQueueHost = {
			isStreaming: () => false,
			run: async (command) => {
				log.push(command.text);
				await gate.promise;
			},
		};
		const first = drainQueuedCommands(s, host);
		await drainQueuedCommands(s, host);
		expect(log).toEqual(["/add-dir a"]);
		gate.resolve();
		await first;
		expect(log).toEqual(["/add-dir a", "/remove-dir b"]);
	});

	test("a failing command clears the draining flag so the queue can resume", async () => {
		const s = state(["/add-dir a"]);
		const host: CommandQueueHost = {
			isStreaming: () => false,
			run: async () => {
				throw new Error("boom");
			},
		};
		await expect(drainQueuedCommands(s, host)).rejects.toThrow("boom");
		expect(s.draining).toBe(false);
	});
});

describe("removeQueuedCommand", () => {
	test("removes the chip at its index when the text matches", () => {
		const s = state(["/add-dir a", "/remove-dir b"]);
		expect(removeQueuedCommand(s, 1, "/remove-dir b")).toEqual({ text: "/remove-dir b" });
		expect(s.commands).toEqual([{ text: "/add-dir a" }]);
	});

	test("ignores a stale ref whose text no longer matches", () => {
		const s = state(["/add-dir a"]);
		expect(removeQueuedCommand(s, 0, "/remove-dir b")).toBeUndefined();
		expect(s.commands).toEqual([{ text: "/add-dir a" }]);
	});

	test("returns the removed command with its images", () => {
		const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
		const s: QueuedCommandState = {
			commands: [{ text: "/skill:a", images: [image] }],
			paused: false,
			draining: false,
		};
		expect(removeQueuedCommand(s, 0, "/skill:a")).toEqual({ text: "/skill:a", images: [image] });
		expect(s.commands).toEqual([]);
	});
});

describe("queued command behind follow-up turns (U10b)", () => {
	test("a command waits while follow-up turns run, then runs in order after the last turn ends", async () => {
		const s = state(["/add-dir a", "/remove-dir b"]);
		const log: string[] = [];
		let streaming = true;
		const host: CommandQueueHost = {
			isStreaming: () => streaming,
			run: async (command) => {
				log.push(command.text);
			},
		};
		// agent_end of a follow-up turn fires while the next follow-up has already started.
		await drainQueuedCommands(s, host);
		expect(log).toEqual([]);
		streaming = false;
		await drainQueuedCommands(s, host);
		expect(log).toEqual(["/add-dir a", "/remove-dir b"]);
		expect(s.commands).toEqual([]);
	});
});

describe("a queued compaction at the head (queueable compaction)", () => {
	const compact: QueuedCommand = {
		text: "/compact soft",
		compaction: { mode: "soft", origin: { sessionId: "s", leafId: null } },
	};
	const queue = (...commands: QueuedCommand[]): QueuedCommandState => ({
		commands,
		paused: false,
		draining: false,
	});

	test("hasQueuedCompaction sees a compaction anywhere in the queue", () => {
		expect(hasQueuedCompaction(queue({ text: "/add-dir a" }))).toBe(false);
		expect(hasQueuedCompaction(queue({ text: "/add-dir a" }, compact))).toBe(true);
	});

	test("the drain waits in settle while the turn runs, then runs it and the commands behind it in order", async () => {
		const s = queue(compact, { text: "after" });
		const log: string[] = [];
		const turn = Promise.withResolvers<void>();
		let streaming = true;
		const host: CommandQueueHost = {
			isStreaming: () => streaming,
			settle: async () => {
				log.push("settle");
				await turn.promise;
			},
			run: async (command) => {
				log.push(command.text);
			},
		};
		const drain = drainQueuedCommands(s, host);
		// Mid-turn: the compaction holds the drain instead of ending it.
		await Promise.resolve();
		expect(log).toEqual(["settle"]);
		expect(s.draining).toBe(true);
		streaming = false;
		turn.resolve();
		await drain;
		expect(log).toEqual(["settle", "/compact soft", "after"]);
		expect(s.commands).toEqual([]);
	});

	test("a compaction removed while it waits never runs; the drain moves on", async () => {
		const s = queue(compact, { text: "after" });
		const log: string[] = [];
		const host: CommandQueueHost = {
			isStreaming: () => false,
			settle: async () => {
				s.commands.shift();
			},
			run: async (command) => {
				log.push(command.text);
			},
		};
		await drainQueuedCommands(s, host);
		expect(log).toEqual(["after"]);
	});

	test("Stop while it waits leaves it queued", async () => {
		const s = queue(compact);
		const log: string[] = [];
		const host: CommandQueueHost = {
			isStreaming: () => false,
			settle: async () => {
				s.paused = true;
			},
			run: async (command) => {
				log.push(command.text);
			},
		};
		await drainQueuedCommands(s, host);
		expect(log).toEqual([]);
		expect(s.commands).toEqual([compact]);
		expect(s.draining).toBe(false);
	});

	test("a turn that starts again after the wait defers it to the next agent_end", async () => {
		const s = queue(compact);
		const log: string[] = [];
		const host: CommandQueueHost = {
			isStreaming: () => true,
			settle: async () => {},
			run: async (command) => {
				log.push(command.text);
			},
		};
		await drainQueuedCommands(s, host);
		expect(log).toEqual([]);
		expect(s.commands).toEqual([compact]);
	});

	test("a plain command never waits in settle", async () => {
		const s = queue({ text: "/add-dir a" });
		const log: string[] = [];
		const host: CommandQueueHost = {
			isStreaming: () => false,
			settle: async () => {
				log.push("settle");
			},
			run: async (command) => {
				log.push(command.text);
			},
		};
		await drainQueuedCommands(s, host);
		expect(log).toEqual(["/add-dir a"]);
	});
});
