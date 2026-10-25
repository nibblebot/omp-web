// Live publication of the running background jobs and their widget glances (`job_widgets` frames).
//
// The SDK keeps one widget view per shown job and announces no job start or end. So the publisher is
// poked by the session events a job can start under (a tool call, a turn), reads the running count and
// `getRunningJobWidgets()` (which marks a widget shown, as the TUI status line does, and so lets the
// `widget` model role author its spec), and keeps sampling once a second for as long as a job runs (the
// registry's `subscribe` is held meanwhile only so its own refresh timer keeps running). Each
// sample goes out only when it differs from the last frame sent, and never more often than once a second,
// so a quiet job costs nothing and a chatty one costs one small absolute snapshot a second. A job that
// settled leaves the next snapshot. Nothing is read while no client is attached; an attach primes from a
// fresh read.
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { glanceJobWidgetView, parseJobWidgetView } from "#lib/wire/job-widget";
import type { WireJobWidgetEntry } from "#lib/wire/protocol";
import { broadcastTo } from "./client-delivery";
import type { SessionEntry } from "./session-entry";
import { hasBrowserUiClient } from "./ui-context";

/** Shortest time between two samples, so at most one frame per interval leaves the daemon. */
export const JOB_WIDGETS_INTERVAL_MS = 1000;
/** Characters of a stage a glance keeps: it names what the job does when no figure exists yet. */
export const JOB_WIDGETS_STAGE_CHARS = 80;
/** Widgets one frame carries; past it the ones that saw data last stay. */
export const JOB_WIDGETS_MAX_ENTRIES = 32;

export type JobWidgetsFrame = {
	type: "job_widgets";
	running: number;
	entries: WireJobWidgetEntry[];
};

/** A running job's widget as the SDK lists it (pi-tui `JobWidgetEntry`); the view is untrusted JSON until parsed. */
export interface RawJobWidget {
	id: string;
	type: string;
	view: unknown;
}

/** What one sample of the session reads. */
export interface JobWidgetsRead {
	/** Running background jobs (a subagent's task job counts with the agents). */
	running: number;
	widgets: readonly RawJobWidget[];
}

/**
 * The SDK's widgets as wire entries: each view sanitized and bounded
 * (`parseJobWidgetView`), cut to what a row or the composer bar shows
 * (`glanceJobWidgetView`, the stage cut to {@link JOB_WIDGETS_STAGE_CHARS}), and the list capped at
 * {@link JOB_WIDGETS_MAX_ENTRIES}, in the SDK's order.
 */
export function jobWidgetEntries(raw: readonly RawJobWidget[]): WireJobWidgetEntry[] {
	const entries: WireJobWidgetEntry[] = [];
	for (const item of raw) {
		const view = parseJobWidgetView(item.view);
		if (view === undefined) continue;
		const glance = glanceJobWidgetView(view);
		if (glance.stage !== undefined && glance.stage.length > JOB_WIDGETS_STAGE_CHARS)
			glance.stage = `${glance.stage.slice(0, JOB_WIDGETS_STAGE_CHARS - 1)}\u2026`;
		entries.push({ id: item.id, type: item.type, view: glance });
	}
	if (entries.length <= JOB_WIDGETS_MAX_ENTRIES) return entries;
	const keep = new Set(
		[...entries]
			.sort((a, b) => b.view.updatedAt - a.view.updatedAt)
			.slice(0, JOB_WIDGETS_MAX_ENTRIES),
	);
	return entries.filter((entry) => keep.has(entry));
}

/** Running background jobs as the TUI's jobs segment counts them: a subagent's task job is counted with the agents. */
export function runningBackgroundJobs(session: AgentSession): number {
	const snapshot = session.getAsyncJobSnapshot({ recentLimit: 0 });
	return (
		snapshot?.running.filter((job) => job.type !== "task" || job.agentId === undefined).length ?? 0
	);
}

export interface JobWidgetPublisherOptions {
	/** One sample of the session (reading the widgets marks them shown). */
	read: () => JobWidgetsRead;
	/** Listen to the registry's change notices; undefined while the session has no widget registry. */
	subscribe: (listener: () => void) => (() => void) | undefined;
	/** A client is attached; nothing is read or sent while none is. */
	hasViewers: () => boolean;
	/** Receives each frame that goes out, in order. */
	emit: (frame: JobWidgetsFrame) => void;
	/** Clock in ms; injected by tests. */
	now?: () => number;
	/** Timer scheduling; injected by tests. */
	schedule?: (run: () => void, ms: number) => Timer;
	/** Timer cancellation; injected by tests. */
	cancel?: (timer: Timer) => void;
}

