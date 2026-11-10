/**
 * The web's shell visualization of one bash call (`getShellVisualization`, a read-only
 * method). Since SDK 18.17.0 every bash result carries a pi-wire `ShellTrace` (1 KB for
 * `echo hi`, MBs for a loop) that the browser frames never include (see
 * `messageWithoutShellTrace`). This module finds the call's trace in the session (the
 * latest partial of a call still running, else its settled result in the transcript; a
 * subagent's call in that subagent's transcript file), has the SDK's own presentation engine
 * (pi-tui `tools/shell-viz`, the native engine the TUI draws with) render the Pseudo and Raw
 * rows, and answers a compact ANSI-free DTO under the callback envelope: the browser never
 * receives the raw trace, and an unknown call or a call without a trace is an explicit
 * `available: false` answer, never an error.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	isShellTrace,
	type ShellTrace,
	type ShellVizPresentation,
	type ShellVizRow,
} from "@oh-my-pi/pi-wire";
import {
	defaultShellVizPreferences,
	readShellPresentation,
	shellVisualization,
} from "@oh-my-pi/pi-tui/tools/shell-viz";
import type {
	ShellVizDto,
	ShellVizRowDto,
	ShellVizSegmentDto,
	ShellVizTone,
	ShellVizVariableDto,
} from "#lib/wire/protocol";
import { runningShellTrace } from "./client-delivery";
import type { SessionEntry } from "./session-entry";

type ShellVizMethod = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;

/**
 * Serialized bytes one rendering may take. Both renderings plus the answer's fields stay under
 * the callback envelope (ENVELOPE_MAX_BYTES, 1 MiB) that the `call_result` frame travels in.
 */
export const SHELL_VIZ_VIEW_BYTES = 300 * 1024;
/** Rows one rendering keeps, whatever their bytes. */
export const SHELL_VIZ_MAX_ROWS = 1500;
/** Characters a token, a variable value and a runtime note keep. */
export const SHELL_VIZ_TEXT_CHARS = 600;
const VALUE_CHARS = 300;
const VARIABLES_PER_ROW = 16;
/** Longest transcript line the subagent scan reads whole (the transcript reader's own cap for an oversized record). */
const MAX_RECORD_CHARS = 16 * 1024 * 1024;

/** Terminal-unsafe characters out, tabs and line breaks to blanks: a row is one visual line. */
function plain(text: string): string {
	return text
		.replace(/\t/g, "  ")
		.replace(/[\r\n]/g, " ")
		.replace(/\p{Cc}/gu, "");
}

function cut(text: string, chars: number): { text: string; cut: boolean } {
	const clean = plain(text);
	return clean.length > chars
		? { text: `${clean.slice(0, chars - 1)}…`, cut: true }
		: { text: clean, cut: false };
}

/** The TUI renderer's token-to-color mapping (pi-tui `shell-viz-render`), as tones. */
function toneOf(style: string | undefined): ShellVizTone | undefined {
	const tokens = style?.split(" ") ?? [];
	if (tokens.includes("comment")) return "comment";
	if (tokens.includes("kw")) return "keyword";
	if (tokens.includes("var") || tokens.includes("secret")) return "variable";
	if (tokens.includes("str") || tokens.includes("path")) return "string";
	if (tokens.includes("num")) return "number";
	if (tokens.includes("op")) return "operator";
	if (tokens.includes("cmd") || tokens.includes("fn")) return "command";
	if (tokens.includes("chip") || tokens.includes("badge")) return "accent";
	return undefined;
}

