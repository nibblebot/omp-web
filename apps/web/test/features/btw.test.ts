import { beforeEach, describe, expect, test } from "bun:test";
import { parseInput } from "../../prompt/commands";
import { activateFeatures, featureCommand, featureModal } from "../../features/registry";
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

	test("/btw bare opens panel, question asks", () => {
		expect(btwDispatch("")).toEqual({ kind: "panel" });
		expect(btwDispatch("   ")).toEqual({ kind: "panel" });
		expect(btwDispatch("what does this do")).toEqual({
			kind: "ask",
			question: "what does this do",
		});
	});

	test("btw and btw-history commands and the history modal come from the btw feature", () => {
		expect(featureCommand("btw")?.feature.id).toBe("btw");
		expect(featureCommand("btw-history")?.feature.id).toBe("btw");
		expect(featureModal("btw-history")).toBeFunction();
	});

	test("bare /btw-history opens the history modal", () => {
		setState("modal", null);
		featureCommand("btw-history")!.command.run("");
		expect(state.modal).toBe("btw-history");
	});
});
