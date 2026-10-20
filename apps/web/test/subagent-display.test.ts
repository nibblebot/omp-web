import { describe, expect, test } from "bun:test";
import type { SettingsModel } from "#lib/wire/protocol";
import { displayTitle } from "../components/ui/title-icons";
import { setState } from "../state";
import { formatLiveLine, liveLineOf, modelView, pickProgress } from "../subagents/progress";

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

describe("modelView", () => {
	test("is undefined when the model is unknown", () => {
		expect(modelView(undefined)).toBeUndefined();
		expect(modelView({ status: "running" })).toBeUndefined();
	});

	test("prefers the resolved identity and takes the id from its last path segment", () => {
		expect(
			modelView({
				status: "running",
				resolvedModel: "sonnet",
				resolvedModelIdentity: "openrouter/anthropic/claude-sonnet-5-5",
				resolvedThinkingLevel: "high",
			}),
		).toEqual({
			id: "claude-sonnet-5-5",
			identity: "openrouter/anthropic/claude-sonnet-5-5",
			thinking: "high",
		});
	});

	test("reads the level from a provider/id:level string when no level is reported", () => {
		expect(modelView({ resolvedModel: "anthropic/claude-sonnet-5-5:high" })).toEqual({
			id: "claude-sonnet-5-5",
			identity: "anthropic/claude-sonnet-5-5",
			thinking: "high",
		});
	});

	test("a reported level beats the suffix, and an inherited level is dropped", () => {
		expect(modelView({ resolvedModel: "a/b:low", resolvedThinkingLevel: "medium" })?.thinking).toBe(
			"medium",
		);
		expect(
			modelView({ resolvedModel: "a/b", resolvedThinkingLevel: "inherit" })?.thinking,
		).toBeUndefined();
		expect(modelView({ resolvedModel: "a/b:inherit" })?.thinking).toBeUndefined();
	});

	test("keeps a colon that is part of the model id", () => {
		expect(modelView({ resolvedModelIdentity: "ollama/llama3:8b" })).toEqual({
			id: "llama3:8b",
			identity: "ollama/llama3:8b",
			thinking: undefined,
		});
	});

	test("sanitizes control characters", () => {
		expect(modelView({ resolvedModel: "x/a\tb\nc" })).toEqual({
			id: "a b c",
			identity: "x/a b c",
			thinking: undefined,
		});
	});
});

describe("liveLineOf", () => {
	test("prefers the in-flight tool with its intent", () => {
		expect(
			liveLineOf({
				currentTool: "bash",
				currentToolIntent: "Run tests",
				lastTool: { tool: "read", intent: "Read file" },
				lastIntent: "Thinking",
			}),
		).toEqual({ tool: "bash", intent: "Run tests" });
	});

	test("falls back to the last tool, flagging an error", () => {
		expect(
			liveLineOf({
				lastTool: { tool: "read", intent: "Read file", isError: true },
				lastIntent: "x",
			}),
		).toEqual({ tool: "read", intent: "Read file", isError: true });
		expect(liveLineOf({ lastTool: { tool: "read" } })?.isError).toBeUndefined();
	});

	test("falls back to the last intent alone, then to nothing", () => {
		expect(liveLineOf({ lastIntent: "Thinking" })).toEqual({ intent: "Thinking" });
		expect(liveLineOf({ status: "running" })).toBeUndefined();
		expect(liveLineOf(undefined)).toBeUndefined();
	});

	test("formats tool and intent, skipping a missing part", () => {
		expect(formatLiveLine({ tool: "bash", intent: "Run tests" })).toBe("bash · Run tests");
		expect(formatLiveLine({ tool: "bash" })).toBe("bash");
		expect(formatLiveLine({ intent: "Thinking" })).toBe("Thinking");
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
