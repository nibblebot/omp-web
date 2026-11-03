import { describe, expect, test } from "bun:test";
import {
	alternativesIndex,
	alternativesKey,
	moreHint,
	predictionChoicesOf,
	shownPrediction,
} from "../../prompt/prediction-choices";

const CHOICES = ["Run the tests", "Run the tests again", "Commit it", "Open a PR"];

const key = (
	name: string,
	mods: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", true>> = {},
) => ({
	key: name,
	shiftKey: false,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	...mods,
});

describe("predictionChoicesOf", () => {
	test("a reply with choices offers them in order", () => {
		expect(predictionChoicesOf({ text: "a", choices: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
	});

	test("an older reply with text alone offers that one prediction", () => {
		expect(predictionChoicesOf({ text: "Run the tests" })).toEqual(["Run the tests"]);
	});

	test("a lone choice falls back to the text", () => {
		expect(predictionChoicesOf({ text: "a", choices: ["a"] })).toEqual(["a"]);
	});

	test("empty or malformed replies offer nothing", () => {
		expect(predictionChoicesOf(null)).toEqual([]);
		expect(predictionChoicesOf({ text: null })).toEqual([]);
		expect(predictionChoicesOf({ text: "" })).toEqual([]);
		expect(predictionChoicesOf({ text: null, choices: [1, null, ""] })).toEqual([]);
		expect(predictionChoicesOf("Run the tests")).toEqual([]);
	});

	test("non-string and empty choices are dropped", () => {
		expect(predictionChoicesOf({ text: "a", choices: ["a", 3, "", "b"] })).toEqual(["a", "b"]);
	});
});

describe("shownPrediction", () => {
	test("an empty draft follows the first prediction", () => {
		expect(shownPrediction(CHOICES, "", null)).toEqual({ index: 0, suffix: "Run the tests" });
	});

	test("the draft follows the first prediction it is a strict prefix of", () => {
		expect(shownPrediction(CHOICES, "Co", null)).toEqual({ index: 2, suffix: "mmit it" });
		expect(shownPrediction(CHOICES, "Run the tests ag", null)).toEqual({
			index: 1,
			suffix: "ain",
		});
	});

	test("a draft that is no prefix of any prediction shows nothing", () => {
		expect(shownPrediction(CHOICES, "Deploy", null)).toBeNull();
		expect(shownPrediction(CHOICES, "run", null)).toBeNull();
	});

	test("a draft equal to the longest matching prediction shows nothing", () => {
		expect(shownPrediction(CHOICES, "Open a PR", null)).toBeNull();
		expect(shownPrediction(["Open a PR"], "Open a PR", "Open a PR")).toBeNull();
	});

	test("a typed draft equal to a shorter prediction keeps the ghost of a longer one", () => {
		expect(shownPrediction(CHOICES, "Run the tests", null)).toEqual({
			index: 1,
			suffix: " again",
		});
	});

	test("after an insert equal to one of several predictions no ghost extends it", () => {
		expect(shownPrediction(CHOICES, "Run the tests", "Run the tests")).toBeNull();
	});

	test("an insert mark that no longer equals the draft does not hide the ghost", () => {
		expect(shownPrediction(CHOICES, "Run the tests", "Commit it")).toEqual({
			index: 1,
			suffix: " again",
		});
	});

	test("with one prediction an insert leaves nothing to extend, and an unrelated mark changes nothing", () => {
		expect(shownPrediction(["Run the tests"], "Run the", "Run the tests")).toEqual({
			index: 0,
			suffix: " tests",
		});
		expect(shownPrediction(["Run the tests"], "Run the tests", "Run the tests")).toBeNull();
	});

	test("a multi-line draft never matches, and no predictions show nothing", () => {
		expect(shownPrediction(CHOICES, "Run\nthe", null)).toBeNull();
		expect(shownPrediction([], "", null)).toBeNull();
	});
});

describe("alternativesIndex", () => {
	test("the draft equal to one of several predictions gives its rank", () => {
		expect(alternativesIndex(CHOICES, "Commit it")).toBe(2);
		expect(alternativesIndex(CHOICES, "Run the tests")).toBe(0);
	});

	test("one prediction, a non-matching draft or a multi-line draft gives none", () => {
		expect(alternativesIndex(["Run the tests"], "Run the tests")).toBeNull();
		expect(alternativesIndex(CHOICES, "Commit")).toBeNull();
		expect(alternativesIndex(CHOICES, "")).toBeNull();
		expect(alternativesIndex(["a\nb", "c"], "a\nb")).toBeNull();
	});
});

describe("moreHint", () => {
	test("right after an insert the hint counts the other predictions", () => {
		expect(moreHint(CHOICES, "Commit it", "Commit it")).toBe("⇥ 3 more");
		expect(moreHint(CHOICES, "Run the tests", "Run the tests")).toBe("⇥ 3 more");
	});

	test("a draft equal to the longest match shows the hint without an insert", () => {
		expect(moreHint(CHOICES, "Open a PR", null)).toBe("⇥ 3 more");
	});

	test("a typed draft that still has a ghost shows no hint", () => {
		expect(moreHint(CHOICES, "Run the tests", null)).toBe("");
		expect(moreHint(CHOICES, "Run", null)).toBe("");
	});

	test("a lone prediction or an edited draft shows no hint", () => {
		expect(moreHint(["Run the tests"], "Run the tests", "Run the tests")).toBe("");
		expect(moreHint(CHOICES, "Commit it!", null)).toBe("");
		expect(moreHint(CHOICES, "", null)).toBe("");
	});

	test("two predictions count one more", () => {
		expect(moreHint(["a", "b"], "b", "b")).toBe("⇥ 1 more");
	});
});

describe("alternativesKey", () => {
	test("Down and Up move the selection and wrap", () => {
		expect(alternativesKey(key("ArrowDown"), 0, 4)).toEqual({ kind: "move", selected: 1 });
		expect(alternativesKey(key("ArrowDown"), 3, 4)).toEqual({ kind: "move", selected: 0 });
		expect(alternativesKey(key("ArrowUp"), 0, 4)).toEqual({ kind: "move", selected: 3 });
	});

	test("Enter, Tab and Right swap in the selected prediction", () => {
		for (const name of ["Enter", "Tab", "ArrowRight"])
			expect(alternativesKey(key(name), 2, 4)).toEqual({ kind: "pick", index: 2 });
	});

	test("Escape closes and keeps the line", () => {
		expect(alternativesKey(key("Escape"), 1, 4)).toEqual({ kind: "close" });
	});

	test("shifted Enter and Tab, modified keys and typing are not the list's", () => {
		expect(alternativesKey(key("Enter", { shiftKey: true }), 0, 4)).toBeNull();
		expect(alternativesKey(key("Tab", { shiftKey: true }), 0, 4)).toBeNull();
		expect(alternativesKey(key("Enter", { ctrlKey: true }), 0, 4)).toBeNull();
		expect(alternativesKey(key("ArrowDown", { metaKey: true }), 0, 4)).toBeNull();
		expect(alternativesKey(key("a"), 0, 4)).toBeNull();
	});

	test("an empty list handles nothing", () => {
		expect(alternativesKey(key("Enter"), 0, 0)).toBeNull();
	});
});
