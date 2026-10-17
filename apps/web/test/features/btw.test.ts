import { beforeEach, describe, expect, test } from "bun:test";
import { parseInput } from "../../prompt/commands";
import { activateFeatures, featureCommand } from "../../features/registry";
import { setState, state } from "../../state";
import { btwDispatch } from "../../store/btw";

describe("btw feature", () => {
	beforeEach(async () => {
		await activateFeatures(["btw"]);
	});

	test("parseInput classifies /btw with and without a question", () => {
		expect(parseInput("/btw")).toEqual({ kind: "slash", name: "btw", args: "" });
		expect(parseInput("/btw what does this function do")).toEqual({
			kind: "slash",
			name: "btw",
			args: "what does this function do",
		});
		// parseInput keeps the trailing space verbatim (dispatchInput trims).
		expect(parseInput("/BTW  explain  main() ")).toEqual({
			kind: "slash",
			name: "btw",
			args: "explain  main() ",
		});
	});

	test("/btw bare opens the sheet, question asks", () => {
		expect(btwDispatch("")).toEqual({ kind: "sheet" });
		expect(btwDispatch("   ")).toEqual({ kind: "sheet" });
		expect(btwDispatch("what does this do")).toEqual({
			kind: "ask",
			question: "what does this do",
		});
	});

	test("bare /btw opens the btw modal and does not ask", () => {
		setState("modal", null);
		featureCommand("btw")!.command.run("");
		expect(state.modal).toBe("btw");
	});

	test("the btw-history command is gone (single sheet)", () => {
		expect(featureCommand("btw-history")).toBeUndefined();
	});
});
