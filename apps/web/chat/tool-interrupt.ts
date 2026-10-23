import type { ChatItem, ToolItem, ToolStatus } from "../state";

/**
 * Tool-status classification shared by the live event path (store/chat.ts), the
 * history builder (main replay and subagent transcripts), and idle settling.
 * Pure: no store access.
 */

/**
 * A result the harness fabricated or an interrupt left behind: `__synthetic`
 * (any `source`) or `__interrupted` on the result details. Such a call did not
 * run to a real outcome, so it reads as interrupted rather than done/error.
 */
export function isInterruptMarker(details: unknown): boolean {
	if (details === null || typeof details !== "object") return false;
	const marks = details as { __synthetic?: unknown; __interrupted?: unknown };
	return marks.__synthetic === true || marks.__interrupted === true;
}

/** Status of a settled tool result: a marker wins over the error flag. */
export function toolResultStatus(isError: boolean | undefined, details: unknown): ToolStatus {
	if (isInterruptMarker(details)) return "interrupted";
	return isError === true ? "error" : "done";
}

/**
 * Whether an aborted assistant message relabels this tool item: a call still
 * running, or one that settled `error` without a marker (the user's Esc made
 * the tool fail). `done` stays done; marked items are already interrupted.
 */
export function isAbortRelabelable(item: ToolItem): boolean {
	return item.status === "running" || item.status === "error";
}

/**
 * Tool items an aborted assistant message interrupts, given the transcript
 * that precedes it: the tool items of the closest earlier assistant that made
 * calls (they sit right after that assistant's item). A user prompt bounds the
 * turn: a fresh turn aborted before any call must not touch the previous turn.
 */
export function abortedTools(items: readonly ChatItem[]): ToolItem[] {
	const group: ToolItem[] = [];
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item === undefined || item.kind === "user") break;
		if (item.kind === "tool") group.push(item);
		else if (item.kind === "assistant" && group.length > 0) break;
	}
	return group.filter(isAbortRelabelable);
}
