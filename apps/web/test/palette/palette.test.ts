import { describe, expect, test } from "bun:test";
import {
	flattenPalette,
	openItems,
	searchPalette,
	type PaletteItem,
	type PaletteSources,
} from "../../palette/palette";

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
		const off = openItems({ debugEnabled: false, projects: [] }).map((item) => item.label);
		const on = openItems({ debugEnabled: true, projects: [] }).map((item) => item.label);
		expect(off).not.toContain("Debug");
		expect(on).toContain("Debug");
	});

	test("sign-in and provider login are offered without a live session or signed-in state", () => {
		const labelsOut = openItems({ debugEnabled: false, projects: [] }).map((item) => item.label);
		expect(labelsOut).toContain("Sign in");
		expect(labelsOut).toContain("Provider login");
	});

	test("one workspace item per registered project", () => {
		const items = openItems({
			debugEnabled: false,
			projects: [
				{ projectId: "p1", name: "alpha" },
				{ projectId: "p2", name: "beta" },
			],
		});
		const workspaces = items.filter(
			(item) => item.action.kind === "open" && item.action.target === "workspace",
		);
		expect(workspaces.map((item) => item.label)).toEqual([
			"Add workspace: alpha",
			"Add workspace: beta",
		]);
	});
});

describe("searchPalette", () => {
	test("an empty query lists the open targets", () => {
		const names = labels(sourcesWith(openItems({ debugEnabled: false, projects: [] })), "");
		expect(names).toContain("Settings");
		expect(names).toContain("Add project");
	});

	test("a query finds the matching open target", () => {
		const names = labels(sourcesWith(openItems({ debugEnabled: false, projects: [] })), "sign");
		expect(names).toContain("Sign in");
		expect(names).not.toContain("Settings");
	});
});
