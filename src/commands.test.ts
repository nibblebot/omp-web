import { describe, expect, test } from "bun:test";
import { handoffArgs, LOCAL_COMMANDS, parseInput, queueMethod, renameDispatch } from "./commands";

describe("parseInput", () => {
	test("plain text", () => {
		expect(parseInput("hello world")).toEqual({ kind: "text" });
	});

	test("bang-shell, normal and dimmed", () => {
		expect(parseInput("!ls -la")).toEqual({ kind: "bash", command: "ls -la", dimmed: false });
		expect(parseInput("!!secret")).toEqual({ kind: "bash", command: "secret", dimmed: true });
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
