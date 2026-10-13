import { beforeEach, describe, expect, test } from "bun:test";
import { activateFeatures, featureCommand } from "../../features/registry";
import { setState, state } from "../../state";

describe("integrations feature", () => {
	beforeEach(async () => {
		await activateFeatures(["integrations"]);
	});

	test("bare /mcp opens the MCP modal", () => {
		setState("modal", null);
		featureCommand("mcp")!.command.run("");
		expect(state.modal).toBe("mcp");
	});
});
