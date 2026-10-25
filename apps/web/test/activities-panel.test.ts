/**
 * The Activities panel lists a section only while it has items, and the accordion keeps any
 * number of subagents expanded at once, each in its own region under its row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import { ActivitiesPanel } from "../components/activities/ActivitiesPanel";
import { SubagentTree } from "../components/subagents/SubagentTree";
import { setState, type SubagentInfo } from "../state";
import { subagentForest } from "../store/subagents";
import { installJsxShim, restoreJsxShim } from "./web.testkit";

beforeAll(() => {
	installJsxShim();
});

afterEach(() => {
	setState("subagents", new Map());
});

afterAll(() => {
	restoreJsxShim();
});

function agent(id: string, status: string): SubagentInfo {
	return { id, index: 0, agent: "task", description: `${id} job`, status, lastUpdate: 1 };
}

function seedAgents(...infos: SubagentInfo[]): void {
	setState("subagents", new Map(infos.map((info) => [info.id, info])));
}

describe("ActivitiesPanel", () => {
	test("renders no section while the session has nothing to show", () => {
		const html = solidWeb.renderToString(() => createComponent(ActivitiesPanel, {}));
		expect(html).not.toContain("data-activity-section");
		expect(html).toContain("activities-empty");
	});

	test("renders the Subagents section once an agent exists", () => {
		seedAgents(agent("scout", "running"));
		const html = solidWeb.renderToString(() => createComponent(ActivitiesPanel, {}));
		expect(html).toContain('data-activity-section="subagents"');
		expect(html).not.toContain("activities-empty");
	});
});

describe("SubagentTree accordion", () => {
	test("renders a body region for every expanded agent", () => {
		seedAgents(agent("scout", "running"), agent("builder", "done"), agent("linter", "done"));
		const html = solidWeb.renderToString(() =>
			createComponent(SubagentTree, {
				nodes: subagentForest(),
				label: "Subagents",
				onOpen: () => {},
				accordion: {
					expanded: new Set(["scout", "linter"]),
					body: (id: string) => `body-of-${id}`,
				},
			}),
		);
		expect(html).toContain("body-of-scout");
		expect(html).toContain("body-of-linter");
		expect(html).not.toContain("body-of-builder");
	});
});