function rowDto(row: ShellVizRow, presentation: ShellVizPresentation): ShellVizRowDto {
	const running = presentation.running === true;
	const failures = new Set<string>();
	const rowFailedInSegments = row.segments.some((segment) => segment.state === "fail");
	const failedStatement =
		row.state === "fail" &&
		!rowFailedInSegments &&
		row.role !== "head" &&
		row.role !== "mid" &&
		row.role !== "tail";
	const segments: ShellVizSegmentDto[] = [];
	for (const segment of row.segments) {
		const execution = segment.executionNode ?? segment.node ?? row.node;
		const failed = segment.state === "fail" && execution !== undefined && !failures.has(execution);
		if (failed && execution !== undefined) failures.add(execution);
		const dim =
			(running && !(segment.active ?? row.active)) || (segment.state ?? row.state) === "skipped";
		const tone = toneOf(segment.style);
		const text = cut(segment.text, SHELL_VIZ_TEXT_CHARS).text;
		const last = segments[segments.length - 1];
		// Adjacent runs that read the same merge: a long statement is a handful of runs, not hundreds.
		if (
			last &&
			!failed &&
			!last.failed &&
			last.tone === tone &&
			(last.dim === true) === dim &&
			last.text.length + text.length <= SHELL_VIZ_TEXT_CHARS
		)
			last.text += text;
		else
			segments.push({
				text,
				...(tone === undefined ? {} : { tone }),
				...(failed ? { failed: true as const } : {}),
				...(dim ? { dim: true as const } : {}),
			});
	}
	const effects = presentation.preferences.layers.effects
		? row.effects.map((item) => plain(item.glyph)).join("")
		: "";
	const variables: ShellVizVariableDto[] = (row.annotations ?? [])
		.slice(0, VARIABLES_PER_ROW)
		.map((watch) => {
			const value = cut(watch.value, VALUE_CHARS);
			const shortened =
				value.cut ||
				(watch.fullLength !== undefined &&
					watch.fullLength > Buffer.byteLength(watch.value, "utf8"));
			return {
				name: cut(watch.name, 80).text,
				value: value.text,
				...(shortened ? { cut: true as const } : {}),
			};
		});
	const gutter = failedStatement ? "fail" : running && row.active ? "active" : undefined;
	return {
		depth: row.depth,
		segments,
		...(gutter === undefined ? {} : { gutter }),
		...(running && !row.active ? { dim: true as const } : {}),
		...(row.state === "fail" ? { failed: true as const } : {}),
		...(effects === "" ? {} : { effects }),
		...(row.meta ? { meta: cut(row.meta, SHELL_VIZ_TEXT_CHARS).text } : {}),
		...(variables.length === 0 ? {} : { variables }),
	};
}

/** Rows kept from the head of `rows` within the row and byte budgets, and how many were left out. */
function fitRows(rows: ShellVizRowDto[]): { rows: ShellVizRowDto[]; omitted: number } {
	let bytes = 0;
	let keep = 0;
	for (const row of rows) {
		if (keep >= SHELL_VIZ_MAX_ROWS) break;
		bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
		if (bytes > SHELL_VIZ_VIEW_BYTES) break;
		keep++;
	}
	return keep === rows.length
		? { rows, omitted: 0 }
		: { rows: rows.slice(0, keep), omitted: rows.length - keep };
}

/**
 * The SDK's presentation of `trace` as the web's DTO: Pseudo and Raw rows with failure marks and
 * variable values, cut to {@link SHELL_VIZ_VIEW_BYTES} per rendering. `cursor` replays the first N
 * retained history records (clamped to the journal; absent: the end). The captured output is not
 * part of it (the card already shows the result's output). Throws when the native engine cannot
 * render the trace.
 */
export function shellVizDto(trace: ShellTrace, cursor?: number): ShellVizDto {
	const length = trace.history?.length ?? 0;
	const at =
		cursor === undefined || length === 0 ? undefined : Math.min(length, Math.max(0, cursor));
	const source = shellVisualization(trace);
	// The engine rejected the snapshot (e.g. a `tool_result` hook rewrote `script`).
	if (!source) throw new Error("the native engine cannot restore this trace");
	const render = (view: "pseudo" | "raw"): ShellVizPresentation =>
		readShellPresentation(
			source,
			{
				...defaultShellVizPreferences(),
				view,
				...(at === undefined || at >= length ? {} : { cursor: at }),
			},
			trace,
		);
	const pseudo = render("pseudo");
	const raw = render("raw");
	const fittedPseudo = fitRows(pseudo.rows.map((row) => rowDto(row, pseudo)));
	const fittedRaw = fitRows(raw.rows.map((row) => rowDto(row, raw)));
	const { timeline } = pseudo;
	return {
		available: true,
		running: trace.status === undefined,
		...(trace.status === undefined ? {} : { status: trace.status }),
		pseudo: fittedPseudo.rows,
		raw: fittedRaw.rows,
		timeline: {
			length: timeline.length,
			cursor: timeline.cursor,
			elapsedNs: timeline.elapsedNs,
			durationNs: timeline.durationNs,
		},
		...(timeline.trimmed ? { historyTrimmed: true as const } : {}),
		...(pseudo.message ? { message: cut(pseudo.message, SHELL_VIZ_TEXT_CHARS).text } : {}),
		...(fittedPseudo.omitted > 0 || fittedRaw.omitted > 0
			? { omittedRows: { pseudo: fittedPseudo.omitted, raw: fittedRaw.omitted } }
			: {}),
	};
}

/** What a lookup found: `found` says the transcript has the bash call; `trace` is what it carries, untrusted. */
export interface TraceLookup {
	found: boolean;
	trace?: unknown;
}