export interface JobWidgetPublisher {
	/** Something may have changed (a job may have started or ended): sample once the interval since the last sample has passed. */
	poke(): void;
	/** A fresh read as the priming frame, or nothing while no job runs. */
	primeFrames(): JobWidgetsFrame[];
	/** Stop sampling and listening. */
	dispose(): void;
}

const IDLE_FRAME_JSON = JSON.stringify({ running: 0, entries: [] });

export function createJobWidgetPublisher(options: JobWidgetPublisherOptions): JobWidgetPublisher {
	const now = options.now ?? Date.now;
	const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
	const cancel = options.cancel ?? clearTimeout;
	/** The body of the frame last sent; the idle one while clients see no jobs. */
	let sent = IDLE_FRAME_JSON;
	let sampledAt = Number.NEGATIVE_INFINITY;
	let timer: Timer | undefined;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;

	function unlisten(): void {
		unsubscribe?.();
		unsubscribe = undefined;
	}

	function sample(): JobWidgetsFrame {
		const { running, widgets } = options.read();
		return { type: "job_widgets", running, entries: jobWidgetEntries(widgets) };
	}

	function run(): void {
		timer = undefined;
		if (disposed) return;
		if (!options.hasViewers()) {
			// Nobody to show it to: stop reading (which would keep authoring specs). An attach pokes again.
			unlisten();
			return;
		}
		sampledAt = now();
		const frame = sample();
		const body = JSON.stringify({ running: frame.running, entries: frame.entries });
		if (body !== sent) {
			sent = body;
			options.emit(frame);
		}
		if (frame.running > 0 || frame.entries.length > 0) {
			// The listener does nothing: the subscription only keeps the SDK registry's own refresh timer alive.
			// This sampler's timer (below) is what publishes, so a change notice has nothing to add.
			unsubscribe ??= options.subscribe(() => {});
			timer = schedule(run, JOB_WIDGETS_INTERVAL_MS);
		} else {
			unlisten();
		}
	}

	function poke(): void {
		if (disposed || timer !== undefined) return;
		// Never inline: a poke from a session event or an attach must not broadcast before its own caller's frames.
		timer = schedule(run, Math.max(0, sampledAt + JOB_WIDGETS_INTERVAL_MS - now()));
	}

	return {
		poke,
		primeFrames() {
			if (disposed) return [];
			const frame = sample();
			// The attach also starts sampling: whatever it primed that the last frame did not say goes to everyone.
			poke();
			return frame.running > 0 || frame.entries.length > 0 ? [frame] : [];
		},
		dispose() {
			disposed = true;
			if (timer !== undefined) cancel(timer);
			timer = undefined;
			unlisten();
		},
	};
}

const publishers = new WeakMap<SessionEntry, JobWidgetPublisher>();

/** SDK events a background job can start or end under: a tool call or a turn. */
const JOB_EVENTS: Record<string, true> = {
	tool_execution_start: true,
	tool_execution_end: true,
	agent_start: true,
	agent_end: true,
};

/**
 * Start publishing the session's running jobs to its attached clients: the
 * session events poke the publisher, which broadcasts `job_widgets` frames.
 * One publisher per entry; a second call returns the first.
 */
export function wireJobWidgets(entry: SessionEntry): JobWidgetPublisher {
	const existing = publishers.get(entry);
	if (existing !== undefined) return existing;
	const { session } = entry;
	const publisher = createJobWidgetPublisher({
		read: () => ({
			running: runningBackgroundJobs(session),
			widgets: session.getRunningJobWidgets(),
		}),
		subscribe: (listener) => session.asyncJobManager?.widgets?.subscribe(listener),
		hasViewers: () => hasBrowserUiClient(entry),
		emit: (frame) => broadcastTo(entry.handle, frame),
	});
	publishers.set(entry, publisher);
	session.subscribe((event) => {
		if (JOB_EVENTS[event.type]) publisher.poke();
	});
	return publisher;
}

/** The priming frames a client attaching to `entry` needs: its running jobs and their widgets, when any run. */
export function jobWidgetPrimeFrames(entry: SessionEntry): JobWidgetsFrame[] {
	return publishers.get(entry)?.primeFrames() ?? [];
}
