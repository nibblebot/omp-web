import { createSignal } from "solid-js";
import type { JobTreeDto, JobTreeRowDto } from "#lib/wire/protocol";
import { connectionState, state } from "../state";
import { call } from "./transport";

/**
 * The one `getJobTree` poll of the web. Every job surface (the Activities bar, popovers and panel, the
 * jobs sheet, the background-card reconcile) reads this snapshot; none calls `getJobTree` itself.
 *
 * The `job_widgets` frame carries only the running count and widget glances, not the tree, and the SDK
 * announces no job status changes, so the tree is polled. `getJobTree` is a read-only call that never
 * triggers a state broadcast: a poll costs one small answer.
 *
 * It runs only while a workspace is attached and connected and the page is visible (a tab nobody looks at
 * asks nothing). Period: {@link JOB_POLL_FOCUSED_MS} while any consumer holds focus (a surface showing the
 * list is open), else {@link JOB_POLL_IDLE_MS}. A `job_widgets` frame that changes the running count polls
 * at once (a job started or ended), and so does the page becoming visible. Calls never overlap: a poll in
 * flight is joined. Every answer is stamped with the workspace asked and dropped when the attached
 * workspace changed meanwhile, as in `store/plugins.ts`.
 *
 * Imperative on purpose: no module-level effect (the store has no owner, and a test runs against the
 * non-reactive Solid build). The hooks below are called where the inputs change: `jobPollAttached` from the
 * attach reset (`store/job-widgets.ts`), `jobPollRunningChanged` from `applyJobWidgets`, the visibility
 * listener here, `acquireJobPollFocus`/release.
 */

/** Poll period while a consumer holds focus. */
export const JOB_POLL_FOCUSED_MS = 2000;
/** Poll period with no focus holder: enough for the bar's counts and the settle of background cards. */
export const JOB_POLL_IDLE_MS = 10_000;

export type JobPollView =
	| { phase: "idle" }
	| { phase: "loading" }
	| { phase: "unavailable" }
	| { phase: "ready"; tree: JobTreeDto; at: number };

interface Answer {
	workspaceId: string;
	/** Null when the workspace's session has no async job manager. */
	tree: JobTreeDto | null;
	at: number;
}

const [answer, setAnswer] = createSignal<Answer | undefined>(undefined);
const [failure, setFailure] = createSignal<{ workspaceId: string; message: string } | undefined>(
	undefined,
);

const NO_ROWS: readonly JobTreeRowDto[] = [];

/**
 * What the shared poll knows: `idle` with no workspace attached, `loading` until the attached workspace's
 * first answer, `unavailable` when its session runs no async jobs, else `ready`. An answer of another
 * workspace never shows. Reactive.
 */
export function jobPollView(): JobPollView {
	const workspaceId = state.currentWorkspaceId;
	if (workspaceId === "") return { phase: "idle" };
	const current = answer();
	if (current === undefined || current.workspaceId !== workspaceId) return { phase: "loading" };
	if (current.tree === null) return { phase: "unavailable" };
	return { phase: "ready", tree: current.tree, at: current.at };
}

/** The tree's rows in display order; empty unless the view is `ready`. Reactive. */
export function jobTreeRows(): readonly JobTreeRowDto[] {
	const view = jobPollView();
	return view.phase === "ready" ? view.tree.rows : NO_ROWS;
}

/** Why the last poll failed (a lost connection); null once a poll succeeds or the workspace changes. Reactive. */
export function jobPollError(): string | null {
	const current = failure();
	return current?.workspaceId === state.currentWorkspaceId ? current.message : null;
}

/** Called after each answer kept for the attached workspace; the poll resolves once every listener settled. */
export type JobTreeListener = (poll: number) => void | Promise<void>;
const listeners = new Set<JobTreeListener>();

/**
 * Observe the answers (for a consumer that derives work from each one, such as the sheet's selected-job
 * detail). `poll` is the ordinal of the poll that produced the answer, comparable to {@link jobPollCount}
 * read earlier: a larger one started later. Returns the unsubscribe.
 */
