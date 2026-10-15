/**
 * Transcript history source for the web (apps/session/transcript-history.ts).
 * No live model: a real in-memory SessionManager holds user messages and a
 * compaction entry; the SDK's transcript builder decides what the web sees.
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgDisplayCollapseCompacted } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { settingWriteReloadsHistory, transcriptHistoryFrames } from "../transcript-history";

function compactedSession() {
	const sessionManager = SessionManager.inMemory("/tmp");
	sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
	const keptId = sessionManager.appendMessage({
		role: "user",
		content: "kept question",
		timestamp: 2,
	});
	sessionManager.appendCompaction("summary of the old turns", undefined, keptId, 1000);
	sessionManager.appendMessage({ role: "user", content: "new question", timestamp: 3 });
	const settings = Settings.isolated();
	const session = {
		settings,
		isStreaming: false,
		buildTranscriptSessionContext: (options: object) =>
			sessionManager.buildSessionContext({ transcript: true, ...options }),
	};
	return { settings, session: session as unknown as AgentSession };
}

function historyText(session: AgentSession): string {
	return JSON.stringify(transcriptHistoryFrames(session));
}

describe("transcriptHistoryFrames", () => {
	test("display.collapseCompacted on shows only the compacted tail", () => {
		const { settings, session } = compactedSession();
		cfgDisplayCollapseCompacted.set(settings, true);
		const text = historyText(session);
		expect(text).not.toContain("old question");
		expect(text).toContain("kept question");
		expect(text).toContain("new question");
	});

	test("display.collapseCompacted off shows every entry with the compaction divider", () => {
		const { settings, session } = compactedSession();
		cfgDisplayCollapseCompacted.set(settings, false);
		const text = historyText(session);
		expect(text).toContain("old question");
		expect(text).toContain("kept question");
		expect(text).toContain("new question");
	});

	test("the setting is read per call, so a resync after a write shows the new view", () => {
		const { settings, session } = compactedSession();
		cfgDisplayCollapseCompacted.set(settings, true);
		expect(historyText(session)).not.toContain("old question");
		cfgDisplayCollapseCompacted.set(settings, false);
		expect(historyText(session)).toContain("old question");
		cfgDisplayCollapseCompacted.set(settings, true);
		expect(historyText(session)).not.toContain("old question");
	});

	test("frames are produced for both views (the full view is not truncated)", () => {
		const { settings, session } = compactedSession();
		cfgDisplayCollapseCompacted.set(settings, false);
		const frames = transcriptHistoryFrames(session);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.every((frame) => frame.type === "history")).toBe(true);
	});
});

describe("settingWriteReloadsHistory", () => {
	test("setSetting and unsetSetting on display.collapseCompacted resync history", () => {
		expect(
			settingWriteReloadsHistory("setSetting", [
				"display.collapseCompacted",
				false,
				null,
				"global",
			]),
		).toBe(true);
		expect(settingWriteReloadsHistory("unsetSetting", ["display.collapseCompacted"])).toBe(true);
	});

	test("other settings, other methods, and missing args do not resync history", () => {
		expect(settingWriteReloadsHistory("setSetting", ["display.hideToolActivity", true])).toBe(
			false,
		);
		expect(settingWriteReloadsHistory("getSettings", ["display.collapseCompacted"])).toBe(false);
		expect(settingWriteReloadsHistory("setSetting", [])).toBe(false);
		expect(settingWriteReloadsHistory("setSetting", undefined)).toBe(false);
		expect(settingWriteReloadsHistory("setSetting", ["constructor"])).toBe(false);
	});
});
