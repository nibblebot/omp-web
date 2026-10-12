import { beforeEach, describe, expect, test } from "bun:test";
import { activateFeatures, featureCommand, featureModal } from "../../features/registry";
import { setState, state } from "../../state";

describe("integrations feature", () => {
	beforeEach(async () => {
		await activateFeatures(["integrations"]);
	});

	test("mcp and skills commands and modals come from the integrations feature", () => {
		expect(featureCommand("mcp")?.feature.id).toBe("integrations");
		expect(featureCommand("skills")?.feature.id).toBe("integrations");
		expect(featureModal("mcp")).toBeFunction();
		expect(featureModal("skills")).toBeFunction();
	});

	test("bare /mcp opens the MCP modal", () => {
		setState("modal", null);
		featureCommand("mcp")!.command.run("");
		expect(state.modal).toBe("mcp");
	});
});
