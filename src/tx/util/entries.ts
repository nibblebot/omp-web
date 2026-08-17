/**
 * Safe accessors over raw JSONL entry objects (RawEntry = Record<string, unknown>).
 * Every read is defensive — the JSONL data is lenient and entries vary in shape.
 */
import type { RawEntry } from "../api";

export interface ContentBlock {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	content?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	url?: unknown;
	caption?: unknown;
}

export type EntryMessage = Record<string, unknown>;

/** True when the entry carries a `message` object (assistant/user/toolResult). */
export function isMessage(e: RawEntry): e is RawEntry & { message: EntryMessage } {
	return typeof e.message === "object" && e.message !== null && !Array.isArray(e.message);
}

export function messageObj(e: RawEntry): EntryMessage {
	return isMessage(e) ? e.message : {};
}

export function messageRole(e: RawEntry): string | null {
	const r = messageObj(e).role;
	return typeof r === "string" ? r : null;
}

/** Entry-level timestamp (ISO string or epoch ms). */
export function entryTimestamp(e: RawEntry): number | null {
	const t = e.timestamp;
	if (typeof t === "number") return t;
	if (typeof t === "string") {
		const p = Date.parse(t);
		return Number.isNaN(p) ? null : p;
	}
	return null;
}

/** Preferred message timestamp (epoch ms), falling back to the entry timestamp. */
export function entryTs(e: RawEntry): number | null {
	const m = messageObj(e);
	const t = m.timestamp;
	if (typeof t === "number") return t;
	return entryTimestamp(e);
}

/**
 * Tool-execution start marker (`custom` entry with customType "tool_execution_start").
 * Returns the toolCallId and execution start (epoch ms) — data.startedAt when
 * present (ISO string or epoch ms), else the entry's own timestamp — or null
 * when the entry isn't a usable marker.
 */
export function toolExecutionStartOf(
	e: RawEntry,
): { toolCallId: string; startedAtMs: number } | null {
	if (e.type !== "custom" || e.customType !== "tool_execution_start") return null;
	const data = obj(e.data);
	if (data === null) return null;
	const id = data.toolCallId;
	if (typeof id !== "string") return null;
	let ms: number | null = null;
	const sa = data.startedAt;
	if (typeof sa === "number" && Number.isFinite(sa)) ms = sa;
	else if (typeof sa === "string") {
		const p = Date.parse(sa);
		if (!Number.isNaN(p)) ms = p;
	} else {
		ms = entryTimestamp(e);
	}
	return ms === null ? null : { toolCallId: id, startedAtMs: ms };
}

/** Content blocks of a message; a string `content` becomes one text block. */
export function contentBlocks(e: RawEntry): ContentBlock[] {
	const c = messageObj(e).content;
	if (Array.isArray(c)) {
		return c.filter(
			(b): b is ContentBlock => typeof b === "object" && b !== null && !Array.isArray(b),
		);
	}
	if (typeof c === "string") return [{ type: "text", text: c }];
	return [];
}

/** Joined plain text of a user message (string content or text blocks). */
export function userText(e: RawEntry): string {
	const c = messageObj(e).content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((b) =>
				typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string"
					? (b as { text: string }).text
					: "",
			)
			.join("\n");
	}
	return "";
}

/** True when a user message contains at least one image block. */
export function userHasImage(e: RawEntry): boolean {
	return contentBlocks(e).some((b) => b.type === "image");
}

export function toolCallIdOf(e: RawEntry): string | null {
	const v = messageObj(e).toolCallId;
	return typeof v === "string" ? v : null;
}

export function toolResultIsError(e: RawEntry): boolean {
	const v = messageObj(e).isError;
	return v === true || v === 1;
}

/** Joined text of a toolResult message. */
export function toolResultText(e: RawEntry): string {
	const c = messageObj(e).content;
	if (Array.isArray(c)) {
		return c
			.map((b) =>
				typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string"
					? (b as { text: string }).text
					: "",
			)
			.join("\n");
	}
	if (typeof c === "string") return c;
	return "";
}

export function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

export function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

/** Pretty-print a toolCall `arguments` field (already-parsed object or JSON string). */
export function prettyArgs(a: unknown): string {
	if (a === undefined || a === null) return "{}";
	if (typeof a === "string") {
		if (a.trim() === "") return "{}";
		try {
			return JSON.stringify(JSON.parse(a), null, 2);
		} catch {
			return a;
		}
	}
	try {
		return JSON.stringify(a, null, 2);
	} catch {
		return String(a);
	}
}

