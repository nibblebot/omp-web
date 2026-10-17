import { beforeEach, describe, expect, test } from "bun:test";
import { activateFeatures, featureCommand } from "../../features/registry";
import { invokeSkill } from "../../store/integrations";
import { promptInsert, setState, state } from "../../state";

describe("integrations feature", () => {
	beforeEach(async () => {
		await activateFeatures(["integrations"]);
		setState("modal", null);
	});

	test("bare /mcp opens the Integrations sheet on the MCP tab", () => {
		featureCommand("mcp")!.command.run("");
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("mcp");
	});

	test("bare /skills opens the Skills tab", () => {
		featureCommand("skills")!.command.run("");
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("skills");
	});

	test("/skills installed opens the Skills tab", () => {
		featureCommand("skills")!.command.run("installed");
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("skills");
	});

	test("/skills with a terminal-only subcommand does not open the sheet", () => {
		featureCommand("skills")!.command.run("search pdf");
		expect(state.modal).toBeNull();
	});

	test("Invoke closes the sheet and prefills /skill:<name> in the composer", () => {
		featureCommand("skills")!.command.run("");
		invokeSkill("pdf-extract");
		expect(state.modal).toBeNull();
		expect(promptInsert()).toEqual({ text: "/skill:pdf-extract " });
	});
});
