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

describe("drain race: a refused queued command keeps its place (jx0b)", () => {
	test("a command refused after the drain saw idle is requeued once, at the head, in order", async () => {
		const first = Promise.withResolvers<void>();
		const calls: string[] = [];
		const listeners = new Set<(event: { type: string }) => void>();
		const fake = {
			isStreaming: false,
			subscribe(listener: (event: { type: string }) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt(text: string) {
				calls.push(text);
				return calls.length === 1 ? first.promise : Promise.resolve();
			},
		};
		const entry = entryWith(fake as unknown as AgentSession);
		entry.queuedCommands.commands.push("/a", "/b");
		const deps = collab();

		const drain = deps.drainCommands(entry);
		// While /a's prompt is still in flight, the user queues /c.
		entry.queuedCommands.commands.push("/c");
		// A user turn starts first (agent_start), then /a is refused as busy.
		fake.isStreaming = true;
		for (const listener of listeners) listener({ type: "agent_start" });
		first.reject(new AgentBusyError());
		await drain;

		expect(calls).toEqual(["/a"]);
		expect(entry.queuedCommands.commands).toEqual(["/a", "/b", "/c"]);

		fake.isStreaming = false;
		await deps.drainCommands(entry);
		expect(calls).toEqual(["/a", "/a", "/b", "/c"]);
		expect(entry.queuedCommands.commands).toEqual([]);
	});
});
