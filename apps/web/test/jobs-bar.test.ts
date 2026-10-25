/**
 * The composer jobs bar shows while background jobs run: the count, and the glance of the widget that
 * saw data last (never a subagent's task widget: the count leaves those jobs out). Once the last job ends
 * it keeps a quiet "finished" note for a while; before any job ran it renders nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import type { WireJobWidgetEntry } from "#lib/wire/protocol";
import { JobsBar } from "../components/jobs/JobsBar";
import { setState, state } from "../state";
import { applyJobWidgets, clearJobWidgets } from "../store/job-widgets";
import { JOBS_FINISHED_LINGER_MS } from "../store/jobs-bar";
import { installJsxShim, restoreJsxShim } from "./web.testkit";

const saved = { jobWidgets: state.jobWidgets };

beforeAll(() => {
	installJsxShim();
});

afterAll(() => {
	setState("jobWidgets", saved.jobWidgets);
	restoreJsxShim();
});

const entry = (
	id: string,
	headline: string,
	updatedAt: number,
	viewState: "live" | "fallback" = "live",
): WireJobWidgetEntry => ({
	id,
	type: "bash",
	view: {
		title: `${id} bench`,
		headline: { text: headline },
		blocks: [],
		state: viewState,
		updatedAt,
	},
});

function render(running: number, entries: WireJobWidgetEntry[]): string {
	setState("jobWidgets", { running, entries });
	return solidWeb.renderToString(() => createComponent(JobsBar, {}));
}

describe("JobsBar", () => {
	test("renders nothing while no job runs", () => {
		expect(render(0, [])).toBe("");
	});

	test("counts the running jobs, with no glance when none has a live widget", () => {
		const html = render(1, []);
		expect(html).toContain("1 job running");
		expect(html).not.toContain("job-widget-glance");
		expect(render(3, [entry("bg_1", "9 ms", 1, "fallback")])).toContain("3 jobs running");
		expect(render(3, [entry("bg_1", "9 ms", 1, "fallback")])).not.toContain("job-widget-glance");
	});

	test("glances the live widget that saw data last", () => {
		const html = render(2, [entry("bg_1", "186 tok/s", 5), entry("bg_2", "41 ms", 9)]);
		expect(html).toContain("41 ms");
		expect(html).not.toContain("186 tok/s");
	});

	test("the glance skips a subagent's task widget, which the count leaves out", () => {
		const html = render(1, [
			entry("bg_1", "186 tok/s", 5),
			{ ...entry("Reader", "70%", 9), type: "task" },
		]);
		expect(html).toContain("186 tok/s");
		expect(html).not.toContain("70%");
	});
});

describe("JobsBar after the last job ends", () => {
	afterEach(() => {
		clearJobWidgets();
		vi.useRealTimers();
	});

	const draw = () => solidWeb.renderToString(() => createComponent(JobsBar, {}));

	test("keeps a quiet finished note that opens the sheet, then hides", () => {
		vi.useFakeTimers();
		clearJobWidgets();
		applyJobWidgets({ running: 2, entries: [] });
		applyJobWidgets({ running: 0, entries: [] });
		const html = draw();
		expect(html).toContain("2 jobs finished");
		expect(html).toContain('data-phase="finished"');
		expect(html).not.toContain("running");
		vi.advanceTimersByTime(JOBS_FINISHED_LINGER_MS);
		expect(draw()).toBe("");
	});
});
