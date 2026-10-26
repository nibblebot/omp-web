import { describe, expect, test } from "bun:test";
import type { SettingsItem, SettingsModel, SettingsTab } from "#lib/wire/protocol";
import {
	APPEARANCE_MENU_TAB,
	APPEARANCE_SDK_SETTINGS,
	appearanceSettingGroup,
	displayOptionValue,
	effectNote,
	filterSettings,
	filterWebUiSettings,
	isAppearanceSetting,
	searchSheetSettings,
	sheetGroups,
	settingLabel,
	unmetDependency,
} from "../../prefs/settings";

function item(partial: Partial<SettingsItem> & Pick<SettingsItem, "type">): SettingsItem {
	return {
		path: `test.${partial.type}`,
		label: `Test ${partial.type}`,
		description: "",
		value: null,
		changed: false,
		...partial,
	};
}

describe("displayOptionValue", () => {
	test("compaction thresholds map stored -1 to 'default'", () => {
		expect(
			displayOptionValue(item({ type: "submenu", path: "compaction.thresholdPercent" }), -1),
		).toBe("default");
		expect(
			displayOptionValue(item({ type: "submenu", path: "compaction.thresholdTokens" }), -1),
		).toBe("default");
	});

	test("other values pass through", () => {
		expect(
			displayOptionValue(item({ type: "submenu", path: "compaction.thresholdPercent" }), "50"),
		).toBe("50");
		expect(displayOptionValue(item({ type: "enum", path: "other.path" }), -1)).toBe("-1");
		expect(displayOptionValue(item({ type: "enum", path: "other.path" }), 0)).toBe("0");
	});

	test("null/undefined render as empty string", () => {
		expect(displayOptionValue(item({ type: "enum" }), null)).toBe("");
		expect(displayOptionValue(item({ type: "enum" }), undefined)).toBe("");
	});
});

describe("filterSettings", () => {
	const tabGeneral: SettingsTab = {
		id: "general",
		label: "General",
		groups: [
			{
				name: "",
				items: [
					item({
						type: "boolean",
						path: "ui.showTimestamps",
						label: "Show timestamps",
						description: "show time",
					}),
				],
			},
			{
				name: "Advanced",
				items: [
					item({
						type: "enum",
						path: "compaction.thresholdPercent",
						label: "Compaction percent",
						description: "compact at",
					}),
				],
			},
		],
	};
	const tabAppearance: SettingsTab = {
		id: "appearance",
		label: "Appearance",
		groups: [
			{
				name: "",
				items: [
					item({
						type: "text",
						path: "theme.name",
						label: "Max Tokens",
						description: "cap output",
					}),
					item({ type: "enum", path: "images.blockImages", label: "Block images" }),
					item({
						type: "boolean",
						path: "images.autoResize",
						label: "Auto-resize pastes",
						description: "shrink oversized images",
					}),
				],
			},
		],
	};
	const model: SettingsModel = { tabs: [tabGeneral, tabAppearance] };

	test("matches item path across tabs", () => {
		const matches = filterSettings(model, "thresholdPercent");
		expect(matches).toHaveLength(1);
		expect(matches[0].tab.label).toBe("General");
		expect(matches[0].item.path).toBe("compaction.thresholdPercent");
	});

	test("searches every appearance item, not only the Images group", () => {
		const max = filterSettings(model, "MAX");
		expect(max).toHaveLength(1);
		expect(max[0].tab.id).toBe("appearance");
		expect(max[0].item.path).toBe("theme.name");
		expect(filterSettings(model, "cap output")[0].item.path).toBe("theme.name");
		expect(filterSettings(model, "block images")[0].item.path).toBe("images.blockImages");
	});

	test("returns every matching item in tab order so callers can group by tab", () => {
		const matches = filterSettings(model, "images");
		expect(matches.map((match) => match.item.path)).toEqual([
			"images.blockImages",
			"images.autoResize",
		]);
		expect(matches.every((match) => match.tab.id === "appearance")).toBe(true);
	});

	test("returns [] for no match and for empty/whitespace queries", () => {
		expect(filterSettings(model, "nope")).toEqual([]);
		expect(filterSettings(model, "")).toEqual([]);
		expect(filterSettings(model, "   ")).toEqual([]);
	});
});

describe("filterWebUiSettings", () => {
	const attached = { sessionAttached: true, signedIn: true };
	test("finds non-model rows by label or keyword, each with its home tab", () => {
		expect(filterWebUiSettings("retry", attached)).toEqual([
			{ label: "Auto-Retry", tabId: "session" },
		]);
		expect(filterWebUiSettings("DESKTOP", attached)).toEqual([
			{ label: "Browser Notification Permission", tabId: "web-ui" },
		]);
		expect(filterWebUiSettings("oauth", attached)).toEqual([
			{ label: "Login Providers", tabId: "providers" },
		]);
		expect(filterWebUiSettings("   ", attached)).toEqual([]);
		expect(filterWebUiSettings("nothing matches this", attached)).toEqual([]);
	});
	test("offers session and sign-in rows only when the stream renders them", () => {
		const none = { sessionAttached: false, signedIn: false };
		expect(filterWebUiSettings("retry", none)).toEqual([]);
		expect(filterWebUiSettings("fast", none)).toEqual([]);
		expect(filterWebUiSettings("compact", none)).toEqual([]);
		expect(filterWebUiSettings("login", none)).toEqual([]);
		expect(filterWebUiSettings("sign out", none)).toEqual([]);
		const signedInOnly = { sessionAttached: false, signedIn: true };
		expect(filterWebUiSettings("sign out", signedInOnly)).toEqual([
			{ label: "Sign Out", tabId: "web-ui" },
		]);
	});
});

