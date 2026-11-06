import { createSignal } from "solid-js";
import type { ShellVizDto } from "#lib/wire/protocol";
import { state } from "../state";
import { call } from "./transport";

/**
 * The bash card's shell visualization. The browser frames never carry a bash result's shell
 * trace (up to MBs); `getShellVisualization` (read-only) answers the session's own rendering of
 * one call on demand, so a card fetches only when its Visualize body is opened, and a replay
 * step is another call with a cursor. An answer is stamped with the workspace it was asked of
 * and dropped when the attached workspace changed meanwhile. A settled call the session reports
 * unavailable hides its Visualize control for the rest of the page (the answer does not change).
 */

/** Calls remembered as having no visualization; the oldest go first. */
const UNAVAILABLE_LIMIT = 500;

const [unavailable, setUnavailable] = createSignal<ReadonlySet<string>>(new Set());

/** Identity of one call's visualization: workspace, owning subagent (empty for the session's own call) and call id. */
export const shellVizKey = (toolCallId: string, subagentId?: string): string =>
	`${state.currentWorkspaceId}\n${subagentId ?? ""}\n${toolCallId}`;

/** The session answered that this settled call has no visualization. */
export const shellVizUnavailable = (key: string): boolean => unavailable().has(key);

/** Remember that `key` has no visualization, so its card stops offering one. */
export function rememberShellVizUnavailable(key: string): void {
	setUnavailable((previous) => {
		if (previous.has(key)) return previous;
		const next = new Set(previous).add(key);
		const oldest = next.values().next();
		if (next.size > UNAVAILABLE_LIMIT && !oldest.done) next.delete(oldest.value);
		return next;
	});
}

/** Forget every remembered miss (the design system re-seeds each story variant from scratch). */
export function forgetShellVizUnavailable(): void {
	setUnavailable(new Set<string>());
}

/**
 * Ask the session for a call's visualization (`cursor` replays the first N history records).
 * Resolves null when the attached workspace changed meanwhile; rejects with the transport error
 * when the call could not be made.
 */
export async function fetchShellViz(
	toolCallId: string,
	subagentId: string | undefined,
	cursor?: number,
): Promise<ShellVizDto | null> {
	const workspaceId = state.currentWorkspaceId;
	const answer = (await call("getShellVisualization", [
		{
			toolCallId,
			...(subagentId === undefined ? {} : { subagentId }),
			...(cursor === undefined ? {} : { cursor }),
		},
	])) as ShellVizDto;
	return workspaceId === state.currentWorkspaceId ? answer : null;
}
