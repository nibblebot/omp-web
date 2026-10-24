import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { ServerFrame, SessionScopedFrame, WireJobWidgetEntry } from "#lib/wire/protocol";
import { setOnFrameTap } from "../client-delivery";
import {
	createJobWidgetPublisher,
	JOB_WIDGETS_INTERVAL_MS,
	JOB_WIDGETS_MAX_ENTRIES,
	JOB_WIDGETS_STAGE_CHARS,
	jobWidgetEntries,
	jobWidgetPrimeFrames,
	type JobWidgetsFrame,
	type RawJobWidget,
	wireJobWidgets,
} from "../job-widgets";
import type { SessionEntry } from "../session-entry";
import { setCallbackBrowserStreamCount } from "../ui-context";

/** An SDK view as a benchmark job's widget draws it: a headline, a long spark with tips and marks, a meter and a stage. */
function rawView(updatedAt: number, last = "186 tok/s"): unknown {
	return {
		title: "verb-bench · 3 models",
		headline: { text: last, label: "decode", trend: { text: "▲ 15%", tone: "success" } },
		stage:
			"running the nvfp4 batch of 1 model with a long stage line that a row never shows in full, it is cut",
		blocks: [
			{
				kind: "spark",
				label: "tok/s · nvfp4 b1",
				values: Array.from({ length: 48 }, (_, i) => 100 + i),
				min: 100,
				max: 148,
				marks: [{ value: 120, label: "target" }],
				last,
				tips: Array.from({ length: 48 }, (_, i) => `12:04:${i} · ${100 + i} tok/s`),
				tone: "accent",
			},
			{ kind: "meter", label: "trials", value: 7 / 9, text: "7/9 trials" },
			{ kind: "text", text: "now: gemma" },
		],
		state: "live",
		updatedAt,
	};
}

const raw = (id: string, updatedAt = 1, last?: string, type = "bash"): RawJobWidget => ({
	id,
	type,
	view: rawView(updatedAt, last),
});

/**
 * Manual clock: timers fire only when `advance` moves time past their deadline,
 * in deadline order. A fired timer may schedule the next one inside the same advance.
 */
function harness(options: { viewers?: boolean } = {}) {
	let clock = 0;
	let viewers = options.viewers ?? true;
	let widgets: RawJobWidget[] = [];
	let running: number | undefined;
	let reads = 0;
	let listener: (() => void) | undefined;
	let subscribes = 0;
	let unsubscribes = 0;
	const frames: JobWidgetsFrame[] = [];
	const pending: Array<{ at: number; run: () => void; live: boolean }> = [];
	const publisher = createJobWidgetPublisher({
		read: () => {
			reads++;
			return { running: running ?? widgets.length, widgets };
		},
		subscribe: (next) => {
			subscribes++;
			listener = next;
			return () => {
				unsubscribes++;
				listener = undefined;
			};
		},
		hasViewers: () => viewers,
		emit: (frame) => frames.push(frame),
		now: () => clock,
		schedule: (run, ms) => {
			const timer = { at: clock + ms, run, live: true };
			pending.push(timer);
			return timer as unknown as Timer;
		},
		cancel: (timer) => {
			(timer as unknown as { live: boolean }).live = false;
		},
	});
	return {
		frames,
		publisher,
		/** The session's widgets; `count` is how many background jobs run (default: one per widget). */
		set(next: RawJobWidget[], count?: number) {
			widgets = next;
			running = count;
		},
		setViewers(next: boolean) {
			viewers = next;
		},
		notify: () => listener?.(),
		get reads() {
			return reads;
		},
		get subscribed() {
			return listener !== undefined;
		},
		get subscribes() {
			return subscribes;
		},
		get unsubscribes() {
			return unsubscribes;
		},
		/** Move time forward, running every due timer in order. */
		advance(ms: number): void {
			const target = clock + ms;
			for (;;) {
				const due = pending
					.filter((timer) => timer.live && timer.at <= target)
					.sort((a, b) => a.at - b.at)[0];
				if (due === undefined) break;
				due.live = false;
				clock = Math.max(clock, due.at);
				due.run();
			}
			clock = target;
		},
	};
}

