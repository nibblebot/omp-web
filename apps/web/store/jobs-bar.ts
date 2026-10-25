import { createSignal } from "solid-js";
import { state } from "../state";

/**
 * What the composer jobs bar shows: the running jobs while any run, then a quiet "finished" note so the
 * sheet (and the recent jobs it lists) stays reachable after the last one ends.
 *
 * The daemon's `job_widgets` frames carry only the running count, which says when the last job ended but
 * not how many ran (a job that starts and ends between two frames is never seen), so the note names no
 * count. It lingers for {@link JOBS_FINISHED_LINGER_MS}, then the bar hides.
 *
 * The episode belongs to the attached session: an answer or timer for another session never shows, and
 * an attach starts over (`resetJobsBar`, from `clearJobWidgets`).
 */

/**
 * How long the bar keeps pointing at finished jobs. The SDK drops a settled job row 30 s after its result
 * was delivered (`CONSUMED_RESULT_EVICTION_MS` in pi-coding-agent `async/job-manager.ts`, the normal case
 * for a background job); a result nobody consumed keeps its row up to `DEFAULT_RETENTION_MS` (5 min) in
 * that file. The shorter window keeps the bar from advertising a sheet that has already emptied.
 */
export const JOBS_FINISHED_LINGER_MS = 30_000;

/** What the bar draws; undefined hides it. */
export type JobsBarView = { phase: "running"; running: number } | { phase: "finished" };

interface Episode {
	sessionId: string;
	/** Running count of the last frame. */
	running: number;
}

let episode: Episode | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The session whose finished note is lingering. */
const [lingering, setLingering] = createSignal<string | undefined>(undefined);

function stopLinger(): void {
	clearTimeout(timer);
	timer = undefined;
	setLingering(undefined);
}

/** Forget the episode and any lingering note (an attach: the priming says what runs now). */
export function resetJobsBar(): void {
	episode = undefined;
	stopLinger();
}

/** Feed the running count of a `job_widgets` frame for the attached session. */
export function observeRunningJobs(running: number): void {
	const sessionId = state.currentSessionId;
	if (episode?.sessionId !== sessionId) {
		stopLinger();
		episode = { sessionId, running: 0 };
	}
	const current = episode;
	if (running > 0) {
		// A new episode: the old note, if any, is superseded.
		if (current.running === 0) stopLinger();
		current.running = running;
		return;
	}
	const ended = current.running;
	current.running = 0;
	if (ended === 0) return;
	clearTimeout(timer);
	setLingering(sessionId);
	timer = setTimeout(() => {
		timer = undefined;
		setLingering(undefined);
	}, JOBS_FINISHED_LINGER_MS);
}

/** The bar's present view: running jobs, else the finished note of the attached session, else nothing. */
export function jobsBarView(): JobsBarView | undefined {
	const running = state.jobWidgets.running;
	if (running > 0) return { phase: "running", running };
	const note = lingering();
	if (note === undefined || note !== state.currentSessionId) return undefined;
	return { phase: "finished" };
}
