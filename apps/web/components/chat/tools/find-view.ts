/**
 * Parser for the SDK `find` tool's result `details` (pi-tui tools/find.ts
 * `FindToolDetails`; pi-coding-agent tools/jfind/index.ts builds them). The
 * semantic search returns ranked hits, each a file with its strongest verified
 * line ranges, plus search accounting. When its 20 s budget runs out the call
 * still settles with the hits verified so far and `details.timeout`
 * (`{ verified, passages }`): the card flags those results as partial.
 *
 * Everything here is untrusted JSON: a field of the wrong type is dropped, a
 * hit without a path is skipped, and details that are not a find result at all
 * yield null so the card shows the raw output text instead. Pure, so the
 * parsing stays testable without a DOM.
 */
import { isRecord } from "#lib/wire/type-guards";
import { formatCost, formatDuration, formatTokens } from "../../../subagents/format";

/** A verified line range with its yes-probability and a preview of the lines. */
export interface FindRange {
	start: number;
	end: number;
	/** Probability the range answers the query, 0 to 1. */
	p: number;
	snippet: string;
}

/** A file (or internal URL) whose verified passages cleared the threshold. */
export interface FindHit {
	/** Display path, relative to the session cwd, or an internal URL under a URL scope. */
	path: string;
	/** Best verified passage probability, 0 to 1. */
	score: number;
	/** Lines of content judged, when reported. */
	linesSeen: number | undefined;
	/** The file held more lines than were judged. */
	truncated: boolean;
	/** Strongest first. */
	ranges: FindRange[];
}

/** Verification cut short by the call's deadline: complete passages verified of those routed to it. */
export interface FindTimeout {
	verified: number;
	passages: number;
}

/** How much of the search the judge covered. `unavailable`: nothing was judged, so no hits is not evidence of absence. */
export type FindCoverage = "complete" | "partial" | "unavailable";

/** A settled find result, parsed. */
export interface FindView {
	query: string | undefined;
	/** Searched directory or file, when narrower than the session cwd. */
	scope: string | undefined;
	/** Lexical keywords the search actually used. */
	keywords: string[];
	/** Probability at or above which a passage is a hit. */
	threshold: number | undefined;
	hits: FindHit[];
	coverage: FindCoverage | undefined;
	/** Set when the deadline ended verification; `hits` are those verified before it. */
	timeout: FindTimeout | undefined;
	filesRead: number | undefined;
	requests: number | undefined;
	/** Judge requests that failed outright. */
	failed: number;
	/** Distinct request failures, phase-prefixed. */
	failures: string[];
	inputTokens: number | undefined;
	cost: number | undefined;
	elapsedMs: number | undefined;
}

/** What the call asked for, from its arguments (known while the call runs). */
export interface FindCall {
	query: string | undefined;
	keywords: string[];
	path: string | undefined;
}

/** Score at or above which a hit is strong; at or above `PLAUSIBLE`, plausible; lower is weak (the TUI's gauge colors). */
const STRONG = 0.7;
const PLAUSIBLE = 0.4;

export type FindScoreTone = "strong" | "plausible" | "weak";

export function scoreTone(score: number): FindScoreTone {
	return score >= STRONG ? "strong" : score >= PLAUSIBLE ? "plausible" : "weak";
}

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const count = (value: unknown): number | undefined => {
	const n = num(value);
	return n !== undefined && n >= 0 ? n : undefined;
};
const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string" && v.length > 0)
		: [];

/** The call's query, grep keywords and scope path. Missing or mistyped arguments come back empty. */
export function findCallOf(args: unknown): FindCall {
	const a = isRecord(args) ? args : {};
	return { query: str(a.query), keywords: strings(a.grep_keywords), path: str(a.path) };
}

function parseRange(raw: unknown): FindRange | null {
	if (!isRecord(raw)) return null;
	const start = num(raw.start);
	if (start === undefined) return null;
	const end = num(raw.end) ?? start;
	return {
		start,
		end: Math.max(start, end),
		p: clampUnit(num(raw.p) ?? 0),
		snippet: typeof raw.snippet === "string" ? raw.snippet : "",
	};
}

const clampUnit = (n: number): number => Math.min(1, Math.max(0, n));

function parseHit(raw: unknown): FindHit | null {
	if (!isRecord(raw)) return null;
	const path = str(raw.rel);
	if (path === undefined) return null;
	const ranges = (Array.isArray(raw.ranges) ? raw.ranges : [])
		.map(parseRange)
		.filter((range): range is FindRange => range !== null)
		.sort((a, b) => b.p - a.p || a.start - b.start);
	return {
		path,
		score: clampUnit(num(raw.contentScore) ?? ranges[0]?.p ?? 0),
		linesSeen: count(raw.linesSeen),
		truncated: raw.truncated === true,
		ranges,
	};
}

/** `details.timeout`, or undefined when absent or not two counts. */
export function parseFindTimeout(raw: unknown): FindTimeout | undefined {
	if (!isRecord(raw)) return undefined;
	const verified = count(raw.verified);
	const passages = count(raw.passages);
	return verified === undefined || passages === undefined ? undefined : { verified, passages };
}

/** The `N of M verified` half of the timed-out marker. */
export function timeoutProgress(timeout: FindTimeout): string {
	return `${timeout.verified} of ${timeout.passages} verified`;
}

const COVERAGES: readonly FindCoverage[] = ["complete", "partial", "unavailable"];

/** Parse a settled call's `details`; null when it is not a find result (no `hits` array), so the card falls back to the output text. */
export function parseFindDetails(details: unknown): FindView | null {
	if (!isRecord(details) || !Array.isArray(details.hits)) return null;
	const stats = isRecord(details.stats) ? details.stats : {};
	return {
		query: str(details.query),
		scope: str(details.scopePath),
		keywords: strings(details.keywords),
		threshold: num(details.threshold),
		hits: details.hits.map(parseHit).filter((hit): hit is FindHit => hit !== null),
		coverage: COVERAGES.find((c) => c === details.coverage),
		timeout: parseFindTimeout(details.timeout),
		filesRead: count(stats.filesRead),
		requests: count(stats.requests),
		failed: count(stats.failed) ?? 0,
		failures: strings(stats.failures),
		inputTokens: count(stats.inputTokens),
		cost: count(stats.cost),
		elapsedMs: count(details.elapsedMs),
	};
}

/** `12-18`, or `12` for a one-line range. */
export const rangeLabel = (range: FindRange): string =>
	range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;

/** `12 lines judged` / `12 lines judged, partial`; undefined when the count is unknown. */
export function judgedLabel(hit: FindHit): string | undefined {
	if (hit.linesSeen === undefined) return undefined;
	return hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
}

/** The search accounting as one quiet line: files read, threshold, tokens, cost, wall time; unknown parts are left out. */
export function accountingLine(view: FindView): string {
	return [
		view.filesRead !== undefined && `${view.filesRead} files read`,
		view.threshold !== undefined && `\u03c4 ${view.threshold.toFixed(2)}`,
		view.inputTokens !== undefined && `${formatTokens(view.inputTokens)} tokens`,
		view.cost !== undefined && formatCost(view.cost),
		view.elapsedMs !== undefined && formatDuration(view.elapsedMs),
	]
		.filter((part): part is string => part !== false)
		.join(" \u00b7 ");
}
