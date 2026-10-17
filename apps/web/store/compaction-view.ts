import type { CompactionItem } from "../state";

/**
 * Pure presentation helpers for compaction (no store access): the plain-language
 * error text (CMD-13) and the transcript card built from a settled SDK
 * `compactionSummary` history message (CMD-12).
 */

/**
 * Turns a raw SDK/RPC compaction or handoff failure into one plain sentence.
 * Class prefixes ("ManualCompactionNoOpError: ", "Error: Error: ") never reach
 * the user; an unrecognized message keeps its own text, capitalized.
 */
export function humanizeCompactionError(raw: unknown): string {
	const text = raw instanceof Error ? raw.message : String(raw ?? "");
	const msg = text.replace(/^(?:\w*Error:\s*)+/, "").trim();
	const nothing = /nothing to (compact|hand off)/i.exec(msg);
	if (nothing) {
		const verb = nothing[1]!.toLowerCase();
		if (/no messages yet/i.test(msg))
			return `There is nothing to ${verb} yet. Send a message first.`;
		if (verb === "hand off")
			return "Nothing to hand off yet. The session is too short to summarize.";
		return "Nothing to compact yet. The whole session still fits inside the recent messages that compaction keeps.";
	}
	if (/already compacted/i.test(msg)) {
		return "Nothing more to compact. The earlier messages are already summarized.";
	}
	if (/no model selected/i.test(msg)) {
		return "No model is selected. Pick a model first; compaction summarizes with the active model.";
	}
	if (/cancel|abort/i.test(msg)) return "Compaction was cancelled.";
	if (/timed out/i.test(msg)) return "The session did not answer in time. Try again in a moment.";
	if (/exceeds the context budget|would not reduce|could not bring/i.test(msg)) {
		return "Compaction could not shrink the context enough. Try another method under Advanced, or start a fresh session.";
	}
	if (!msg) return "Compaction failed. Try again.";
	return msg[0]!.toUpperCase() + msg.slice(1);
}

interface SummaryMessageLike {
	role?: unknown;
	summary?: unknown;
	tokensBefore?: unknown;
	tokensAfter?: unknown;
	method?: unknown;
	warning?: unknown;
	timestamp?: unknown;
}

const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The card for an SDK `compactionSummary` history message, or null for any other message. */
export function compactionItemOf(msg: unknown): Omit<CompactionItem, "id"> | null {
	const m = msg as SummaryMessageLike | null;
	if (!m || m.role !== "compactionSummary") return null;
	const method = typeof m.method === "string" ? m.method : undefined;
	const tokensBefore = num(m.tokensBefore);
	const tokensAfter = num(m.tokensAfter);
	const timestamp = num(m.timestamp);
	return {
		kind: "compaction",
		action: method === "handoff" ? "handoff" : "compact",
		summary: typeof m.summary === "string" && m.summary ? m.summary : undefined,
		...(tokensBefore !== undefined ? { tokensBefore } : {}),
		...(tokensAfter !== undefined ? { tokensAfter } : {}),
		...(method !== undefined ? { method } : {}),
		...(typeof m.warning === "string" && m.warning ? { warning: m.warning } : {}),
		...(timestamp !== undefined ? { timestamp } : {}),
		skipped: false,
		aborted: false,
		willRetry: false,
	};
}
