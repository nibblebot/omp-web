import { describe, expect, test } from "bun:test";
import type { SettingsModel } from "#lib/wire/protocol";
import { displayTitle } from "../components/ui/title-icons";
import { setState } from "../state";
import {
	elapsedLabel,
	layoutPinned,
	modelBadge,
	PINNED_COLLAPSED_LIMIT,
	PREVIEW_ELAPSED_MIN_MS,
	pickProgress,
	pinnedAgentsMode,
	toolPreview,
	type SubagentProgressView,
} from "../subagents/progress";

/** A settings model holding one item per `path: value` entry, all under one tab. */
function modelOf(values: Record<string, unknown>): SettingsModel {
	return {
		revision: 1,
		target: "current-session",
		tabs: [
			{
				id: "all",
				label: "All",
				groups: [
					{
						name: "All",
						items: Object.entries(values).map(([path, value]) => ({
							path,
							label: path,
							description: "",
							type: typeof value === "boolean" ? "boolean" : "enum",
							value,
							changed: false,
						})),
					},
				],
			},
		],
	} as unknown as SettingsModel;
}

function withSettings(values: Record<string, unknown>): void {
	setState({ settingsModel: modelOf(values) });
}

describe("pinnedAgentsMode", () => {
	test("accepts the three SDK modes and falls back to the collapsed default", () => {
		expect(pinnedAgentsMode("off")).toBe("off");
		expect(pinnedAgentsMode("collapsed")).toBe("collapsed");
		expect(pinnedAgentsMode("full")).toBe("full");
		expect(pinnedAgentsMode(undefined)).toBe("collapsed");
		expect(pinnedAgentsMode("bogus")).toBe("collapsed");
	});
});

describe("layoutPinned", () => {
	test("lists every row with no expander when all rows fit", () => {
		expect(layoutPinned(PINNED_COLLAPSED_LIMIT, false)).toEqual({ rows: PINNED_COLLAPSED_LIMIT });
		expect(layoutPinned(0, false)).toEqual({ rows: 0 });
	});

	test("collapses to the limit with an expander when rows overflow", () => {
		expect(layoutPinned(5, false)).toEqual({ rows: PINNED_COLLAPSED_LIMIT, toggle: "expand" });
	});

	test("expanded lists every row with a collapse toggle", () => {
		expect(layoutPinned(5, true)).toEqual({ rows: 5, toggle: "collapse" });
	});
});

describe("pickProgress", () => {
	test("returns undefined for non-object payloads", () => {
		expect(pickProgress(undefined)).toBeUndefined();
		expect(pickProgress("running")).toBeUndefined();
		expect(pickProgress(null)).toBeUndefined();
	});

	test("keeps the rendered fields and the newest tool only", () => {
		const view = pickProgress({
			status: "running",
			currentTool: "bash",
			currentToolArgs: "ls",
			currentToolStartMs: 1000,
			lastTool: { tool: "read", args: "a.ts", isError: true },
			resolvedModel: "anthropic/claude-sonnet-5-5",
			resolvedThinkingLevel: "high",
			advisor: true,
		});
		expect(view?.status).toBe("running");
		expect(view?.currentTool).toBe("bash");
		expect(view?.currentToolStartMs).toBe(1000);
		expect(view?.lastTool).toEqual({
			tool: "read",
			args: "a.ts",
			intent: undefined,
			isError: true,
		});
		expect(view?.resolvedThinkingLevel).toBe("high");
		expect(view?.advisor).toBe(true);
	});

	test("ignores a bulk recentTools array the daemon no longer sends", () => {
		const view = pickProgress({
			status: "running",
			recentTools: [{ tool: "read", args: "a.ts" }],
		});
		expect(view?.lastTool).toBeUndefined();
	});
});

