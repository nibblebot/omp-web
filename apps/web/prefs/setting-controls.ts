import type { SettingsItem, SettingsOption } from "#lib/wire/protocol";

/**
 * Control selection and value logic for settings rows. Pure functions over the
 * wire model so the row components stay thin views and this stays unit-testable.
 */

export type ControlKind =
	| "toggle"
	| "segmented"
	| "select"
	| "stepper"
	| "number"
	| "text"
	| "secret"
	| "orderedList"
	| "providerLimits"
	| "json";

/** Longest option label a segmented control may carry before a select pill reads better. */
const SEGMENT_LABEL_MAX = 14;
const SEGMENT_OPTIONS_MAX = 3;

/** Numeric value an option stands for (`default` is the stored -1 sentinel); undefined when not numeric. */
export function numericOptionValue(value: string): number | undefined {
	if (value === "default") return -1;
	const n = Number(value);
	return value.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/** Options of a submenu or enum item as option objects (enums carry bare values). */
export function itemOptions(item: SettingsItem): SettingsOption[] {
	if (item.options) return item.options;
	return (item.values ?? []).map((value) => ({ value, label: value }));
}

/** Which control a row shows. Wire types never change; the choice is derived from type, option shape and value. */
export function controlKind(item: SettingsItem): ControlKind {
	switch (item.type) {
		case "boolean":
			return "toggle";
		case "enum": {
			const options = itemOptions(item);
			const short = options.every((o) => o.label.length <= SEGMENT_LABEL_MAX);
			return options.length >= 2 && options.length <= SEGMENT_OPTIONS_MAX && short
				? "segmented"
				: "select";
		}
		case "submenu": {
			const options = item.options ?? [];
			const numeric =
				options.length >= 2 && options.every((o) => numericOptionValue(o.value) !== undefined);
			return numeric ? "stepper" : "select";
		}
		case "text":
			if (item.secret) return "secret";
			// Advanced numeric rows arrive as text; the value type says they are numbers.
			return typeof item.value === "number" ? "number" : "text";
		case "multiselect":
			return "orderedList";
		case "providerLimits":
			return "providerLimits";
		case "record":
		case "list":
			return "json";
	}
}

/** Value as a record for provider limits and other object-valued rows; anything else reads as empty. */
export function asRecord(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

// ---------------------------------------------------------------------------
// Option stepper (numeric submenus): steps through the option list.
// ---------------------------------------------------------------------------

export interface OptionStep {
	/** Text shown between the buttons: the matching option's label, or the raw value when unlisted. */
	text: string;
	/** Option the minus button selects; undefined when there is none. */
	previous?: SettingsOption;
	/** Option the plus button selects; undefined when there is none. */
	next?: SettingsOption;
}

/**
 * Position of a numeric value among the options. A value matches an option
 * numerically (`0.9` is the option `0.90`; -1 is `default`). A value between
 * options (set by hand in config.yml) steps to the nearest option on each side.
 */
export function optionStep(options: SettingsOption[], current: number): OptionStep {
	const index = options.findIndex((o) => numericOptionValue(o.value) === current);
	if (index >= 0) {
		return { text: options[index]!.label, previous: options[index - 1], next: options[index + 1] };
	}
	let previous: SettingsOption | undefined;
	let next: SettingsOption | undefined;
	for (const option of options) {
		const n = numericOptionValue(option.value);
		if (n === undefined || n === -1) continue;
		if (n < current && (!previous || n > numericOptionValue(previous.value)!)) previous = option;
		if (n > current && (!next || n < numericOptionValue(next.value)!)) next = option;
	}
	return { text: String(current), previous, next };
}

// ---------------------------------------------------------------------------
// Typed number (text rows holding a number).
// ---------------------------------------------------------------------------

const UNIT_SUFFIXES: ReadonlyArray<[RegExp, string]> = [
	[/Ms$/, "ms"],
	[/(Sec|Seconds)$/, "s"],
	[/Minutes$/, "min"],
	[/Hours$/, "h"],
	[/Lines$/, "lines"],
];

/** Unit shown after a typed number, inferred from the path suffix (`mcp.startupTimeoutMs` is ms). */
export function numberUnit(path: string): string | undefined {
	const last = path.split(".").at(-1) ?? path;
	return UNIT_SUFFIXES.find(([pattern]) => pattern.test(last))?.[1];
}

/** Parse a typed number. Empty or non-finite input is rejected so a half-typed value never reaches config. */
export function parseNumberInput(raw: string): number | undefined {
	if (raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Next value for a typed number stepper. Fractions step by 0.1 without float
 * drift. Integers step by a tenth of their order of magnitude, snapped to
 * round values: 5 moves by 1, 420000 (ms) by 10000 to 430000 or 410000.
 */
export function stepNumber(current: number, direction: -1 | 1): number {
	if (!Number.isInteger(current)) return Math.round((current + direction * 0.1) * 1e6) / 1e6;
	const step = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(current))) - 1);
	if (step === 1) return current + direction;
	return direction > 0
		? (Math.floor(current / step) + 1) * step
		: (Math.ceil(current / step) - 1) * step;
}

// ---------------------------------------------------------------------------
// Ordered list editor (compaction.methodOrder, ordered multiselects).
// ---------------------------------------------------------------------------

export interface OrderedRow {
	option: SettingsOption;
	/** Position in the stored order when enabled; undefined when off. */
	rank?: number;
}

/** Rows in display order: enabled entries in stored order, then the remaining options in declared order. */
export function orderedRows(options: SettingsOption[], selected: string[]): OrderedRow[] {
	const byValue = new Map(options.map((o) => [o.value, o]));
	const rows: OrderedRow[] = [];
	selected.forEach((value, index) => {
		const option = byValue.get(value);
		if (option) rows.push({ option, rank: index });
	});
	for (const option of options) {
		if (!selected.includes(option.value)) rows.push({ option });
	}
	return rows;
}

/** Move one enabled entry by `direction` within the stored order; the list is returned unchanged at an edge. */
export function moveSelected(selected: string[], value: string, direction: -1 | 1): string[] {
	const from = selected.indexOf(value);
	const to = from + direction;
	if (from < 0 || to < 0 || to >= selected.length) return selected;
	const next = [...selected];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}

/** Enable an entry (appended last) or disable it (removed, others keep their order). */
export function toggleSelected(selected: string[], value: string): string[] {
	if (selected.includes(value)) return selected.filter((v) => v !== value);
	return [...selected, value];
}

// ---------------------------------------------------------------------------
// JSON field (records and lists).
// ---------------------------------------------------------------------------

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse a JSON field draft, requiring the shape the row holds (array for lists, object for records). */
export function parseJsonDraft(raw: string, type: "list" | "record"): JsonParse {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (type === "list") {
		return Array.isArray(value)
			? { ok: true, value }
			: { ok: false, error: "Expected a JSON list" };
	}
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? { ok: true, value }
		: { ok: false, error: "Expected a JSON object" };
}

// ---------------------------------------------------------------------------
// Provider limits (providers.maxInFlightRequests).
// ---------------------------------------------------------------------------

/** Provider limits record after one provider's input changes; an empty input removes that provider's limit. */
export function applyProviderLimit(
	current: Record<string, unknown>,
	provider: string,
	raw: string,
): Record<string, unknown> {
	const next = { ...current };
	const n = parseNumberInput(raw);
	if (raw.trim() === "") delete next[provider];
	else next[provider] = n ?? raw;
	return next;
}
