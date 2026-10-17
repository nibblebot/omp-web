/**
 * Regression tests for U10b (CMD-08): a forwarded slash command the SDK rejects
 * while a turn runs queues instead, runs in order once the turn ends, stays held
 * after Stop until Resume queue, and removes chips by index and text.
 */

import { describe, expect, test } from "bun:test";
import {
	type CommandQueueHost,
	drainQueuedCommands,
	type QueuedCommandState,
	removeQueuedCommand,
} from "../command-queue";

function state(commands: string[], paused = false): QueuedCommandState {
	return { commands: [...commands], paused, draining: false };
}

function recordingHost(log: string[], streaming = false): CommandQueueHost {
	return {
		isStreaming: () => streaming,
		run: async (text) => {
			log.push(text);
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
		expect(s.commands).toEqual(["/add-dir a"]);
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
			run: async (text) => {
				log.push(text);
				streaming = text === "/add-dir a";
			},
		};
		await drainQueuedCommands(s, host);
		expect(log).toEqual(["/add-dir a"]);
		expect(s.commands).toEqual(["/remove-dir b"]);
	});

	test("a re-entrant drain returns while one is in progress", async () => {
		const s = state(["/add-dir a", "/remove-dir b"]);
		const log: string[] = [];
		const gate = Promise.withResolvers<void>();
		const host: CommandQueueHost = {
			isStreaming: () => false,
			run: async (text) => {
				log.push(text);
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
		expect(removeQueuedCommand(s, 1, "/remove-dir b")).toBe(true);
		expect(s.commands).toEqual(["/add-dir a"]);
	});

	test("ignores a stale ref whose text no longer matches", () => {
		const s = state(["/add-dir a"]);
		expect(removeQueuedCommand(s, 0, "/remove-dir b")).toBe(false);
		expect(s.commands).toEqual(["/add-dir a"]);
	});
});

describe("queued command behind follow-up turns (U10b)", () => {
	test("a command waits while follow-up turns run, then runs in order after the last turn ends", async () => {
		const s = state(["/add-dir a", "/remove-dir b"]);
		const log: string[] = [];
		let streaming = true;
		const host: CommandQueueHost = {
			isStreaming: () => streaming,
			run: async (text) => {
				log.push(text);
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
