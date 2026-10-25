/**
 * What the activity bar shows and does (activities/bar.ts): which buttons exist with what badge and
 * whether they read muted, the status text, how a popover caps its rows, and what a button press does
 * while the Activities panel is open.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	activeFirst,
	activityButtons,
	activityStatusText,
	capRows,
	capTodoTasks,
	currentSummaries,
	POPOVER_MAX_ROWS,
	pressActivityButton,
} from "../../activities/bar";
import { setState, state, type SubagentInfo } from "../../state";
import { openActivities, toggleSectionCollapsed } from "../../store/activities";
import { restoreDockLayout } from "../../store/dock";
import { installLocalStorageShim, restoreBrowserGlobals } from "../web.testkit";

const none = { total: 0, active: 0, settled: false };
const summaries = (patch: Partial<Parameters<typeof activityButtons>[0]> = {}) => ({
	subagents: none,
	jobs: none,
	daemons: none,
	todos: { total: 0, done: 0, settled: false },
	...patch,
});

describe("activityButtons", () => {
	test("a section with nothing listed has no button; the rest keep the fixed order", () => {
		const buttons = activityButtons(
			summaries({
				todos: { total: 4, done: 1, settled: false },
				jobs: { total: 2, active: 1, settled: false },
			}),
		);
		expect(buttons.map((b) => b.section)).toEqual(["jobs", "todos"]);
		const all = activityButtons(
			summaries({
				subagents: { total: 1, active: 1, settled: false },
				jobs: { total: 1, active: 1, settled: false },
				daemons: { total: 1, active: 1, settled: false },
				todos: { total: 1, done: 0, settled: false },
			}),
		);
		expect(all.map((b) => b.section)).toEqual(["subagents", "jobs", "daemons", "todos"]);
	});

	test("the badge is the active count; Todo shows done/total", () => {
		const buttons = activityButtons(
			summaries({
				subagents: { total: 5, active: 2, settled: false },
				todos: { total: 7, done: 3, settled: false },
			}),
		);
		expect(buttons.map((b) => b.badge)).toEqual(["2", "3/7"]);
	});

	test("a section whose items all settled stays, muted, with no active count to show", () => {
		const [subagents, todos] = activityButtons(
			summaries({
				subagents: { total: 3, active: 0, settled: true },
				todos: { total: 2, done: 2, settled: true },
			}),
		);
		expect(subagents).toMatchObject({ section: "subagents", muted: true, badge: "" });
		expect(todos).toMatchObject({ section: "todos", muted: true, badge: "2/2" });
	});

	test("a section with anything active is not muted", () => {
		const [jobs] = activityButtons(summaries({ jobs: { total: 4, active: 1, settled: false } }));
		expect(jobs?.muted).toBe(false);
	});
});

describe("the live store feeds the buttons", () => {
	let saved: Pick<typeof state, "currentWorkspaceId" | "subagents" | "todoPhases" | "daemons">;
	beforeEach(() => {
		saved = {
			currentWorkspaceId: state.currentWorkspaceId,
			subagents: state.subagents,
			todoPhases: state.todoPhases,
			daemons: state.daemons,
		};
		setState({ currentWorkspaceId: "d1" });
	});
	afterEach(() => setState(saved));

	test("subagents and todos in the store produce their buttons, jobs and daemons stay absent", () => {
		const agent = (id: string, status: string): [string, SubagentInfo] => [
			id,
			{ id, index: 0, agent: "task", status, lastUpdate: 0 } as SubagentInfo,
		];
		setState("subagents", new Map([agent("a1", "running"), agent("a2", "done")]));
		setState("todoPhases", [
			{
				name: "P",
				tasks: [
					{ content: "one", status: "completed" },
					{ content: "two", status: "pending" },
				],
			},
		]);
		expect(activityButtons(currentSummaries()).map((b) => [b.section, b.badge])).toEqual([
			["subagents", "1"],
			["todos", "1/2"],
		]);
	});
});

describe("activityStatusText", () => {
	let saved: Pick<typeof state, "streaming" | "compacting" | "workingIntent">;
	beforeEach(() => {
		saved = {
			streaming: state.streaming,
			compacting: state.compacting,
			workingIntent: state.workingIntent,
		};
	});
	afterEach(() => setState(saved));

	test("idle is blank", () => {
		setState({ streaming: false, compacting: false, workingIntent: undefined });
		expect(activityStatusText()).toEqual({ kind: "idle", text: "" });
	});

	test("a streaming turn shows its intent, else the default phrase", () => {
		setState({ streaming: true, compacting: false, workingIntent: "Reading the loader" });
		expect(activityStatusText()).toEqual({ kind: "working", text: "Reading the loader" });
		setState({ workingIntent: undefined });
		expect(activityStatusText()).toEqual({ kind: "working", text: "Working…" });
	});

	test("compaction wins over a streaming turn", () => {
		setState({ streaming: true, compacting: true, workingIntent: "Reading the loader" });
		expect(activityStatusText()).toEqual({ kind: "compacting", text: "Compacting context…" });
	});
});

describe("row capping", () => {
	test("up to the cap shows everything with nothing more", () => {
		const rows = Array.from({ length: POPOVER_MAX_ROWS }, (_, i) => i);
		expect(capRows(rows)).toEqual({ shown: rows, more: 0 });
	});

	test("past the cap shows the first rows and counts the rest", () => {
		const rows = Array.from({ length: POPOVER_MAX_ROWS + 3 }, (_, i) => i);
		const { shown, more } = capRows(rows);
		expect(shown).toEqual(rows.slice(0, POPOVER_MAX_ROWS));
		expect(more).toBe(3);
	});

	test("active rows come first so the cap never hides what runs", () => {
		const rows = [
			{ id: "old1", on: false },
			{ id: "old2", on: false },
			{ id: "live", on: true },
			{ id: "live2", on: true },
		];
		expect(activeFirst(rows, (r) => r.on).map((r) => r.id)).toEqual([
			"live",
			"live2",
			"old1",
			"old2",
		]);
		const { shown, more } = capRows(
			activeFirst(rows, (r) => r.on),
			2,
		);
		expect(shown.map((r) => r.id)).toEqual(["live", "live2"]);
		expect(more).toBe(2);
	});

	test("todo tasks are capped across phases, dropping a phase left with none", () => {
		const phases = [
			{ name: "A", tasks: [t("a1"), t("a2"), t("a3")] },
			{ name: "B", tasks: [t("b1"), t("b2")] },
			{ name: "C", tasks: [t("c1")] },
		];
		const { shown, more } = capTodoTasks(phases, 4);
		expect(shown.map((p) => [p.name, p.tasks.map((x) => x.content)])).toEqual([
			["A", ["a1", "a2", "a3"]],
			["B", ["b1"]],
		]);
		expect(more).toBe(2);
		expect(capTodoTasks(phases, 3).shown.map((p) => p.name)).toEqual(["A"]);
		expect(capTodoTasks(phases, 99)).toEqual({ shown: phases, more: 0 });
	});
});

function t(content: string) {
	return { content, status: "pending" as const };
}

describe("a button press", () => {
	beforeEach(() => {
		installLocalStorageShim();
		restoreDockLayout("__no-such-workspace__");
		setState({ currentWorkspaceId: "d1" });
	});
	afterEach(() => {
		restoreDockLayout("__no-such-workspace__");
		restoreBrowserGlobals();
	});

	test("with the panel closed the button leaves the panel alone and asks for its popover", () => {
		expect(pressActivityButton("jobs")).toBe("popover");
		expect(state.dock).toBeNull();
	});

	test("with the panel open the button expands and scrolls to its section instead", () => {
		openActivities();
		toggleSectionCollapsed("daemons");
		expect(state.activities.collapsedSections.has("daemons")).toBe(true);
		expect(pressActivityButton("daemons")).toBe("focused");
		expect(state.activities.collapsedSections.has("daemons")).toBe(false);
		expect(state.activities.focusRequest?.target).toBe("daemons");
		expect(state.dock?.kind).toBe("activities");
	});
});
