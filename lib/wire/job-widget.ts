import type {
	WireJobWidgetBlock,
	WireJobWidgetHeadline,
	WireJobWidgetSparkBlock,
	WireJobWidgetState,
	WireJobWidgetTone,
	WireJobWidgetTrend,
	WireJobWidgetView,
} from "./protocol";
import { isRecord } from "./type-guards";

/** Characters a widget text keeps (the SDK cuts titles, stages and text blocks at 200). */
export const JOB_WIDGET_TEXT_CHARS = 200;
/** Blocks a view keeps. */
export const JOB_WIDGET_BLOCKS = 8;
/** Points a spark keeps, newest (the SDK downsamples to 48). */
export const JOB_WIDGET_SPARK_POINTS = 48;
/** Reference lines a spark keeps. */
const MARKS = 8;
/** Items a bars block keeps (the SDK lists 16). */
const BAR_ITEMS = 16;
/** Items a stat block keeps. */
const STAT_ITEMS = 12;
/** Cells a grid block keeps (the SDK lists 48). */
const GRID_ITEMS = 48;
/** Values a row's glance keeps of the primary spark (pi-tui `MINI_SPARK_POINTS`). */
export const JOB_WIDGET_GLANCE_POINTS = 16;

const STATES: Record<string, WireJobWidgetState> = {
	authoring: "authoring",
	live: "live",
	fallback: "fallback",
};
const TONES: Record<string, WireJobWidgetTone> = {
	neutral: "neutral",
	accent: "accent",
	info: "info",
	success: "success",
	warning: "warning",
	error: "error",
	pending: "pending",
	muted: "muted",
	user: "user",
};
const TREND_TONES: Record<string, WireJobWidgetTrend["tone"]> = {
	success: "success",
	error: "error",
	muted: "muted",
};

const ESC = "\u001b";

/** `text` without its ANSI escape sequences (CSI and OSC; any other escape drops with its next character). */
function stripEscapes(text: string): string {
	if (!text.includes(ESC)) return text;
	let out = "";
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== ESC) {
			out += text[i];
			continue;
		}
		const next = text[i + 1];
		if (next === "[") {
			i += 2;
			for (; i < text.length; i++) {
				const code = text.charCodeAt(i);
				if (code >= 0x40 && code <= 0x7e) break;
			}
		} else if (next === "]") {
			i += 2;
			while (i < text.length && text[i] !== "\u0007" && !(text[i] === ESC && text[i + 1] === "\\"))
				i++;
			if (text[i] === ESC) i++;
		} else {
			i++;
		}
	}
	return out;
}

