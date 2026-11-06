/**
 * The bash card's Visualize control, rendered through solid's SSR runtime: closed it is one `<details>`
 * with no body (nothing fetched or mounted until opened); a call the session reported unavailable
 * draws no control; a subagent's card keys that memory by the subagent the transcript pane provides.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { BashToolCard } from "../../components/chat/tools/BashToolCard";
import { ShellVizSubagentContext } from "../../components/chat/tools/ShellVisualizer";
import { setState, state, type ToolItem } from "../../state";
import {
	forgetShellVizUnavailable,
	rememberShellVizUnavailable,
	shellVizKey,
} from "../../store/shell-viz";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

const original = {
	workspaceId: state.currentWorkspaceId,
	toolsExpanded: state.toolsExpanded,
	settingValues: state.settingValues,
};

beforeEach(() => {
	installJsxShim({ onElement: () => undefined });
	setState("currentWorkspaceId", "sess-a");
	setState("toolsExpanded", false);
	setState("settingValues", {});
	forgetShellVizUnavailable();
});

afterAll(() => {
	restoreJsxShim();
	forgetShellVizUnavailable();
	setState("currentWorkspaceId", original.workspaceId);
	setState("toolsExpanded", original.toolsExpanded);
	setState("settingValues", original.settingValues);
});

const bashCall = (over: Partial<ToolItem> = {}): ToolItem => ({
	kind: "tool",
	id: 2,
	toolCallId: "call_2",
	name: "bash",
	args: { command: "echo hi" },
	status: "done",
	output: "hi",
	details: { exitCode: 0, shellTrace: true },
	...over,
});

const render = (item: ToolItem, subagentId?: string) =>
	renderToString(() =>
		subagentId === undefined
			? createComponent(BashToolCard, { item })
			: createComponent(ShellVizSubagentContext.Provider, {
					value: subagentId,
					get children() {
						return createComponent(BashToolCard, { item });
					},
				}),
	);

describe("Visualize control", () => {
	test("a bash card offers it closed, with no body mounted", () => {
		const html = render(bashCall());
		expect(html).toContain("Visualize");
		expect(html).toContain("shell-viz");
		expect(html).not.toContain("shell-viz-body");
		expect(html).not.toContain("Loading");
	});

	test("a running call offers it: its updates carry no details", () => {
		expect(render(bashCall({ status: "running", details: undefined }))).toContain("Visualize");
	});

	test("a settled result offers it only with the session's shellTrace marker", () => {
		expect(render(bashCall({ details: { exitCode: 0 } }))).not.toContain("Visualize");
		expect(render(bashCall({ details: undefined }))).not.toContain("Visualize");
		expect(render(bashCall({ details: { shellTrace: false } }))).not.toContain("Visualize");
	});

	test("display.shellVisualization off hides it, default and on show it", () => {
		setState("settingValues", { "display.shellVisualization": false });
		expect(render(bashCall())).not.toContain("Visualize");
		expect(render(bashCall({ status: "running" }))).not.toContain("Visualize");
		setState("settingValues", { "display.shellVisualization": true });
		expect(render(bashCall())).toContain("Visualize");
	});

	test("a call the session had no visualization for draws no control", () => {
		rememberShellVizUnavailable(shellVizKey("call_2"));
		expect(render(bashCall())).not.toContain("Visualize");
		expect(render(bashCall({ toolCallId: "call_3" }))).toContain("Visualize");
	});

	test("a subagent's card is keyed by its subagent", () => {
		rememberShellVizUnavailable(shellVizKey("call_2", "agent-1"));
		expect(render(bashCall(), "agent-1")).not.toContain("Visualize");
		expect(render(bashCall(), "agent-2")).toContain("Visualize");
		expect(render(bashCall())).toContain("Visualize");
	});
});