export function onJobTreeAnswer(listener: JobTreeListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

let started = 0;
/** Polls started so far. */
export const jobPollCount = (): number => started;

interface Flight {
	workspaceId: string;
	done: Promise<void>;
}
let flight: Flight | undefined;
/** When the last poll for `workspaceId` finished (answer or failure); paces the next one. */
let polled: { workspaceId: string; at: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let holders = 0;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A workspace is attached and its connection is up. */
const attached = (): boolean =>
	state.currentWorkspaceId !== "" && connectionState() === "connected";
const visible = (): boolean =>
	typeof document === "undefined" || document.visibilityState === "visible";
const interval = (): number => (holders > 0 ? JOB_POLL_FOCUSED_MS : JOB_POLL_IDLE_MS);

/** Ask for the tree now, joining a call in flight for the attached workspace; a no-op with no workspace. */
function poll(): Promise<void> {
	const workspaceId = state.currentWorkspaceId;
	if (workspaceId === "") return Promise.resolve();
	if (flight?.workspaceId === workspaceId) return flight.done;
	const ordinal = ++started;
	const mine: Flight = { workspaceId, done: Promise.resolve() };
	flight = mine;
	mine.done = (async () => {
		try {
			const tree = (await call("getJobTree", [])) as JobTreeDto | null;
			if (workspaceId !== state.currentWorkspaceId) return;
			setAnswer({ workspaceId, tree, at: Date.now() });
			setFailure(undefined);
			await Promise.all([...listeners].map((listener) => listener(ordinal)));
		} catch (err) {
			if (workspaceId === state.currentWorkspaceId)
				setFailure({ workspaceId, message: message(err) });
		} finally {
			if (flight === mine) flight = undefined;
			// A call of a workspace left behind paces and re-arms nothing.
			if (workspaceId === state.currentWorkspaceId) {
				polled = { workspaceId, at: Date.now() };
				schedule();
			}
		}
	})();
	return mine.done;
}

/**
 * Arm the next poll from the current inputs: now when the attached workspace was never polled or its
 * period has run out, else after the remainder. Idle (no timer) while detached or hidden; the hooks wake it.
 */
function schedule(): void {
	clearTimeout(timer);
	timer = undefined;
	watchVisibility();
	const workspaceId = state.currentWorkspaceId;
	if (workspaceId === "") {
		setAnswer(undefined);
		setFailure(undefined);
		return;
	}
	if (!visible()) return;
	// The finishing poll re-arms.
	if (flight?.workspaceId === workspaceId) return;
	const wait = polled?.workspaceId === workspaceId ? polled.at + interval() - Date.now() : 0;
	if (!attached()) {
		// Connection down (not a detach): look again later; the attach that follows polls at once.
		timer = setTimeout(schedule, interval());
		return;
	}
	if (wait <= 0) {
		void poll();
		return;
	}
	timer = setTimeout(schedule, wait);
}

function onVisibility(): void {
	if (visible() && attached()) void poll();
	schedule();
}

const watched = new WeakSet<object>();
function watchVisibility(): void {
	if (typeof document === "undefined" || watched.has(document)) return;
	watched.add(document);
	document.addEventListener("visibilitychange", onVisibility);
}
watchVisibility();

/** Immediate poll; joins one in flight. Resolves without asking when no workspace is attached. */
export function refreshJobTree(): Promise<void> {
	return poll();
}

/**
 * Hold the faster period (a surface that lists jobs is open). Call inside a component lifetime
 * (`onMount` acquire, `onCleanup` release). The release is idempotent.
 */
export function acquireJobPollFocus(): () => void {
	holders++;
	let held = true;
	schedule();
	return () => {
		if (!held) return;
		held = false;
		holders--;
		schedule();
	};
}

/**
 * A workspace attached (every `attached` frame, a re-attach of the same one included): forget the answer
 * and start polling at once, as the job widgets restart from the priming. Deferred one microtask because
 * the frame handler still settles the connection state after the reset that calls this.
 */
export function jobPollAttached(): void {
	setAnswer(undefined);
	setFailure(undefined);
	polled = undefined;
	queueMicrotask(schedule);
}

/** A `job_widgets` frame changed the running count: a job started or ended, so the tree changed. */
export function jobPollRunningChanged(): void {
	if (visible() && attached()) void poll();
}
