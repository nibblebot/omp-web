import { beforeEach, describe, expect, test } from "bun:test";
import { activateFeatures, featureCommand } from "../../features/registry";
import { openItems } from "../../palette/palette";
import { setState, state } from "../../state";
import { runPaletteItem } from "../../store/palette";

describe("integrations feature", () => {
	beforeEach(async () => {
		await activateFeatures(["integrations"]);
		setState("modal", null);
	});

	test("bare /mcp opens the Extensions dialog with the MCP group focused", () => {
		featureCommand("mcp")!.command.run("");
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("extensions");
		expect(state.integrations.extensionsFocus).toBe("mcp");
	});

	test("bare /skills opens the Extensions dialog with the Skills group focused", () => {
		featureCommand("skills")!.command.run("");
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("extensions");
		expect(state.integrations.extensionsFocus).toBe("skill");
	});

	test("/skills installed opens the Skills group", () => {
		featureCommand("skills")!.command.run("installed");
		expect(state.modal).toBe("integrations");
		expect(state.integrations.extensionsFocus).toBe("skill");
	});

	test("/skills with a terminal-only subcommand does not open the dialog", () => {
		featureCommand("skills")!.command.run("search pdf");
		expect(state.modal).toBeNull();
	});

	test("the palette's Skills and MCP servers entries open the dialog on that group", () => {
		const items = openItems({ debugEnabled: false, integrationsEnabled: true, projects: [] });
		runPaletteItem(items.find((item) => item.label === "MCP servers")!);
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("extensions");
		expect(state.integrations.extensionsFocus).toBe("mcp");
		runPaletteItem(items.find((item) => item.label === "Skills")!);
		expect(state.integrations.extensionsFocus).toBe("skill");
	});
});