describe("toolPreview", () => {
	const running = (over: Partial<SubagentProgressView> = {}): SubagentProgressView => ({
		status: "running",
		currentTool: "bash",
		currentToolArgs: "ls -la",
		currentToolIntent: "list files",
		currentToolStartMs: 5000,
		...over,
	});

	test("is undefined unless the subagent is running", () => {
		expect(toolPreview(undefined)).toBeUndefined();
		expect(toolPreview(running({ status: "done" }))).toBeUndefined();
	});

	test("shows the in-flight call with its intent as detail", () => {
		expect(toolPreview(running())).toEqual({
			tool: "bash",
			detail: "list files",
			running: true,
			isError: false,
			startedAt: 5000,
		});
	});

	test("falls back to args when the call has no intent", () => {
		expect(toolPreview(running({ currentToolIntent: undefined }))?.detail).toBe("ls -la");
	});

	test("between calls, shows the most recent finished call and its error state", () => {
		const preview = toolPreview({
			status: "running",
			lastTool: { tool: "read", args: "a.ts", isError: true },
		});
		expect(preview).toEqual({
			tool: "read",
			detail: "a.ts",
			running: false,
			isError: true,
			startedAt: undefined,
		});
	});

	test("flattens newlines in the detail", () => {
		expect(toolPreview(running({ currentToolIntent: "line one\n\tline two" }))?.detail).toBe(
			"line one ↵ line two",
		);
	});
});

describe("elapsedLabel", () => {
	test("is undefined before the call outlasts the minimum or without a start", () => {
		expect(elapsedLabel(undefined, 99999)).toBeUndefined();
		expect(elapsedLabel(0, PREVIEW_ELAPSED_MIN_MS)).toBeUndefined();
	});

	test("formats seconds and minutes", () => {
		expect(elapsedLabel(0, 12_000)).toBe("12s");
		expect(elapsedLabel(0, 65_000)).toBe("1m05s");
	});
});

describe("modelBadge", () => {
	test("is undefined when the model could not be resolved", () => {
		expect(modelBadge(undefined)).toBeUndefined();
		expect(modelBadge({ status: "running" })).toBeUndefined();
	});

	test("prefers the resolved identity, drops an inherited thinking level, and flags advisors", () => {
		expect(
			modelBadge({
				status: "running",
				resolvedModel: "sonnet",
				resolvedModelIdentity: "anthropic/claude-sonnet-5-5",
				resolvedThinkingLevel: "inherit",
				advisor: true,
			}),
		).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: undefined, advisor: true });
	});

	test("sanitizes control characters and keeps an explicit thinking level", () => {
		expect(
			modelBadge({ status: "running", resolvedModel: "a\tb\nc", resolvedThinkingLevel: "high" }),
		).toEqual({
			model: "a b c",
			thinking: "high",
			advisor: false,
		});
	});
});

describe("displayTitle (title.icons)", () => {
	const CARD = "🧪 TST1: fix the parser";
	const NERD = "\uf0c9 TST1: fix the parser";

	test("passes nullish and plain titles through", () => {
		withSettings({ "title.icons": "nf+emoji" });
		expect(displayTitle(null)).toBeUndefined();
		expect(displayTitle(undefined)).toBeUndefined();
		expect(displayTitle("just a title")).toBe("just a title");
	});

	test("nf+emoji keeps an emoji card and drops a Nerd Font icon to the code", () => {
		withSettings({ "title.icons": "nf+emoji" });
		expect(displayTitle(CARD)).toBe(CARD);
		expect(displayTitle(NERD)).toBe("TST1: fix the parser");
	});

	test("emoji behaves the same as nf+emoji in the web", () => {
		withSettings({ "title.icons": "emoji" });
		expect(displayTitle(CARD)).toBe(CARD);
		expect(displayTitle(NERD)).toBe("TST1: fix the parser");
	});

	test("boring shows the bare title for any card", () => {
		withSettings({ "title.icons": "boring" });
		expect(displayTitle(CARD)).toBe("fix the parser");
		expect(displayTitle(NERD)).toBe("fix the parser");
	});
});
