import type { WireJobWidgetEntry } from "#lib/wire/protocol";

/** The attached session's running background jobs, as the session's `job_widgets` frames report them. */
export interface JobWidgetsState {
	/** How many background jobs run (a subagent's task job counts with the agents). */
	running: number;
	/** Glances of the widgets of the running jobs, task jobs included (a subagent's job has the agent's id). */
	entries: WireJobWidgetEntry[];
}

/** Before the session reports anything, no job runs. */
export function createJobWidgetsState(): JobWidgetsState {
	return { running: 0, entries: [] };
}
