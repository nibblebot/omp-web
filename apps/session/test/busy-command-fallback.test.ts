/**
 * jx0b (CMD-08): a prompt the SDK refuses because a turn is running is queued
 * as a command instead of surfacing the raw AgentBusyError. Stop-pause and the
 * queue's own drain rules still apply; a prompt with attachments cannot be
 * queued (the queue holds text only) and keeps its error.
 */
import { describe, expect, test } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createCollabSession } from "../collab-session";
import type { SessionEntry } from "../session-entry";

function busySession(): AgentSession {
	return {
		isStreaming: true,
		prompt: async () => {
			throw new AgentBusyError();
		},
	} as unknown as AgentSession;
}

function entryWith(session: AgentSession): SessionEntry {
	return {
		handle: "s1",
		cwd: "/tmp",
		session,
		queuedCommands: { commands: [], paused: false, draining: false },
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

describe("busy prompt fallback (CMD-08)", () => {
	test("a slash command refused as busy is queued, not surfaced", async () => {
		const entry = entryWith(busySession());
		await collab().fireAndForgetPrompt(entry, "/ratchet", undefined);
		expect(entry.queuedCommands.commands).toEqual(["/ratchet"]);
	});

	test("queued commands keep their order across two refused prompts", async () => {
		const entry = entryWith(busySession());
		const deps = collab();
		await deps.fireAndForgetPrompt(entry, "/force", undefined);
		await deps.fireAndForgetPrompt(entry, "/add-dir /tmp/x", undefined);
		expect(entry.queuedCommands.commands).toEqual(["/force", "/add-dir /tmp/x"]);
	});

	test("a paused queue (Stop) still holds the refused command", async () => {
		const entry = entryWith(busySession());
		entry.queuedCommands.paused = true;
		await collab().fireAndForgetPrompt(entry, "/ratchet", undefined);
		expect(entry.queuedCommands.commands).toEqual(["/ratchet"]);
		expect(entry.queuedCommands.paused).toBe(true);
	});

	test("a non-busy error is not queued", async () => {
		const failing = {
			isStreaming: true,
			prompt: async () => {
				throw new Error("model unavailable");
			},
		} as unknown as AgentSession;
		const entry = entryWith(failing);
		await collab().fireAndForgetPrompt(entry, "/ratchet", undefined);
		expect(entry.queuedCommands.commands).toEqual([]);
	});

	test("a busy prompt with attachments is not queued: the queue holds text only", async () => {
		const entry = entryWith(busySession());
		const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
		await collab().fireAndForgetPrompt(entry, "/ratchet", images as never);
		expect(entry.queuedCommands.commands).toEqual([]);
	});
});
