import { describe, expect, test } from "bun:test";
import { goalDispatch } from "../../features/goal-dispatch";
import {
	GOAL_OBJECTIVE_MAX,
	goalCreateArgs,
	goalReplaceArgs,
	parseGoalBudget,
	validateObjective,
	validLoopLimit,
} from "../../store/goals";

describe("goals feature dispatch", () => {
	test("/goal set starts the goal, collapsing the objective whitespace", () => {
		expect(goalDispatch("set implement the API")).toEqual({
			kind: "start",
			objective: "implement the API",
		});
		expect(goalDispatch("set   padded   objective  ")).toEqual({
			kind: "start",
			objective: "padded objective",
		});
	});

	test("/goal pause, resume, and drop map to store actions", () => {
		expect(goalDispatch("pause")).toEqual({ kind: "pause" });
		expect(goalDispatch("resume")).toEqual({ kind: "resume" });
		expect(goalDispatch("drop")).toEqual({ kind: "drop" });
	});

	test("bare or unknown /goal opens the dialog instead of prompting", () => {
		expect(goalDispatch("")).toEqual({ kind: "popover" });
		expect(goalDispatch("   ")).toEqual({ kind: "popover" });
		expect(goalDispatch("set")).toEqual({ kind: "popover" });
		expect(goalDispatch("wat")).toEqual({ kind: "popover" });
		expect(goalDispatch("show")).toEqual({ kind: "popover" });
	});

	test("stray args on pause, resume, and drop open the dialog, never act", () => {
		expect(goalDispatch("pause extra")).toEqual({ kind: "popover" });
		expect(goalDispatch("resume extra")).toEqual({ kind: "popover" });
		expect(goalDispatch("drop extra")).toEqual({ kind: "popover" });
	});

	test("/goal budget N sets the budget and budget off clears it", () => {
		expect(goalDispatch("budget 5000")).toEqual({ kind: "budget", tokenBudget: 5000 });
		expect(goalDispatch("budget off")).toEqual({ kind: "budget", tokenBudget: undefined });
	});

	test("invalid /goal budget arguments return an error without a budget action", () => {
		expect(goalDispatch("budget")).toEqual({
			kind: "error",
			message: "usage: /goal budget <tokens|off>",
		});
		expect(goalDispatch("budget 5000 extra")).toEqual({
			kind: "error",
			message: "usage: /goal budget <tokens|off>",
		});
		expect(goalDispatch("budget 0").kind).toBe("error");
		expect(goalDispatch("budget -5").kind).toBe("error");
		expect(goalDispatch("budget 1.5").kind).toBe("error");
		expect(goalDispatch("budget 10000001").kind).toBe("error");
	});
});

describe("goal store validators", () => {
	test("parseGoalBudget accepts positive integers and rejects everything else", () => {
		expect(parseGoalBudget("5000")).toEqual({ tokenBudget: 5000 });
		expect(parseGoalBudget(" 42 ")).toEqual({ tokenBudget: 42 });
		expect("error" in parseGoalBudget("0")).toBe(true);
		expect("error" in parseGoalBudget("-5")).toBe(true);
		expect("error" in parseGoalBudget("1.5")).toBe(true);
		expect("error" in parseGoalBudget("10000001")).toBe(true);
	});

	test("validateObjective requires text and caps its length", () => {
		expect(validateObjective("   ")).toBe("objective is required");
		expect(validateObjective("ship it")).toBeUndefined();
		expect(validateObjective("x".repeat(GOAL_OBJECTIVE_MAX + 1))).toBeDefined();
	});

	test("validLoopLimit matches the count and duration grammars", () => {
		expect(validLoopLimit("count", "5")).toBe(true);
		expect(validLoopLimit("count", "0")).toBe(false);
		expect(validLoopLimit("duration", "10m")).toBe(true);
		expect(validLoopLimit("duration", "1h30m")).toBe(true);
		expect(validLoopLimit("duration", "10")).toBe(false);
	});
});

describe("goal wire arguments", () => {
	test("goalCreate sends the object form with consent, and the budget only when set", () => {
		expect(goalCreateArgs("ship it", undefined)).toEqual([{ objective: "ship it", consent: true }]);
		expect(goalCreateArgs("ship it", 5000)).toEqual([
			{ objective: "ship it", tokenBudget: 5000, consent: true },
		]);
	});

	test("goalReplace sends the objective first, then the consent options", () => {
		expect(goalReplaceArgs("ship it", undefined)).toEqual(["ship it", { consent: true }]);
		expect(goalReplaceArgs("ship it", 5000)).toEqual([
			"ship it",
			{ tokenBudget: 5000, consent: true },
		]);
	});
});