/** `value[key]` of an object, else undefined. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function bashResultTrace(message: unknown, toolCallId: string): TraceLookup | undefined {
	if (
		field(message, "role") !== "toolResult" ||
		field(message, "toolName") !== "bash" ||
		field(message, "toolCallId") !== toolCallId
	)
		return undefined;
	return { found: true, trace: field(field(message, "details"), "trace") };
}

/** The settled bash result with `toolCallId` in the live session's messages. */
export function findTraceInMessages(
	messages: readonly AgentMessage[],
	toolCallId: string,
): TraceLookup {
	for (let index = messages.length - 1; index >= 0; index--) {
		const hit = bashResultTrace(messages[index], toolCallId);
		if (hit) return hit;
	}
	return { found: false };
}

/**
 * The bash result with `toolCallId` in a subagent's transcript file. The file is read as a stream
 * and only a line that names the id is parsed, so a transcript of any size costs one pass and one
 * record of memory; a line past {@link MAX_RECORD_CHARS} is skipped, as the page reader refuses it.
 */
export async function findTraceInTranscript(
	file: string,
	toolCallId: string,
): Promise<TraceLookup> {
	const needle = JSON.stringify(toolCallId);
	const decoder = new TextDecoder();
	let pending = "";
	let skipping = false;
	const inspect = (line: string): TraceLookup | undefined => {
		if (!line.includes(needle)) return undefined;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			return undefined;
		}
		return field(entry, "type") === "message"
			? bashResultTrace(field(entry, "message"), toolCallId)
			: undefined;
	};
	for await (const chunk of Bun.file(file).stream()) {
		pending += decoder.decode(chunk, { stream: true });
		let start = 0;
		for (
			let newline = pending.indexOf("\n");
			newline >= 0;
			newline = pending.indexOf("\n", start)
		) {
			if (skipping) skipping = false;
			else {
				const hit = inspect(pending.slice(start, newline));
				if (hit) return hit;
			}
			start = newline + 1;
		}
		pending = pending.slice(start);
		if (pending.length > MAX_RECORD_CHARS) {
			pending = "";
			skipping = true;
		}
	}
	pending += decoder.decode();
	if (!skipping && pending !== "") {
		const hit = inspect(pending);
		if (hit) return hit;
	}
	return { found: false };
}

export interface ShellVizDeps {
	/** The subagent transcript path of a selector; throws for an unknown agent (methods.ts passes worker-lifecycle's jailed resolver). */
	resolveTranscriptFile(entry: SessionEntry, selector: { subagentId: string }): Promise<string>;
}

function parseArgs(args: unknown[]): { toolCallId: string; subagentId?: string; cursor?: number } {
	const arg = args[0];
	const toolCallId = field(arg, "toolCallId");
	if (typeof toolCallId !== "string" || toolCallId.length === 0)
		throw new Error("getShellVisualization requires toolCallId");
	const subagentId = field(arg, "subagentId");
	const cursor = field(arg, "cursor");
	return {
		toolCallId,
		...(typeof subagentId === "string" && subagentId.length > 0 ? { subagentId } : {}),
		...(typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0 ? { cursor } : {}),
	};
}

/** The visualization of one bash call; every miss is an `available: false` answer. */
export async function shellVisualizationOf(
	entry: SessionEntry,
	args: unknown[],
	deps: ShellVizDeps,
): Promise<ShellVizDto> {
	const { toolCallId, subagentId, cursor } = parseArgs(args);
	let lookup: TraceLookup;
	if (subagentId === undefined) {
		const live = runningShellTrace(entry.handle, toolCallId);
		lookup =
			live !== undefined
				? { found: true, trace: live }
				: findTraceInMessages(entry.session.messages, toolCallId);
	} else {
		try {
			lookup = await findTraceInTranscript(
				await deps.resolveTranscriptFile(entry, { subagentId }),
				toolCallId,
			);
		} catch {
			lookup = { found: false };
		}
	}
	if (!lookup.found) return { available: false, reason: "unknown_call" };
	if (lookup.trace === undefined || lookup.trace === null)
		return { available: false, reason: "no_trace" };
	if (!isShellTrace(lookup.trace)) return { available: false, reason: "invalid_trace" };
	try {
		return shellVizDto(lookup.trace, cursor);
	} catch {
		return { available: false, reason: "invalid_trace" };
	}
}

export function createShellVizMethods(deps: ShellVizDeps): Record<string, ShellVizMethod> {
	return {
		getShellVisualization: async (entry, args) => shellVisualizationOf(entry, args, deps),
	};
}