describe("jobWidgetEntries", () => {
	test("cuts a view to a glance: the headline, the primary spark's newest values without tips or marks, the meter and a short stage", () => {
		const [entry] = jobWidgetEntries([raw("bg_1")]);
		expect(entry.id).toBe("bg_1");
		expect(entry.type).toBe("bash");
		expect(entry.view.stage).toHaveLength(JOB_WIDGETS_STAGE_CHARS);
		expect(entry.view.stage?.endsWith("\u2026")).toBe(true);
		expect(entry.view.headline).toEqual({
			text: "186 tok/s",
			label: "decode",
			trend: { text: "▲ 15%", tone: "success" },
		});
		const kinds = entry.view.blocks.map((block) => block.kind);
		expect(kinds).toEqual(["spark", "meter"]);
		const spark = entry.view.blocks[0];
		if (spark.kind !== "spark") throw new Error("expected a spark");
		expect(spark.values).toHaveLength(16);
		expect(spark.values.at(-1)).toBe(147);
		expect(spark.tips).toBeUndefined();
		expect(spark.marks).toBeUndefined();
	});

	test("a typical frame is small", () => {
		const bytes = JSON.stringify({
			type: "job_widgets",
			entries: jobWidgetEntries([raw("bg_1"), raw("bg_2", 2, "41 ms", "task")]),
		}).length;
		expect(bytes).toBeLessThan(1500);
	});

	test("drops a view that is not one and strips terminal escapes from titles", () => {
		const entries = jobWidgetEntries([
			{ id: "bg_1", type: "bash", view: "nope" },
			{
				id: "bg_2",
				type: "bash",
				view: { title: "\u001b[31mred\u001b[0m job", blocks: [], state: "live", updatedAt: 3 },
			},
		]);
		expect(entries.map((entry) => entry.id)).toEqual(["bg_2"]);
		expect(entries[0].view.title).toBe("red job");
	});

	test("past the cap the widgets that saw data last stay, in the SDK's order", () => {
		const many = Array.from({ length: JOB_WIDGETS_MAX_ENTRIES + 3 }, (_, i) => raw(`bg_${i}`, i));
		const ids = jobWidgetEntries(many).map((entry) => entry.id);
		expect(ids).toHaveLength(JOB_WIDGETS_MAX_ENTRIES);
		expect(ids[0]).toBe("bg_3");
		expect(ids.at(-1)).toBe(`bg_${JOB_WIDGETS_MAX_ENTRIES + 2}`);
	});
});

describe("createJobWidgetPublisher", () => {
	test("a poke publishes the running widgets, and a pokes inside the interval coalesce into one frame", () => {
		const h = harness();
		h.set([raw("bg_1")]);
		h.publisher.poke();
		h.publisher.poke();
		expect(h.frames).toHaveLength(0);
		h.advance(0);
		expect(h.frames).toHaveLength(1);
		expect(h.frames[0].entries.map((entry: WireJobWidgetEntry) => entry.id)).toEqual(["bg_1"]);
	});

	test("keeps sampling while a widget runs, sends only a changed snapshot and at most one frame per interval", () => {
		const h = harness();
		h.set([raw("bg_1", 1)]);
		h.publisher.poke();
		h.advance(0);
		// Nothing changed for three samples: nothing goes out.
		h.advance(3 * JOB_WIDGETS_INTERVAL_MS);
		expect(h.frames).toHaveLength(1);
		// Data arrives 200 ms after a sample: the next frame waits for the next sample.
		h.advance(200);
		h.set([raw("bg_1", 2, "190 tok/s")]);
		h.advance(JOB_WIDGETS_INTERVAL_MS - 201);
		expect(h.frames).toHaveLength(1);
		h.advance(1);
		expect(h.frames).toHaveLength(2);
		// A burst of changes never beats the interval: each sample sends at most one frame.
		for (let i = 0; i < 10; i++) {
			h.set([raw("bg_1", 10 + i, `${200 + i} tok/s`)]);
			h.advance(100);
		}
		expect(h.frames.length).toBeLessThanOrEqual(2 + 1);
	});

	test("a job that ended leaves the next snapshot, an empty one clears, and sampling stops", () => {
		const h = harness();
		h.set([raw("bg_1"), raw("bg_2", 2, "41 ms")]);
		h.publisher.poke();
		h.advance(0);
		h.set([raw("bg_2", 2, "41 ms")]);
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		expect(h.frames.at(-1)?.entries.map((entry) => entry.id)).toEqual(["bg_2"]);
		h.set([]);
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		expect(h.frames.at(-1)).toEqual({ type: "job_widgets", running: 0, entries: [] });
		const reads = h.reads;
		h.advance(10 * JOB_WIDGETS_INTERVAL_MS);
		expect(h.reads).toBe(reads);
		expect(h.frames).toHaveLength(3);
	});

	test("a job without a widget still counts: the snapshot carries the running count and sampling goes on", () => {
		const h = harness();
		h.set([], 2);
		h.publisher.poke();
		h.advance(0);
		expect(h.frames).toEqual([{ type: "job_widgets", running: 2, entries: [] }]);
		h.set([raw("bg_1")], 2);
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		expect(h.frames.at(-1)).toMatchObject({ running: 2, entries: [{ id: "bg_1" }] });
		h.set([], 1);
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		expect(h.frames.at(-1)).toEqual({ type: "job_widgets", running: 1, entries: [] });
		h.set([], 0);
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		expect(h.frames.at(-1)).toEqual({ type: "job_widgets", running: 0, entries: [] });
		const reads = h.reads;
		h.advance(5 * JOB_WIDGETS_INTERVAL_MS);
		expect(h.reads).toBe(reads);
	});

	test("with no job at all it sends nothing, not even an empty snapshot", () => {
		const h = harness();
		h.publisher.poke();
		h.advance(0);
		expect(h.frames).toHaveLength(0);
	});

	test("reads nothing while no client is attached, and an attach primes and resumes sampling", () => {
		const h = harness({ viewers: false });
		h.set([raw("bg_1")]);
		h.publisher.poke();
		h.advance(5 * JOB_WIDGETS_INTERVAL_MS);
		expect(h.reads).toBe(0);
		expect(h.frames).toHaveLength(0);
		// A client attaches: its priming frame carries the widgets at once (never from a timer)…
		h.setViewers(true);
		const prime = h.publisher.primeFrames();
		expect(prime).toHaveLength(1);
		expect(prime[0].entries.map((entry) => entry.id)).toEqual(["bg_1"]);
		expect(prime[0].running).toBe(1);
		// …and the sampler it started publishes the snapshot to everyone attached, then keeps going.
		expect(h.frames).toHaveLength(0);
		h.advance(0);
		expect(h.frames).toHaveLength(1);
		h.set([raw("bg_1", 2, "190 tok/s")]);
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		expect(h.frames).toHaveLength(2);
		// The last client leaves: sampling stops at its next turn.
		h.setViewers(false);
		const reads = h.reads;
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		h.advance(5 * JOB_WIDGETS_INTERVAL_MS);
		expect(h.reads).toBe(reads);
		expect(h.subscribed).toBe(false);
	});

	test("an attach with nothing running primes nothing", () => {
		const h = harness();
		expect(h.publisher.primeFrames()).toEqual([]);
	});

	test("the registry's change notice pokes a sample, and the subscription lives only while widgets run", () => {
		const h = harness();
		h.set([raw("bg_1")]);
		h.publisher.poke();
		h.advance(0);
		expect(h.subscribed).toBe(true);
		h.advance(500);
		h.set([raw("bg_1", 2, "190 tok/s")]);
		h.notify();
		h.advance(JOB_WIDGETS_INTERVAL_MS - 500);
		expect(h.frames).toHaveLength(2);
		h.set([]);
		h.advance(JOB_WIDGETS_INTERVAL_MS);
		expect(h.subscribed).toBe(false);
		expect(h.subscribes).toBe(h.unsubscribes);
	});

	test("dispose stops sampling and listening", () => {
		const h = harness();
		h.set([raw("bg_1")]);
		h.publisher.poke();
		h.advance(0);
		h.publisher.dispose();
		const reads = h.reads;
		h.advance(5 * JOB_WIDGETS_INTERVAL_MS);
		expect(h.reads).toBe(reads);
		expect(h.subscribed).toBe(false);
		expect(h.publisher.primeFrames()).toEqual([]);
	});
});

