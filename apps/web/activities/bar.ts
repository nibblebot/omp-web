/**
 * What the ActivityBar and its popovers show, as pure reads over the summaries
 * (summary.ts): which buttons exist and what they say, the status text on the
 * left, how a popover caps its rows, and what a button press does.
 */
import type { WebSessionState } from "#lib/wire/protocol";
import { isActivitiesOpen, focusSection, type ActivitySectionId } from "../store/activities";
import { state } from "../state";
import {
	daemonsSummary,
	jobsSummary,
	subagentsSummary,
	todosSummary,
	type ActivitySummary,
	type TodoSummary,
} from "./summary";

/** Rows a popover lists before it points at the panel with "+N more". */
export const POPOVER_MAX_ROWS = 8;

export interface ActivityButtonModel {
	section: ActivitySectionId;
	/** Section name, also the button's tooltip. */
	label: string;
	/** Count shown on the button; empty while nothing is active (Todo: `done/total`). */
	badge: string;
	/** Everything listed is settled. */
	muted: boolean;
	/** Spoken name: the section and its counts. */
	ariaLabel: string;
}

export interface ActivitySummaries {
	subagents: ActivitySummary;
	jobs: ActivitySummary;
	daemons: ActivitySummary;
	todos: TodoSummary;
}

/** Live summaries of the attached workspace; reactive when called in a tracking scope. */
export function currentSummaries(): ActivitySummaries {
	return {
		subagents: subagentsSummary(),
		jobs: jobsSummary(),
		daemons: daemonsSummary(),
		todos: todosSummary(),
	};
}

function counted(
	section: Exclude<ActivitySectionId, "todos">,
	label: string,
	summary: ActivitySummary,
): ActivityButtonModel | undefined {
	if (summary.total === 0) return undefined;
	return {
		section,
		label,
		badge: summary.active > 0 ? String(summary.active) : "",
		muted: summary.settled,
		ariaLabel: `${label}: ${summary.active} active of ${summary.total}`,
	};
}

/**
 * The buttons in display order: Subagents, Jobs, Daemons, Todo. A section with
 * nothing listed (finished items count) has no button.
 */
export function activityButtons(summaries: ActivitySummaries): ActivityButtonModel[] {
	const { todos } = summaries;
	const buttons = [
		counted("subagents", "Subagents", summaries.subagents),
		counted("jobs", "Jobs", summaries.jobs),
		counted("daemons", "Daemons", summaries.daemons),
		todos.total === 0
			? undefined
			: {
					section: "todos" as const,
					label: "Todo",
					badge: `${todos.done}/${todos.total}`,
					muted: todos.settled,
					ariaLabel: `Todo: ${todos.done} of ${todos.total} done`,
				},
	];
	return buttons.filter((button) => button !== undefined);
}

/** The bar's left text: compaction wins over the turn's working intent; empty while idle. */
export function activityStatusText(): { kind: "compacting" | "working" | "idle"; text: string } {
	if (state.compacting) return { kind: "compacting", text: "Compacting context…" };
	if (state.streaming) return { kind: "working", text: state.workingIntent ?? "Working…" };
	return { kind: "idle", text: "" };
}

/** The rows a popover lists, and how many more the panel holds. */
export function capRows<T>(
	rows: readonly T[],
	max: number = POPOVER_MAX_ROWS,
): { shown: readonly T[]; more: number } {
	return { shown: rows.slice(0, max), more: Math.max(0, rows.length - max) };
}

/** The first `max` tasks across the phases, in order (a phase left with no task is dropped), and how many tasks follow. */
export function capTodoTasks(
	phases: WebSessionState["todoPhases"],
	max: number = POPOVER_MAX_ROWS,
): { shown: WebSessionState["todoPhases"]; more: number } {
	let left = max;
	const shown: WebSessionState["todoPhases"] = [];
	let total = 0;
	for (const phase of phases) {
		total += phase.tasks.length;
		if (left <= 0) continue;
		shown.push({ ...phase, tasks: phase.tasks.slice(0, left) });
		left -= phase.tasks.length;
	}
	return { shown, more: Math.max(0, total - max) };
}

/** Active rows first so the cap never hides what is running; each group keeps its order. */
export function activeFirst<T>(rows: readonly T[], isActive: (row: T) => boolean): T[] {
	return [...rows.filter(isActive), ...rows.filter((row) => !isActive(row))];
}

/**
 * A button press. While the Activities panel is open the button expands and scrolls
 * to its section there (`"focused"`); otherwise the caller toggles the popover (`"popover"`).
 */
export function pressActivityButton(section: ActivitySectionId): "focused" | "popover" {
	if (!isActivitiesOpen()) return "popover";
	focusSection(section);
	return "focused";
}
