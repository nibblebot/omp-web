import { describe, expect, test } from "bun:test";
import {
	goalDispatch,
	handoffArgs,
	LOCAL_COMMANDS,
	parseInput,
	planDispatch,
	queueMethod,
	renameDispatch,
} from "./commands";
import { setState, state } from "./state";

describe("parseInput", () => {
	test("plain text", () => {
		expect(parseInput("hello world")).toEqual({ kind: "text" });
	});

	test("bang-shell, normal and dimmed", () => {
		expect(parseInput("!ls -la")).toEqual({ kind: "bash", command: "ls -la", dimmed: false });
		expect(parseInput("!!secret")).toEqual({ kind: "bash", command: "secret", dimmed: true });
	});

	test("python-shell, normal and excluded", () => {
		expect(parseInput("$print(2+2)")).toEqual({ kind: "python", code: "print(2+2)", dimmed: false });
		expect(parseInput("$$print('secret')")).toEqual({ kind: "python", code: "print('secret')", dimmed: true });
	});

	test("$$ is not $ with an extra $; both trim surrounding space", () => {
		expect(parseInput("$ print(2+2)")).toEqual({ kind: "python", code: "print(2+2)", dimmed: false });
		expect(parseInput("$$  print(1)")).toEqual({ kind: "python", code: "print(1)", dimmed: true });
	});

	test("lone $ is an empty python call, not text", () => {
		expect(parseInput("$")).toEqual({ kind: "python", code: "", dimmed: false });
		expect(parseInput("$$")).toEqual({ kind: "python", code: "", dimmed: true });
	});

	test("slash with and without args", () => {
		expect(parseInput("/compact focus on api")).toEqual({ kind: "slash", name: "compact", args: "focus on api" });
		expect(parseInput("/new")).toEqual({ kind: "slash", name: "new", args: "" });
	});

	test("slash name is case-insensitive", () => {
		expect(parseInput("/HELP")).toEqual({ kind: "slash", name: "help", args: "" });
	});

	test("lone prefixes are not bash/slash", () => {
		expect(parseInput("!")).toEqual({ kind: "bash", command: "", dimmed: false });
		expect(parseInput("not /a command")).toEqual({ kind: "text" });
	});
});

describe("queue shorthand", () => {
	test("-> forces steer-queue, prefix stripped", () => {
		expect(parseInput("-> fix the typo")).toEqual({ kind: "queue", steering: true, text: "fix the typo" });
	});

	test("=> forces follow-up queue, prefix stripped", () => {
		expect(parseInput("=> after this, summarize")).toEqual({ kind: "queue", steering: false, text: "after this, summarize" });
	});

	test("prefixes without a trailing space stay plain text", () => {
		expect(parseInput("->nospace")).toEqual({ kind: "text" });
		expect(parseInput("=>nospace")).toEqual({ kind: "text" });
		expect(parseInput("a -> b")).toEqual({ kind: "text" });
	});

	test("method selection respects streaming state", () => {
		expect(queueMethod(true, true)).toBe("steer");
		// Idle fallback: steer errors on an idle session, Enter sends a prompt.
		expect(queueMethod(true, false)).toBe("prompt");
		expect(queueMethod(false, true)).toBe("followUp");
		expect(queueMethod(false, false)).toBe("followUp");
	});

	test("/queue is a local follow-up command", () => {
		expect(LOCAL_COMMANDS.queue).toBeFunction();
	});
});

describe("LOCAL_COMMANDS table", () => {
	test("covers the Phase 2 web-local set", () => {
		for (const name of ["new", "clear", "compact", "help", "hotkeys", "exit", "quit"]) {
			expect(LOCAL_COMMANDS[name]).toBeFunction();
		}
	});

	test("covers the Phase 8 session-command set", () => {
		for (const name of ["retry", "fork", "fresh", "handoff", "drop", "dump", "rename"]) {
			expect(LOCAL_COMMANDS[name]).toBeFunction();
		}
	});
});

describe("session command parsing", () => {
	test("/rename with a title renames directly, no LLM round-trip", () => {
		expect(renameDispatch("My Session")).toEqual({ method: "setSessionName", title: "My Session" });
		expect(renameDispatch("  padded title  ")).toEqual({ method: "setSessionName", title: "padded title" });
	});

	test("bare /rename keeps the agent auto-title passthrough", () => {
		expect(renameDispatch("")).toEqual({ method: "prompt", text: "/rename" });
		expect(renameDispatch("   ")).toEqual({ method: "prompt", text: "/rename" });
	});

	test("/handoff joins free-text focus into one optional instructions arg", () => {
		expect(handoffArgs("focus on the api layer")).toEqual(["focus on the api layer"]);
		expect(handoffArgs("")).toEqual([undefined]);
		expect(handoffArgs("   ")).toEqual([undefined]);
	});
});

describe("goal/plan local commands", () => {
	test("LOCAL_COMMANDS covers goal and plan", () => {
		expect(LOCAL_COMMANDS.goal).toBeFunction();
		expect(LOCAL_COMMANDS.plan).toBeFunction();
	});

	test("parseInput classifies /goal and /plan as slash (local dispatch gate, not passthrough)", () => {
		expect(parseInput("/goal set implement the API")).toEqual({
			kind: "slash",
			name: "goal",
			args: "set implement the API",
		});
		expect(parseInput("/goal pause")).toEqual({ kind: "slash", name: "goal", args: "pause" });
		expect(parseInput("/plan")).toEqual({ kind: "slash", name: "plan", args: "" });
	});

	test("/goal subcommands route to goalRuntime relay rows", () => {
		expect(goalDispatch("set implement the API")).toEqual({ kind: "call", method: "goalCreate", args: ["implement the API"] });
		expect(goalDispatch("set   padded   objective  ")).toEqual({ kind: "call", method: "goalCreate", args: ["padded objective"] });
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

	test("/plan toggles planModeEnabled via setPlanModeState", () => {
		const before = state.planModeEnabled;
		expect(planDispatch().args[0].enabled).toBe(!before);
		expect(planDispatch().args[0].planFilePath).toBe("");
		// Flip the store and confirm the toggle inverts.
		setState("planModeEnabled", !before);
		expect(planDispatch().args[0].enabled).toBe(before);
		// Restore for sibling tests.
		setState("planModeEnabled", before);
	});
});