describe("unmetDependency and effectNote", () => {
	test("turn time needs token usage on", () => {
		const off = () => false;
		expect(unmetDependency("display.showTurnTime", off)).toBe(
			"Turn on Show Token Usage to use turn time.",
		);
		expect(
			unmetDependency("display.showTurnTime", (path) => path === "display.showTokenUsage"),
		).toBeNull();
		expect(unmetDependency("display.showTokenUsage", off)).toBeNull();
	});

	test("expanding thinking blocks needs thinking blocks shown", () => {
		const hidden = (path: string) => path === "hideThinkingBlock";
		expect(unmetDependency("expandThinkingBlocks", hidden)).toBe(
			"Turn on Show Thinking Blocks to expand them.",
		);
		expect(unmetDependency("expandThinkingBlocks", () => false)).toBeNull();
		// Unset reads as off, as the Show Thinking Blocks switch shows it.
		expect(unmetDependency("expandThinkingBlocks", () => undefined)).toBeNull();
		expect(unmetDependency("expandThinkingBlocks", () => null)).toBeNull();
		expect(unmetDependency("display.showTurnTime", () => undefined)).not.toBeNull();
		expect(unmetDependency("proseOnlyThinking", hidden)).toBe(
			"Turn on Show Thinking Blocks to use prose-only thinking.",
		);
		expect(unmetDependency("proseOnlyThinking", () => undefined)).toBeNull();
	});

	test("notes only next-session effects", () => {
		expect(effectNote("next-session")).not.toBeNull();
		expect(effectNote("live")).toBeNull();
		expect(effectNote("restart")).toBeNull();
		expect(effectNote(undefined)).toBeNull();
	});
});

describe("inverted hide flags", () => {
	test("show as their positive form, and search finds that form", () => {
		const hide = item({
			type: "boolean",
			path: "hideThinkingBlock",
			label: "Hide Thinking Blocks",
		});
		expect(settingLabel(hide)).toBe("Show Thinking Blocks");
		expect(settingLabel(item({ type: "boolean", path: "display.shimmer", label: "Shimmer" }))).toBe(
			"Shimmer",
		);
		const model = {
			tabs: [{ id: "appearance", label: "Display", groups: [{ name: "", items: [hide] }] }],
		} as unknown as SettingsModel;
		expect(filterSettings(model, "show thinking").map((m) => m.item.path)).toEqual([
			"hideThinkingBlock",
		]);
	});
});

describe("Appearance popover ownership", () => {
	const attached = { sessionAttached: true, signedIn: true };
	const tab: SettingsTab = {
		id: "appearance",
		label: "Appearance",
		groups: [
			{
				name: "Display",
				items: [
					item({ type: "boolean", path: "display.showTokenUsage", label: "Show Token Usage" }),
					item({ type: "boolean", path: "display.compactTools", label: "Compact tools" }),
				],
			},
			{
				name: "Images",
				items: [item({ type: "boolean", path: "terminal.showImages", label: "Show images" })],
			},
		],
	};
	const model: SettingsModel = { tabs: [tab] };

	test("names every popover SDK path once, with its group", () => {
		const paths = Object.values(APPEARANCE_SDK_SETTINGS).flat();
		expect(new Set(paths).size).toBe(paths.length);
		expect(isAppearanceSetting("hideThinkingBlock")).toBe(true);
		expect(isAppearanceSetting("display.shimmer")).toBe(true);
		expect(isAppearanceSetting("display.compactTools")).toBe(false);
		expect(appearanceSettingGroup("display.showTurnTime")).toBe("Status");
		expect(appearanceSettingGroup("terminal.showImages")).toBe("Transcript");
		expect(appearanceSettingGroup("images.autoResize")).toBeUndefined();
	});

	test("the sheet's groups drop popover rows and groups left empty", () => {
		const groups = sheetGroups(tab);
		expect(groups.map((group) => group.name)).toEqual(["Display"]);
		expect(groups[0]?.items.map((row) => row.path)).toEqual(["display.compactTools"]);
	});

	test("moved web rows point at the popover, not a tab", () => {
		for (const label of ["Theme", "Font Size", "Soft Fade", "Usage in Sidebar"]) {
			expect(filterWebUiSettings(label, attached)).toContainEqual({
				label,
				tabId: APPEARANCE_MENU_TAB,
			});
		}
		expect(filterWebUiSettings("two-line", attached)).toEqual([
			{ label: "Two-Line Session Titles", tabId: APPEARANCE_MENU_TAB },
		]);
	});

	test("sheet search renders only sheet-owned SDK rows and points at the popover for the rest", () => {
		const hits = searchSheetSettings(model, "show", attached);
		expect(hits.sdk.map((match) => match.item.path)).toEqual([]);
		expect(hits.pointers).toEqual([
			{ label: "Show Token Usage", tabId: APPEARANCE_MENU_TAB },
			{ label: "Show images", tabId: APPEARANCE_MENU_TAB },
		]);
		const compact = searchSheetSettings(model, "compact tools", attached);
		expect(compact.sdk.map((match) => match.item.path)).toEqual(["display.compactTools"]);
		expect(compact.pointers).toEqual([]);
		expect(searchSheetSettings(null, "theme", attached).pointers).toEqual([
			{ label: "Theme", tabId: APPEARANCE_MENU_TAB },
		]);
	});
});