/** One clean line: escapes gone, control characters and whitespace runs one space, cut to `max` with an ellipsis. */
function line(raw: unknown, max = JOB_WIDGET_TEXT_CHARS): string {
	if (typeof raw !== "string") return "";
	let text = "";
	for (const char of stripEscapes(raw)) {
		const code = char.codePointAt(0) ?? 0;
		text += code < 0x20 || code === 0x7f ? " " : char;
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toneOf(raw: unknown): WireJobWidgetTone | undefined {
	return typeof raw === "string" ? TONES[raw] : undefined;
}

function trendOf(raw: unknown): WireJobWidgetTrend | undefined {
	if (!isRecord(raw)) return undefined;
	const text = line(raw.text);
	if (text === "") return undefined;
	return {
		text,
		tone: (typeof raw.tone === "string" ? TREND_TONES[raw.tone] : undefined) ?? "muted",
	};
}

function recordsOf(raw: unknown, max: number): Record<string, unknown>[] {
	if (!Array.isArray(raw)) return [];
	const items: Record<string, unknown>[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		items.push(item);
		if (items.length >= max) break;
	}
	return items;
}

function sparkOf(raw: Record<string, unknown>): WireJobWidgetSparkBlock {
	const rawValues = Array.isArray(raw.values) ? raw.values : [];
	const rawTips = Array.isArray(raw.tips) ? raw.tips : undefined;
	const values: number[] = [];
	const tips: string[] = [];
	for (let i = Math.max(0, rawValues.length - JOB_WIDGET_SPARK_POINTS); i < rawValues.length; i++) {
		const value = finite(rawValues[i]);
		if (value === undefined) continue;
		values.push(value);
		tips.push(line(rawTips?.[i]));
	}
	const marks: NonNullable<WireJobWidgetSparkBlock["marks"]> = [];
	for (const mark of recordsOf(raw.marks, MARKS)) {
		const value = finite(mark.value);
		if (value === undefined) continue;
		const tone = toneOf(mark.tone);
		marks.push({ value, label: line(mark.label), ...(tone ? { tone } : {}) });
	}
	const domain = [...values, ...marks.map((mark) => mark.value)];
	const tone = toneOf(raw.tone);
	return {
		kind: "spark",
		label: line(raw.label),
		values,
		min: finite(raw.min) ?? (domain.length > 0 ? Math.min(...domain) : 0),
		max: finite(raw.max) ?? (domain.length > 0 ? Math.max(...domain) : 1),
		...(marks.length > 0 ? { marks } : {}),
		last: line(raw.last),
		...(rawTips !== undefined && tips.some((tip) => tip !== "") ? { tips } : {}),
		...(tone ? { tone } : {}),
	};
}

function blockOf(raw: Record<string, unknown>): WireJobWidgetBlock | undefined {
	switch (raw.kind) {
		case "spark":
			return sparkOf(raw);
		case "bars": {
			const items = recordsOf(raw.items, BAR_ITEMS).map((item) => {
				const tone = toneOf(item.tone);
				return {
					label: line(item.label),
					value: finite(item.value) ?? 0,
					text: line(item.text),
					...(tone ? { tone } : {}),
				};
			});
			const max = finite(raw.max);
			return {
				kind: "bars",
				label: line(raw.label),
				items,
				max: max !== undefined && max > 0 ? max : Math.max(1, ...items.map((item) => item.value)),
			};
		}
		case "meter": {
			const tone = toneOf(raw.tone);
			return {
				kind: "meter",
				label: line(raw.label),
				value: Math.min(1, Math.max(0, finite(raw.value) ?? 0)),
				text: line(raw.text),
				...(tone ? { tone } : {}),
			};
		}
		case "stat": {
			const items: Extract<WireJobWidgetBlock, { kind: "stat" }>["items"] = [];
			for (const item of recordsOf(raw.items, STAT_ITEMS)) {
				const label = line(item.label);
				const text = line(item.text);
				if (label === "" && text === "") continue;
				const tone = toneOf(item.tone);
				const trend = trendOf(item.trend);
				items.push({
					label,
					text,
					...(tone ? { tone } : {}),
					...(trend ? { trend } : {}),
				});
			}
			return { kind: "stat", items };
		}
		case "grid":
			return {
				kind: "grid",
				label: line(raw.label),
				items: recordsOf(raw.items, GRID_ITEMS).map((item) => ({
					label: line(item.label),
					text: line(item.text),
					tone: toneOf(item.tone) ?? "neutral",
				})),
			};
		case "text":
			return { kind: "text", text: line(raw.text) };
		default:
			return undefined;
	}
}

function headlineOf(raw: unknown): WireJobWidgetHeadline | undefined {
	if (!isRecord(raw)) return undefined;
	const text = line(raw.text);
	if (text === "") return undefined;
	const label = line(raw.label);
	const trend = trendOf(raw.trend);
	return { text, ...(label !== "" ? { label } : {}), ...(trend ? { trend } : {}) };
}

/**
 * A job widget as untrusted JSON (the SDK's `JobWidgetView` from a live job, a
 * wait result's `details`, or a session file written by another SDK build) to
 * the wire shape: texts cut to one clean line, numbers finite, lists bounded,
 * blocks of an unknown kind and an unknown state or tone dropped or defaulted.
 * Undefined when `raw` is not a view at all.
 */
export function parseJobWidgetView(raw: unknown): WireJobWidgetView | undefined {
	if (!isRecord(raw) || typeof raw.title !== "string") return undefined;
	const headline = headlineOf(raw.headline);
	const stage = line(raw.stage);
	const blocks: WireJobWidgetBlock[] = [];
	for (const rawBlock of recordsOf(raw.blocks, JOB_WIDGET_BLOCKS)) {
		const block = blockOf(rawBlock);
		if (block) blocks.push(block);
	}
	return {
		title: line(raw.title),
		...(headline ? { headline } : {}),
		...(stage !== "" ? { stage } : {}),
		blocks,
		state: (typeof raw.state === "string" ? STATES[raw.state] : undefined) ?? "fallback",
		updatedAt: finite(raw.updatedAt) ?? 0,
	};
}

/**
 * The view cut to what a list row shows: title, headline, stage and state, plus
 * the primary spark (its newest {@link JOB_WIDGET_GLANCE_POINTS} values, without
 * tips or reference lines) and the first meter, in their order. Reading a
 * glance (`jobWidgetGlance`, `jobWidgetSpark`) of this gives what the whole view
 * gives, at a fraction of the bytes.
 */
export function glanceJobWidgetView(view: WireJobWidgetView): WireJobWidgetView {
	const blocks: WireJobWidgetBlock[] = [];
	let spark = false;
	let meter = false;
	for (const block of view.blocks) {
		if (block.kind === "spark" && !spark && block.values.length > 0) {
			spark = true;
			const { tips: _tips, marks: _marks, ...rest } = block;
			blocks.push({ ...rest, values: block.values.slice(-JOB_WIDGET_GLANCE_POINTS) });
		} else if (block.kind === "meter" && !meter) {
			meter = true;
			blocks.push(block);
		}
	}
	return { ...view, blocks };
}
