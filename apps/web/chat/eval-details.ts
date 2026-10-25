/**
 * What an eval tool call's `details` give the card beyond its printed text: the
 * pretty views of printed values (DataFrames, JSON, Markdown objects) and the
 * status events helpers logged (`log()`, `mcp_progress`, `agent()` snapshots).
 * Mirrors the SDK TUI's eval card (pi-tui tools/eval.ts `splitEvalOutput`,
 * `describeStatusEvent`). Pure, so the parsing stays testable without a DOM.
 */
import type { WireEvalLive, WireEvalStatusEvent } from "#lib/wire/protocol";
import { slimEvalStatus } from "#lib/wire/tool-live";
import { isRecord } from "#lib/wire/type-guards";
import type { ToolItem } from "../state";

/** One column of a table view. */
export interface EvalTableColumn {
	head: string;
	/** Numeric values: the column right-aligns. */
	numeric: boolean;
}

/** A pretty rendering of something a cell printed, shown to the user in place of its text. */
export type EvalView =
	| { kind: "table"; columns: EvalTableColumn[]; rows: string[][] }
	| { kind: "json"; value: unknown }
	| { kind: "markdown"; text: string };

/** A view and the exact printed text it stands for. */
export interface EvalViewEntry {
	text: string;
	view: EvalView;
}

/** One ordered piece of a cell's output: printed text, or a view shown in place of the text it matched. */
export type EvalOutputPart = { kind: "text"; text: string } | { kind: "view"; view: EvalView };

/** Status events a folded card shows (the newest ones); Ctrl+O reveals the rest of the kept log. */
export const EVAL_STATUS_COLLAPSED = 8;

/** Events a settled card reads from the SDK's bounded log (`MAX_STATUS_EVENTS`). */
const SETTLED_STATUS_EVENTS = 200;

function parseView(raw: unknown): EvalView | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.kind === "json") return { kind: "json", value: raw.value };
	if (raw.kind === "markdown") {
		return typeof raw.text === "string" ? { kind: "markdown", text: raw.text } : undefined;
	}
	if (raw.kind !== "table" || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) {
		return undefined;
	}
	const columns: EvalTableColumn[] = [];
	for (const column of raw.columns) {
		if (!isRecord(column) || typeof column.head !== "string") return undefined;
		columns.push({ head: column.head, numeric: column.numeric === true });
	}
	const rows: string[][] = [];
	for (const row of raw.rows) {
		if (!Array.isArray(row)) return undefined;
		rows.push(columns.map((_, i) => (typeof row[i] === "string" ? row[i] : String(row[i] ?? ""))));
	}
	return { kind: "table", columns, rows };
}

/**
 * The views of a settled eval call, cell by cell in print order. An entry whose
 * shape does not parse is dropped (the printed text still shows); `tabs` in an
 * entry's text become the two spaces the store's output carries.
 */
export function evalViews(details: unknown): EvalViewEntry[] {
	if (!isRecord(details) || !Array.isArray(details.cells)) return [];
	const entries: EvalViewEntry[] = [];
	for (const cell of details.cells) {
		if (!isRecord(cell) || !Array.isArray(cell.views)) continue;
		for (const raw of cell.views) {
			if (!isRecord(raw) || typeof raw.text !== "string" || raw.text === "") continue;
			const view = parseView(raw.view);
			if (view) entries.push({ text: raw.text.replace(/\t/g, "  "), view });
		}
	}
	return entries;
}

/**
 * Split `output` around its views, in order: each view's text is searched from
 * the end of the previous match, an entry no longer in the output (the card
 * keeps only the tail) is skipped, and blank text between views is dropped.
 */
export function splitEvalOutput(output: string, views: readonly EvalViewEntry[]): EvalOutputPart[] {
	const parts: EvalOutputPart[] = [];
	const pushText = (chunk: string, trimStart: boolean, trimEnd: boolean): void => {
		let text = chunk;
		if (trimStart) text = text.replace(/^\n+/, "");
		if (trimEnd) text = text.replace(/\n+$/, "");
		if (text.trim().length > 0) parts.push({ kind: "text", text });
	};
	let cursor = 0;
	for (const entry of views) {
		const at = output.indexOf(entry.text, cursor);
		if (at < 0) continue;
		pushText(output.slice(cursor, at), cursor > 0, true);
		parts.push({ kind: "view", view: entry.view });
		cursor = at + entry.text.length;
	}
	pushText(output.slice(cursor), cursor > 0, cursor > 0);
	return parts;
}

/**
 * The status log a card shows: the running call's live frame, else the settled
 * details' bounded log. A call backgrounded with its job keeps the job's newest
 * frame, which is newer than the details it returned with. Undefined when nothing was logged.
 */
export function evalStatusOf(item: ToolItem): WireEvalLive | undefined {
	const live = item.live?.kind === "eval" ? item.live : undefined;
	if (item.status === "running") return live;
	if (item.background !== undefined && live !== undefined) return live;
	return slimEvalStatus(item.details, SETTLED_STATUS_EVENTS);
}

/** One status event as a card line: the op, its scalar fields, and for MCP progress the formatted progress. */
export interface EvalStatusLine {
	op: string;
	/** `key=value` pairs in event order; MCP progress keeps only its tool. */
	fields: { key: string; value: string }[];
	/** MCP progress text (`message (3/10)`), when the event carries one. */
	progress?: string;
}

/**
 * Display text of MCP progress, as the SDK shows it everywhere (pi-tui tools/mcp.ts
 * `formatMCPProgress`): the message with `progress/total` when the server reports a
 * total; the bare count only without a message, since a count with no total is an
 * opaque counter. Undefined when `progress` is not a finite number.
 */
export function formatMcpProgress(event: WireEvalStatusEvent): string | undefined {
	const { progress, total, message } = event;
	if (typeof progress !== "number") return undefined;
	const text = typeof message === "string" ? message.replace(/\s+/g, " ").trim() : "";
	const amount = typeof total === "number" ? `${progress}/${total}` : `${progress}`;
	if (text === "") return amount;
	return typeof total === "number" ? `${text} (${amount})` : text;
}

export function describeStatusEvent(event: WireEvalStatusEvent): EvalStatusLine {
	const mcp = event.op === "mcp_progress";
	const fields: EvalStatusLine["fields"] = [];
	for (const [key, value] of Object.entries(event)) {
		if (key === "op" || (mcp && key !== "tool")) continue;
		fields.push({ key, value: String(value).replace(/\s+/g, " ").trim() });
	}
	const progress = mcp ? formatMcpProgress(event) : undefined;
	return { op: event.op, fields, ...(progress !== undefined ? { progress } : {}) };
}

/** A call-level note the SDK attaches to an eval result: a fallback `notice`, or the job a long cell was backgrounded as. */
export function evalNotes(details: unknown): string[] {
	if (!isRecord(details)) return [];
	const notes: string[] = [];
	if (typeof details.notice === "string" && details.notice !== "") notes.push(details.notice);
	const background = details.async;
	if (
		isRecord(background) &&
		background.state === "running" &&
		typeof background.jobId === "string"
	) {
		notes.push(`Backgrounded as job ${background.jobId}`);
	}
	return notes;
}
