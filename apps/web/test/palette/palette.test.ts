import { describe, expect, test } from "bun:test";
import { APPEARANCE_MENU_TAB } from "../../prefs/settings";
import {
	flattenPalette,
	modelItems,
	openItems,
	rosterSessionItems,
	searchPalette,
	settingItems,
	type PaletteItem,
	type PaletteSources,
} from "../../palette/palette";
import type { ModelBrowserEntry, RosterEntry } from "#lib/wire/protocol";

const sourcesWith = (open: PaletteItem[]): PaletteSources => ({
	commands: null,
	open,
	sessions: [],
	settings: [],
	models: [],
	recents: [],
});

const labels = (sources: PaletteSources, query: string) =>
	flattenPalette(searchPalette(query, sources)).map((item) => item.label);

describe("openItems", () => {
	test("debug is listed only when the debug feature is enabled", () => {
		const off = openItems({
			debugEnabled: false,
			pluginsEnabled: true,
			projects: [],
		}).map((item) => item.label);
		const on = openItems({
			debugEnabled: true,
			pluginsEnabled: true,
			projects: [],
		}).map((item) => item.label);
		expect(off).not.toContain("Debug");
		expect(on).toContain("Debug");
	});

	test("Skills and MCP servers are always listed, and Plugins only when the plugins feature is enabled", () => {
		const context = { debugEnabled: false, projects: [] };
		const on = openItems({ ...context, pluginsEnabled: true }).map((item) => item.label);
		const off = openItems({ ...context, pluginsEnabled: false }).map((item) => item.label);
		expect(on).toEqual(expect.arrayContaining(["Skills", "MCP servers", "Plugins"]));
		expect(off).toEqual(expect.arrayContaining(["Skills", "MCP servers"]));
		expect(off).not.toContain("Plugins");
	});

	test("sign-in and provider login are offered without a live session or signed-in state", () => {
		const labelsOut = openItems({
			debugEnabled: false,
			pluginsEnabled: true,
			projects: [],
		}).map((item) => item.label);
		expect(labelsOut).toContain("Sign in");
		expect(labelsOut).toContain("Provider login");
	});

	test("one new-workspace item per registered project", () => {
		const items = openItems({
			debugEnabled: false,
			pluginsEnabled: true,
			projects: [
				{ projectId: "p1", name: "alpha" },
				{ projectId: "p2", name: "beta" },
			],
		});
		const workspaces = items.filter((item) => item.action.kind === "new-workspace");
		expect(workspaces.map((item) => item.label)).toEqual([
			"New workspace: alpha",
			"New workspace: beta",
		]);
	});

	test("a plain-folder project has no new-workspace item and does not count toward the label", () => {
		const items = openItems({
			debugEnabled: false,
			pluginsEnabled: true,
			projects: [
				{ projectId: "p1", name: "alpha" },
				{ projectId: "p2", name: "notes", git: false },
			],
		});
		const workspaces = items.filter((item) => item.action.kind === "new-workspace");
		expect(workspaces.map((item) => item.label)).toEqual(["New workspace"]);
	});
});

describe("rosterSessionItems", () => {
	const entry = (over: Partial<RosterEntry>): RosterEntry => ({
		workspaceId: "w1",
		name: "feature-x",
		project: "alpha",
		cwd: "/p/alpha",
		status: "ready",
		...over,
	});

	test("titles follow the row rule: real title, New session, Untitled session (never the worktree name)", () => {
		const items = rosterSessionItems(
			[
				entry({ workspaceId: "a", sessionTitle: "Fix the parser", lastSessionFile: "/s/a.jsonl" }),
				entry({ workspaceId: "b", lastSessionFile: "/s/b.jsonl", sessionEmpty: true }),
				entry({ workspaceId: "c" }),
				entry({ workspaceId: "d", lastSessionFile: "/s/d.jsonl" }),
			],
			"",
		);
		expect(items.map((item) => item.label)).toEqual([
			"Fix the parser",
			"New session",
			"New session",
			"Untitled session",
		]);
	});
});

describe("searchPalette", () => {
	test("an empty query lists the open targets", () => {
		const names = labels(
			sourcesWith(
				openItems({
					debugEnabled: false,
					pluginsEnabled: true,
					projects: [],
				}),
			),
			"",
		);
		expect(names).toContain("Settings");
		expect(names).toContain("Add project");
	});

	test("a query finds the matching open target", () => {
		const names = labels(
			sourcesWith(
				openItems({
					debugEnabled: false,
					pluginsEnabled: true,
					projects: [],
				}),
			),
			"sign",
		);
		expect(names).toContain("Sign in");
		expect(names).not.toContain("Settings");
	});
});

describe("settingItems", () => {
	const model = {
		tabs: [
			{
				id: "appearance",
				label: "Appearance",
				groups: [
					{
						name: "Display",
						items: [
							{
								path: "display.showTokenUsage",
								label: "Show Token Usage",
								description: "",
								type: "boolean" as const,
								value: false,
								changed: false,
							},
							{
								path: "images.autoResize",
								label: "Auto-resize images",
								description: "",
								type: "boolean" as const,
								value: true,
								changed: false,
							},
						],
					},
				],
			},
		],
	};
	const byLabel = (items: PaletteItem[], label: string) =>
		items.find((item) => item.label === label);

	test("rows the Appearance popover owns open it instead of a settings tab", () => {
		const items = settingItems(model, [], [{ label: "Soft Fade", tabId: APPEARANCE_MENU_TAB }]);
		expect(byLabel(items, "Show Token Usage")?.action).toEqual({
			kind: "open",
			target: "appearance",
		});
		expect(byLabel(items, "Show Token Usage")?.detail).toBe("Appearance menu · Status");
		expect(byLabel(items, "Soft Fade")?.action).toEqual({ kind: "open", target: "appearance" });
		expect(byLabel(items, "Soft Fade")?.detail).toBe("Appearance menu");
		expect(byLabel(items, "Auto-resize images")?.action).toEqual({
			kind: "setting",
			tabId: "appearance",
			query: "Auto-resize images",
		});
	});

	test("Appearance is an Open entry that a query finds", () => {
		const open = openItems({ debugEnabled: false, pluginsEnabled: false, projects: [] });
		expect(labels(sourcesWith(open), "theme")).toContain("Appearance");
	});
});

describe("modelItems", () => {
	const row = (
		provider: string,
		id: string,
		kind: ModelBrowserEntry["kind"],
	): ModelBrowserEntry => ({
		provider,
		id,
		kind,
		contextWindow: 1,
		reasoning: false,
	});

	test("offers only chat rows for session switching", () => {
		const catalog = [
			row("anthropic", "opus", "chat"),
			row("web", "exa", "search"),
			row("local", "kokoro", "tts"),
		];
		const ids = modelItems(catalog, ["web/exa", "anthropic/opus"], undefined, true).map(
			(item) => item.id,
		);
		expect(ids).toEqual(["model:picker", "model:anthropic/opus"]);
	});
});