/** Short human summary for system rows (model_change, compaction, …). */
export function systemDetail(e: RawEntry): string {
	const cap = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n)}…` : s);
	const keys = [
		"model",
		"to",
		"from",
		"name",
		"title",
		"level",
		"service",
		"id",
		"cwd",
		"summary",
		"text",
		"message",
		"reason",
	];
	const parts: string[] = [];
	for (const k of keys) {
		const v = e[k];
		if (typeof v === "string" && v !== "") parts.push(v);
	}
	if (parts.length === 0) {
		try {
			return cap(JSON.stringify(e));
		} catch {
			return "";
		}
	}
	return cap(parts.join(" · "), 260);
}

// ---------------------------------------------------------------------------
// Exhaustive transcript accessors (typed renderers + raw-JSON fallback)
// ---------------------------------------------------------------------------

/** Pretty-printed full entry JSON; falls back to String(e) on circulars. */
export function rawJson(e: RawEntry): string {
	try {
		const s = JSON.stringify(e, null, 2);
		return typeof s === "string" ? s : String(e);
	} catch {
		return String(e);
	}
}

export interface SessionHeaderInfo {
	cwd: string;
	id: string;
	version: number | null;
	title: string | null;
	titleSource: string | null;
}

/** Session header metadata (entry type "session"). */
export function sessionHeaderOf(e: RawEntry): SessionHeaderInfo | null {
	if (e.type !== "session") return null;
	return {
		cwd: str(e.cwd),
		id: str(e.id),
		version: num(e.version),
		title: typeof e.title === "string" ? e.title : null,
		titleSource: typeof e.titleSource === "string" ? e.titleSource : null,
	};
}

export interface SessionInitInfo {
	systemPrompt: string;
	tools: string[];
	resolvedModel: string | null;
	modelRole: string | null;
	agent: string | null;
	task: string | null;
	spawns: unknown;
	outputSchema: Record<string, unknown> | null;
	outputSchemaMode: string | null;
	readOnly: boolean | null;
	readSummarize: unknown;
}

/** Session-init system row (entry type "session_init"); tools are tool names. */
export function sessionInitOf(e: RawEntry): SessionInitInfo | null {
	if (e.type !== "session_init") return null;
	const tools = Array.isArray(e.tools)
		? e.tools.filter((t): t is string => typeof t === "string")
		: [];
	return {
		systemPrompt: str(e.systemPrompt),
		tools,
		resolvedModel: typeof e.resolvedModel === "string" ? e.resolvedModel : null,
		modelRole: typeof e.modelRole === "string" ? e.modelRole : null,
		agent: typeof e.agent === "string" ? e.agent : null,
		task: typeof e.task === "string" ? e.task : null,
		spawns: e.spawns,
		outputSchema: obj(e.outputSchema),
		outputSchemaMode: typeof e.outputSchemaMode === "string" ? e.outputSchemaMode : null,
		readOnly: typeof e.readOnly === "boolean" ? e.readOnly : null,
		readSummarize: e.readSummarize,
	};
}

/** Mode-change system row (entry type "mode_change"). */
export function modeChangeOf(
	e: RawEntry,
): { mode: string | null; data: Record<string, unknown> | null } | null {
	if (e.type !== "mode_change") return null;
	return { mode: typeof e.mode === "string" ? e.mode : null, data: obj(e.data) };
}

/** Model-change system row (entry type "model_change"). */
export function modelChangeOf(
	e: RawEntry,
): { model: string | null; role: string | null; resolvedModelIsFallback: boolean } | null {
	if (e.type !== "model_change") return null;
	return {
		model: typeof e.model === "string" ? e.model : null,
		role: typeof e.role === "string" ? e.role : null,
		resolvedModelIsFallback: e.resolvedModelIsFallback === true,
	};
}

/** Thinking-level system row (entry type "thinking_level_change"). */
export function thinkingLevelChangeOf(
	e: RawEntry,
): { thinkingLevel: string | null; configured: unknown } | null {
	if (e.type !== "thinking_level_change") return null;
	return {
		thinkingLevel: typeof e.thinkingLevel === "string" ? e.thinkingLevel : null,
		configured: e.configured,
	};
}

/** Service-tier system row (entry type "service_tier_change"); serviceTier may legitimately be null. */
export function serviceTierChangeOf(e: RawEntry): { serviceTier: string | null } | null {
	if (e.type !== "service_tier_change") return null;
	return { serviceTier: typeof e.serviceTier === "string" ? e.serviceTier : null };
}

/** Title-change system row (entry type "title_change"); corpus uses previousTitle/title. */
export function titleChangeOf(e: RawEntry): {
	previousTitle: string | null;
	title: string | null;
	source: string | null;
	trigger: string | null;
} | null {
	if (e.type !== "title_change") return null;
	return {
		previousTitle: typeof e.previousTitle === "string" ? e.previousTitle : null,
		title: typeof e.title === "string" ? e.title : null,
		source: typeof e.source === "string" ? e.source : null,
		trigger: typeof e.trigger === "string" ? e.trigger : null,
	};
}

/** TTSR-injection system row (entry type "ttsr_injection") — the injected rule texts. */
export function ttsrInjectionOf(e: RawEntry): string[] | null {
	if (e.type !== "ttsr_injection") return null;
	const r = e.injectedRules;
	if (!Array.isArray(r)) return null;
	return r.filter((x): x is string => typeof x === "string");
}

/** Compaction system row (entry type "compaction") — its human summary. */
export function compactionSummaryOf(e: RawEntry): string | null {
	if (e.type !== "compaction") return null;
	return typeof e.summary === "string" ? e.summary : null;
}

/** Label system row (entry type "label") — the label text. */
export function labelOf(e: RawEntry): string | null {
	if (e.type !== "label") return null;
	return typeof e.label === "string" ? e.label : null;
}

export interface CustomMessageInfo {
	customType: string | null;
	content: unknown;
	display: unknown;
	details: { notes: Array<{ note: string; severity: string }> } | null;
}

/** Custom-message system row (entry type "custom_message"). */
export function customMessageOf(e: RawEntry): CustomMessageInfo | null {
	if (e.type !== "custom_message") return null;
	const details = obj(e.details);
	let notes: Array<{ note: string; severity: string }> = [];
	if (details !== null && Array.isArray(details.notes)) {
		notes = details.notes.filter((n): n is { note: string; severity: string } => {
			if (typeof n !== "object" || n === null || Array.isArray(n)) return false;
			if (!("note" in n) || !("severity" in n)) return false;
			return typeof n.note === "string" && typeof n.severity === "string";
		});
	}
	return {
		customType: typeof e.customType === "string" ? e.customType : null,
		content: e.content,
		display: e.display,
		details: details === null ? null : { notes },
	};
}

/** Any `custom` entry (type "custom" + customType) — caller decides which customType to render or hide. */
export function customEntryOf(
	e: RawEntry,
): { customType: string; data: Record<string, unknown> | null } | null {
	if (e.type !== "custom") return null;
	return { customType: str(e.customType), data: obj(e.data) };
}

export interface AssistantMeta {
	api: string | null;
	provider: string | null;
	ttft: number | null;
	responseId: string | null;
	stopDetails: unknown;
	errorId: string | null;
	errorStatus: unknown;
	contextSnapshot: { promptTokens: number | null; nonMessageTokens: number | null } | null;
	usage: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		reasoningTokens: number | null;
		costTotal: number | null;
	} | null;
}

/** Enriched meta of an assistant message entry. */
export function assistantMetaOf(e: RawEntry): AssistantMeta | null {
	const m = messageObj(e);
	if (m.role !== "assistant") return null;
	const ctx = obj(m.contextSnapshot);
	const usage = obj(m.usage);
	const cost = usage === null ? null : obj(usage.cost);
	return {
		api: typeof m.api === "string" ? m.api : null,
		provider: typeof m.provider === "string" ? m.provider : null,
		ttft: num(m.ttft),
		responseId: typeof m.responseId === "string" ? m.responseId : null,
		stopDetails: m.stopDetails,
		errorId: typeof m.errorId === "string" ? m.errorId : null,
		errorStatus: m.errorStatus,
		contextSnapshot:
			ctx === null
				? null
				: { promptTokens: num(ctx.promptTokens), nonMessageTokens: num(ctx.nonMessageTokens) },
		usage:
			usage === null
				? null
				: {
						input: num(usage.input),
						output: num(usage.output),
						cacheRead: num(usage.cacheRead),
						cacheWrite: num(usage.cacheWrite),
						reasoningTokens: num(usage.reasoningTokens),
						costTotal: cost === null ? null : num(cost.total),
					},
	};
}

export interface ToolResultMeta {
	toolName: string | null;
	details: Record<string, unknown> | null;
	useless: boolean | null;
	prunedAt: unknown;
}

/** Enriched meta of a toolResult message entry. */
export function toolResultMetaOf(e: RawEntry): ToolResultMeta | null {
	const m = messageObj(e);
	if (m.role !== "toolResult") return null;
	return {
		toolName: typeof m.toolName === "string" ? m.toolName : null,
		details: obj(m.details),
		useless: typeof m.useless === "boolean" ? m.useless : null,
		prunedAt: m.prunedAt,
	};
}

export interface UserMeta {
	attribution: unknown;
	steering: unknown;
	synthetic: unknown;
}

/** Enriched meta of a user message entry. */
export function userMetaOf(e: RawEntry): UserMeta | null {
	const m = messageObj(e);
	if (m.role !== "user") return null;
	return { attribution: m.attribution, steering: m.steering, synthetic: m.synthetic };
}

/** Human label for an entry's type — used in aria-labels and short summaries. */
export function entryTypeLabel(e: RawEntry): string {
	const t = typeof e.type === "string" ? e.type : "unknown";
	if (t !== "message") return t;
	const role = messageRole(e);
	return role !== null ? role : "message";
}

/** Short human summary of an entry (aria-label companion to entryTypeLabel). */
export function shortSummary(e: RawEntry, maxLen = 60): string {
	const t = entryTypeLabel(e);
	let s = "";
	if (t === "assistant" || t === "developer") {
		s = contentBlocks(e)
			.map((b) =>
				b.type === "text" ? str(b.text) : b.type === "toolCall" ? `[${str(b.name) || "tool"}]` : "",
			)
			.filter((p) => p !== "")
			.join(" ");
	} else if (t === "user") {
		s = userText(e);
	} else if (t === "toolResult") {
		s = toolResultText(e);
	} else {
		s = systemDetail(e);
		if (s === "") {
			const c = customEntryOf(e);
			if (c !== null) s = c.customType;
		}
	}
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > maxLen ? `${one.slice(0, maxLen)}…` : one;
}
