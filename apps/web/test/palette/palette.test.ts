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
		const off = openItems({ debugEnabled: false, integrationsEnabled: true, projects: [] }).map(
			(item) => item.label,
		);
		const on = openItems({ debugEnabled: true, integrationsEnabled: true, projects: [] }).map(
			(item) => item.label,
		);
		expect(off).not.toContain("Debug");
		expect(on).toContain("Debug");
	});

	test("Skills and MCP servers are listed only when the integrations feature is enabled", () => {
		const on = openItems({ debugEnabled: false, integrationsEnabled: true, projects: [] });
		const off = openItems({ debugEnabled: false, integrationsEnabled: false, projects: [] });
		expect(on.filter((item) => item.action.kind === "open").map((item) => item.label)).toEqual(
			expect.arrayContaining(["Skills", "MCP servers"]),
		);
		expect(off.map((item) => item.label)).not.toContain("Skills");
		expect(off.map((item) => item.label)).not.toContain("MCP servers");
	});

	test("sign-in and provider login are offered without a live session or signed-in state", () => {
		const labelsOut = openItems({
			debugEnabled: false,
			integrationsEnabled: true,
			projects: [],
		}).map((item) => item.label);
		expect(labelsOut).toContain("Sign in");
		expect(labelsOut).toContain("Provider login");
	});

	test("one new-workspace item per registered project", () => {
		const items = openItems({
			debugEnabled: false,
			integrationsEnabled: true,
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
});

describe("searchPalette", () => {
	test("an empty query lists the open targets", () => {
		const names = labels(
			sourcesWith(openItems({ debugEnabled: false, integrationsEnabled: true, projects: [] })),
			"",
		);
		expect(names).toContain("Settings");
		expect(names).toContain("Add project");
	});

	test("a query finds the matching open target", () => {
		const names = labels(
			sourcesWith(openItems({ debugEnabled: false, integrationsEnabled: true, projects: [] })),
			"sign",
		);
		expect(names).toContain("Sign in");
		expect(names).not.toContain("Settings");
	});
});
