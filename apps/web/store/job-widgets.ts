import type { WireJobWidgetView } from "#lib/wire/protocol";
import { setState, state } from "../state";
import { observeRunningJobs, resetJobsBar } from "./jobs-bar";
import { createJobWidgetsState, type JobWidgetsState } from "./slices/job-widgets";

/**
 * The attached session's running background jobs and their widget glances (the SDK's job widgets), kept from
 * the session's `job_widgets` frames. Each frame is the whole current set, so applying one replaces the set
 * and a job that settled is gone. The set belongs to the attachment: `state.ts` drops it on every attach (the
 * priming re-sends it) and ignores frames stamped for a session the tab no longer views, so nothing of a
 * session left behind shows.
 */

/** Replace the set with the session's snapshot (never `reconcile`: it leaves a hole where a shrunk list lost entries). */
export function applyJobWidgets(snapshot: JobWidgetsState): void {
	setState("jobWidgets", { running: snapshot.running, entries: [...snapshot.entries] });
	observeRunningJobs(snapshot.running);
}

/** Forget every job (an attach: the priming says what runs now). */
export function clearJobWidgets(): void {
	setState("jobWidgets", createJobWidgetsState());
	resetJobsBar();
}

/** The glance of the widget of job `id` (a subagent's task job has the agent's id), or undefined while it has none. */
export function jobWidgetView(id: string): WireJobWidgetView | undefined {
	return state.jobWidgets.entries.find((entry) => entry.id === id)?.view;
}
