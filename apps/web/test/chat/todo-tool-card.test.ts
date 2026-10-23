/**
 * The todo tool card is core transcript UI: it renders a `todo` tool item while the
 * Todos feature (the /todo command and its sheet) is in development and off.
 * Rendered through solid's SSR runtime, so no DOM is needed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ToolCard } from "../../components/chat/tools/ToolCard";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";
import type { ToolItem } from "../../state";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

let baselineFeatures: FeatureId[] = [];

beforeAll(() => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
});

afterAll(async () => {
	restoreJsxShim();
	await activateFeatures(baselineFeatures);
});

beforeEach(async () => {
	installJsxShim({ onElement: () => undefined });
	await activateFeatures([]);
});

const todoItem: ToolItem = {
	kind: "tool",
	id: 1,
	toolCallId: "call_todo",
	name: "todo",
	status: "done",
	output: "Updated todos.",
	args: {
		phases: [
			{
				name: "Build",
				tasks: [
					{ content: "Write the parser", status: "done" },
					{ content: "Wire the sheet", status: "pending" },
				],
			},
		],
	},
};

describe("todo tool card", () => {
	test("renders the call's phases with no features active", () => {
		expect(isFeatureEnabled("todos")).toBe(false);
		const html = renderToString(() => createComponent(ToolCard, { item: todoItem }));
		expect(html).toContain("todo-tool");
		expect(html).toContain("Write the parser");
		expect(html).toContain("Wire the sheet");
	});
});
