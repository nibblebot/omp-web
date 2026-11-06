/**
 * The attach priming frame and the post-turn broadcast carry the context figure once: reading
 * `getSessionStats()` already computes it (the SDK recounts the whole history for a model with no
 * recorded usage), so a state frame built beside those stats must reuse it, never recount.
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { createDaemonBroker } from "../daemon-broker";
import type { SessionEntry } from "../session-entry";

const settings = Settings.isolated({});

/** A session whose context figure moves with its history, counting each recount like the SDK does. */
function countingSession() {
	const history = { messages: 3 };
	const counts = { recounts: 0 };
	const usage = () => {
		counts.recounts++;
		return { tokens: history.messages * 1000, contextWindow: 100_000, percent: history.messages };
	};
	const session = {
		settings,
		model: undefined,
		getRoleModelCycle: () => undefined,
		getAvailableModels: () => [],
		modelRegistry: { getAvailable: () => [] },
		thinkingLevel: undefined,
		isAutoThinking: false,
		getAvailableEffortSelectors: () => [],
		isStreaming: false,
		isCompacting: false,
		sessionFile: undefined,
		sessionManager: { isSessionOnDisk: () => false, getBranch: () => [] },
		sessionId: "s1",
		sessionName: undefined,
		autoCompactionEnabled: false,
		autoRetryEnabled: false,
		get messages() {
			return new Array(history.messages);
		},
		queuedMessageCount: 0,
		getTodoPhases: () => [],
		getContextUsage: usage,
		getSessionStats: () => ({ contextUsage: usage() }) as unknown as SessionStats,
		getGoalModeState: () => undefined,
		getPlanModeState: () => undefined,
		isFastModeEnabled: () => false,
	} as unknown as AgentSession;
	const entry = {
		handle: "boot",
		session,
		pendingUiRequests: new Map(),
		queuedCommands: { commands: [], paused: false, draining: false },
		pausedQueue: [],
	} as unknown as SessionEntry;
	return { entry, session, history, counts };
}

function broker() {
	return createDaemonBroker({
		config: { cwd: "/tmp" } as never,
		getReadyAt: () => null,
	});
}

describe("state frame context usage", () => {
	test("reuses the figure of the stats read for the same frame", () => {
		const { entry, session, counts } = countingSession();
		const stats = session.getSessionStats();
		counts.recounts = 0;
		const state = broker().buildStateSnapshot(entry, stats);
		expect(state.contextUsage).toEqual({ tokens: 3000, contextWindow: 100_000, percent: 3 });
		expect(counts.recounts).toBe(0);
	});

	test("without stats it reads the live figure, so a grown history is never reported stale", () => {
		const { entry, history, counts } = countingSession();
		const b = broker();
		expect(b.buildStateSnapshot(entry).contextUsage?.tokens).toBe(3000);
		history.messages = 5;
		expect(b.buildStateSnapshot(entry).contextUsage?.tokens).toBe(5000);
		expect(counts.recounts).toBe(2);
	});

	test("a priming-style pair of stats and state recounts once and tracks the history", () => {
		const { entry, session, history, counts } = countingSession();
		const b = broker();
		for (const messages of [3, 7]) {
			history.messages = messages;
			counts.recounts = 0;
			const stats = session.getSessionStats();
			const state = b.buildStateSnapshot(entry, stats);
			expect(counts.recounts).toBe(1);
			expect(state.contextUsage?.tokens).toBe(messages * 1000);
			expect(stats.contextUsage).toEqual(state.contextUsage);
		}
	});
});
