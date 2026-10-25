/**
 * The Daemons and Todo sections of the Activities panel: each shows only with items, the daemon
 * list is this workspace's live processes, an expanded daemon shows its log region, and the
 * checklist follows the live todo board.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createComponent, type Component } from "solid-js";
import * as solidWeb from "solid-js/web";
import { daemonsKey, type DaemonInfo } from "#lib/wire/protocol";
import { ActivitiesPanel } from "../../components/activities/ActivitiesPanel";
import { DaemonsSection } from "../../components/activities/DaemonsSection";
import { TodosSection } from "../../components/activities/TodosSection";
import { setState, state } from "../../state";
import { toggleItemExpanded } from "../../store/activities";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

const saved = {
	daemons: state.daemons,
	currentWorkspaceId: state.currentWorkspaceId,
	todoPhases: state.todoPhases,
};

beforeAll(() => {
	installJsxShim();
});

afterEach(() => {
	setState({ ...saved });
});

afterAll(() => {
	restoreJsxShim();
});

function daemon(name: string, patch: Partial<DaemonInfo> = {}): DaemonInfo {
	return {
		name,
		id: `id-${name}`,
		projectDir: "/work",
		state: "running",
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		persist: false,
		detached: false,
		reportedBy: ["w1"],
		...patch,
	};
}

function seedDaemons(workspaceId: string, ...daemons: DaemonInfo[]): void {
	setState({
		currentWorkspaceId: workspaceId,
		daemons: new Map(daemons.map((d) => [daemonsKey(d), d])),
	});
}

const phases = (...tasks: Array<[string, string]>): typeof state.todoPhases => [
	{
		name: "Build",
		tasks: tasks.map(([content, status]) => ({ content, status })),
	} as (typeof state.todoPhases)[number],
];

const render = (component: Component) =>
	solidWeb.renderToString(() => createComponent(component, {}));

describe("DaemonsSection", () => {
	test("lists only the live daemons the selected workspace reported, with active/total", () => {
		seedDaemons(
			"w1",
			daemon("vite", { readyPort: 5173 }),
			daemon("other-workspace", { reportedBy: ["w2"] }),
			daemon("unattributed", { reportedBy: undefined }),
			daemon("finished", { state: "exited" }),
			daemon("winding-down", { state: "stopping" }),
		);
		const html = render(DaemonsSection);
		expect(html).toContain("vite");
		expect(html).toContain("127.0.0.1:5173");
		expect(html).toContain("winding-down");
		expect(html).not.toContain("other-workspace");
		expect(html).not.toContain("unattributed");
		expect(html).not.toContain("finished");
		expect(html).toContain("1/2");
	});

	test("a daemon's log region exists only while its row is expanded", () => {
		const vite = daemon("vite");
		seedDaemons("w1", vite);
		expect(render(DaemonsSection)).not.toContain("daemon-log");
		toggleItemExpanded({ section: "daemons", id: daemonsKey(vite) });
		try {
			expect(render(DaemonsSection)).toContain("daemon-log");
		} finally {
			toggleItemExpanded({ section: "daemons", id: daemonsKey(vite) });
		}
	});
});

describe("TodosSection", () => {
	test("shows the board's phases and tasks with done/total", () => {
		setState({
			todoPhases: phases(
				["write tests", "completed"],
				["ship", "pending"],
				["old idea", "abandoned"],
			),
		});
		const html = render(TodosSection);
		expect(html).toContain("Build");
		expect(html).toContain("write tests");
		expect(html).toContain("ship");
		expect(html).toContain("2/3");
	});

	test("follows the live board as the agent updates it", () => {
		setState({ todoPhases: phases(["write tests", "in_progress"], ["ship", "pending"]) });
		expect(render(TodosSection)).toContain("0/2");
		setState({ todoPhases: phases(["write tests", "completed"], ["ship", "in_progress"]) });
		expect(render(TodosSection)).toContain("1/2");
	});
});

describe("ActivitiesPanel sections", () => {
	test("Daemons and Todo appear only once they have items", () => {
		setState({ daemons: new Map(), todoPhases: [] });
		const empty = render(ActivitiesPanel);
		expect(empty).not.toContain('data-activity-section="daemons"');
		expect(empty).not.toContain('data-activity-section="todos"');

		seedDaemons("w1", daemon("vite"));
		setState({ todoPhases: phases(["ship", "pending"]) });
		const filled = render(ActivitiesPanel);
		expect(filled).toContain('data-activity-section="daemons"');
		expect(filled).toContain('data-activity-section="todos"');
		expect(filled.indexOf('data-activity-section="daemons"')).toBeLessThan(
			filled.indexOf('data-activity-section="todos"'),
		);
	});

	test("daemons of another workspace leave the section out", () => {
		seedDaemons("w2", daemon("vite"));
		expect(render(ActivitiesPanel)).not.toContain('data-activity-section="daemons"');
	});
});
