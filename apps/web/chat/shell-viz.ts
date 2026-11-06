import type { ToolItem } from "../state";
import type { ShellVizDto, ShellVizRowDto, ShellVizSegmentDto } from "#lib/wire/protocol";

/** The answer of an available visualization. */
export type ShellVizView = Extract<ShellVizDto, { available: true }>;

/** Which rendering the view shows. */
export type ShellVizMode = "pseudo" | "raw";

/** Run time as the replay clock reads it: ns up to a second shown in ms, longer in seconds. */
export function formatShellVizTime(ns: number): string {
	if (!(ns > 0)) return "0 ms";
	const ms = ns / 1_000_000;
	if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
	if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** The replay position as a label: "step 12 of 65 · 3.4 ms of 31 ms". */
export function shellVizTimelineLabel(timeline: ShellVizView["timeline"]): string {
	return `Step ${timeline.cursor} of ${timeline.length} · ${formatShellVizTime(timeline.elapsedNs)} of ${formatShellVizTime(timeline.durationNs)}`;
}

/** The replay scrubber shows only for a finished run with something to step through. */
export const shellVizReplayable = (view: ShellVizView): boolean =>
	!view.running && view.timeline.length > 1;

/** The rows of the chosen rendering. */
export const shellVizRows = (view: ShellVizView, mode: ShellVizMode): ShellVizRowDto[] =>
	view[mode];

/** Rows the answer left out of the chosen rendering to fit; 0 when nothing was cut. */
export const shellVizOmitted = (view: ShellVizView, mode: ShellVizMode): number =>
	view.omittedRows?.[mode] ?? 0;

/** A row's runs as plain text, for the accessible name of a row and for copying. */
export const shellVizRowText = (row: ShellVizRowDto): string =>
	row.segments.map((segment: ShellVizSegmentDto) => segment.text).join("");

/** The note under a view that is not available: what to tell the user. */
export function shellVizUnavailableNote(
	reason: Extract<ShellVizDto, { available: false }>["reason"],
): string {
	switch (reason) {
		case "unknown_call":
			return "This call's execution trace is not available.";
		case "no_trace":
			return "This command ran without an execution trace.";
		case "invalid_trace":
			return "The execution trace could not be rendered.";
	}
}

/**
 * Whether a bash card can have a visualization to offer: the call is running (its updates carry no
 * details, and the session answers from the latest partial trace), or its settled result carries the
 * `details.shellTrace` marker the session leaves where it dropped the trace (SDK 18.17.0 and later;
 * a result from an older session, or one with no trace, has none).
 */
export function shellVizOffered(item: ToolItem): boolean {
	if (item.status === "running") return true;
	const details = item.details;
	return (
		typeof details === "object" &&
		details !== null &&
		"shellTrace" in details &&
		details.shellTrace === true
	);
}
