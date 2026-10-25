import { glanceJobWidgetView } from "#lib/wire/job-widget";
import type { WireJobWidgetEntry, WireJobWidgetView } from "#lib/wire/protocol";
import { applyJobWidgets } from "../../web/store/job-widgets";
import { authoringWidget, benchWidget, subagentWidget } from "./job-widgets";

/** The running agent of the subagent fixtures, whose task job shares its id. */
export const WIDGET_AGENT_ID = "FixtureBuilder";

/** A running job's widget as the daemon's `job_widgets` frame carries it: cut to a glance. */
const entry = (id: string, type: string, view: WireJobWidgetView): WireJobWidgetEntry => ({
	id,
	type,
	view: glanceJobWidgetView(view),
});

/** A benchmark command job with its spec-driven widget: headline, trend and a mini chart. */
export const benchEntry = (updatedAt = benchWidget.updatedAt): WireJobWidgetEntry =>
	entry("bg_1", "bash", { ...benchWidget, updatedAt });

/** The running agent's task job: a headline figure and a meter of its own progress. */
export const agentEntry = (updatedAt = subagentWidget.updatedAt): WireJobWidgetEntry =>
	entry(WIDGET_AGENT_ID, "task", { ...subagentWidget, updatedAt });

/** A dev server whose widget spec is still being written: no figure yet, so a glance says so. */
export const authoringEntry = (): WireJobWidgetEntry => entry("bg_2", "bash", authoringWidget);

/** What the daemon's `job_widgets` snapshot leaves in the store, through the real action. */
export function seedJobWidgets(running: number, entries: readonly WireJobWidgetEntry[]): void {
	applyJobWidgets({ running, entries: [...entries] });
}

/** The last of `count` jobs just ended: the snapshots a session sends as the bar drops to its finished note. */
export function seedFinishedJobs(count: number): void {
	seedJobWidgets(count, [benchEntry()]);
	applyJobWidgets({ running: 0, entries: [] });
}
