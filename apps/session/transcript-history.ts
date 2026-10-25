import { cfgDisplayCollapseCompacted } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type HistoryFrame, historyFrames } from "./client-delivery";

/** Settings whose write changes the transcript a fresh attach primes. */
const HISTORY_SETTINGS: Record<string, true> = { "display.collapseCompacted": true };

/**
 * The transcript history frames for a session. Built through the SDK's
 * transcript context so `display.collapseCompacted` means what it means in the
 * TUI (interactive-mode.ts, ui-helpers.ts): collapsed shows only the latest
 * compacted tail; full shows every entry with compaction dividers. Mid-stream,
 * the current run's in-flight tool calls are kept, as the TUI keeps them; calls
 * an earlier run left unpaired are stripped (session-provider-boundary.ts).
 */
export function transcriptHistoryFrames(
	session: Pick<AgentSession, "settings" | "isStreaming" | "buildTranscriptSessionContext">,
): HistoryFrame[] {
	const context = session.buildTranscriptSessionContext({
		collapseCompactedHistory: cfgDisplayCollapseCompacted.get(session.settings),
		keepInFlightToolCalls: session.isStreaming,
	});
	return historyFrames(context.messages);
}

/**
 * True when a settings RPC changes what the transcript shows, so the session
 * resyncs history to every attached stream (the same path as HISTORY_RELOAD).
 */
export function settingWriteReloadsHistory(
	method: string,
	args: readonly unknown[] | undefined,
): boolean {
	if (method !== "setSetting" && method !== "unsetSetting") return false;
	const path = args?.[0];
	return typeof path === "string" && HISTORY_SETTINGS[path] === true;
}