describe("wireJobWidgets", () => {
	const tapped: Array<ServerFrame | SessionScopedFrame> = [];

	beforeAll(() => {
		setOnFrameTap((frame) => tapped.push(frame));
		setCallbackBrowserStreamCount(() => 1);
	});
	afterAll(() => {
		setOnFrameTap(null);
		setCallbackBrowserStreamCount(null);
	});
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a tool call ending pokes the session's widgets onto the wire, and an attach is primed with them", () => {
		let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
		let widgets: RawJobWidget[] = [];
		const session = {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				sessionListener = listener;
				return () => {};
			},
			getRunningJobWidgets: () => widgets,
			getAsyncJobSnapshot: () => ({
				running: [
					...widgets.map((widget) => ({ id: widget.id, type: widget.type })),
					{ id: "Owl", type: "task", agentId: "Owl" },
				],
			}),
			asyncJobManager: { widgets: { subscribe: () => () => {} } },
		};
		const entry = { handle: "s1", session } as unknown as SessionEntry;
		const publisher = wireJobWidgets(entry);
		expect(wireJobWidgets(entry)).toBe(publisher);

		// An event that cannot start a job reads nothing.
		sessionListener?.({ type: "turn_start" } as AgentSessionEvent);
		vi.advanceTimersByTime(JOB_WIDGETS_INTERVAL_MS);
		expect(tapped).toHaveLength(0);

		widgets = [raw("bg_1")];
		sessionListener?.({ type: "tool_execution_end" } as AgentSessionEvent);
		vi.advanceTimersByTime(0);
		expect(tapped).toHaveLength(1);
		expect(tapped[0]).toMatchObject({ type: "job_widgets", running: 1, entries: [{ id: "bg_1" }] });
		expect(jobWidgetPrimeFrames(entry)).toHaveLength(1);
		publisher.dispose();
		expect(jobWidgetPrimeFrames(entry)).toEqual([]);
	});
});
