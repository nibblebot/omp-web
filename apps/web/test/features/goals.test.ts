import { beforeEach, describe, expect, test } from "bun:test";
import { goalDispatch } from "../../features/goal-dispatch";
import { activateFeatures, featureCommand } from "../../features/registry";

describe("goals feature", () => {
	beforeEach(async () => {
		await activateFeatures(["goals"]);
	});

	test("/goal is registered as a feature command with its detail string", () => {
		expect(featureCommand("goal")?.command.detail).toBe(
			"Goal controls (/goal set|show|pause|resume|drop|budget)",
		);
	});

	test("/goal subcommands route to goalRuntime relay rows", () => {
		expect(goalDispatch("set implement the API")).toEqual({
			kind: "call",
			method: "goalCreate",
			args: ["implement the API"],
		});
		expect(goalDispatch("set   padded   objective  ")).toEqual({
			kind: "call",
			method: "goalCreate",
			args: ["padded objective"],
		});
		expect(goalDispatch("pause")).toEqual({ kind: "call", method: "goalPause", args: [] });
		expect(goalDispatch("resume")).toEqual({ kind: "call", method: "goalResume", args: [] });
		expect(goalDispatch("drop")).toEqual({ kind: "call", method: "goalDrop", args: [] });
	});

	test("bare or unknown /goal opens the popover instead of prompting", () => {
		expect(goalDispatch("")).toEqual({ kind: "popover" });
		expect(goalDispatch("   ")).toEqual({ kind: "popover" });
		expect(goalDispatch("set")).toEqual({ kind: "popover" });
		expect(goalDispatch("wat")).toEqual({ kind: "popover" });
	});

	test("/goal show and budget open the popover, stray args do not call", () => {
		expect(goalDispatch("show")).toEqual({ kind: "popover" });
		expect(goalDispatch("budget 5000")).toEqual({ kind: "popover" });
		expect(goalDispatch("budget off")).toEqual({ kind: "popover" });
		expect(goalDispatch("pause extra")).toEqual({ kind: "popover" });
		expect(goalDispatch("resume extra")).toEqual({ kind: "popover" });
		expect(goalDispatch("drop extra")).toEqual({ kind: "popover" });
		expect(goalDispatch("pause")).toEqual({ kind: "call", method: "goalPause", args: [] });
	});
});
