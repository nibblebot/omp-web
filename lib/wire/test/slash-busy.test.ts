/**
 * jx0b (CMD-08): one busy policy for forwarded slash commands. A command runs
 * now only when it is proven read-only mid-turn; destructive commands refuse;
 * everything else (new SDK builtins, extensions, skills, files) queues.
 */
import { describe, expect, test } from "bun:test";
import { RUN_WHEN_BUSY_BUILTINS, slashBusyPolicy } from "../slash-busy";

describe("slashBusyPolicy", () => {
	test("read-only builtins run at once while a turn streams", () => {
		expect([...RUN_WHEN_BUSY_BUILTINS].sort()).toEqual(["changelog", "dirs", "jobs"]);
		for (const name of RUN_WHEN_BUSY_BUILTINS) {
			expect(slashBusyPolicy({ source: "builtin", name })).toBe("now");
		}
	});

	test("an unlisted builtin queues, so a new SDK builtin is safe by default", () => {
		expect(slashBusyPolicy({ source: "builtin", name: "brand-new-sdk-command" })).toBe("queue");
		expect(slashBusyPolicy({ source: "builtin", name: "add-dir" })).toBe("queue");
		expect(slashBusyPolicy({ source: "builtin", name: "remove-dir" })).toBe("queue");
	});

	test("extension commands queue: their handlers are not verified mid-turn", () => {
		expect(slashBusyPolicy({ source: "extension", name: "anything" })).toBe("queue");
	});

	test("skill, file, custom and MCP prompt commands queue", () => {
		for (const source of ["skill", "file", "custom", "mcp_prompt"] as const) {
			expect(slashBusyPolicy({ source, name: "x" })).toBe("queue");
		}
	});

	test("/session delete refuses while busy, in any letter case", () => {
		expect(slashBusyPolicy({ source: "builtin", name: "session", args: "delete" })).toBe("refuse");
		expect(slashBusyPolicy({ source: "builtin", name: "session", args: " Delete " })).toBe(
			"refuse",
		);
	});

	test("other /session forms: info runs now, pin and unknown verbs queue", () => {
		expect(slashBusyPolicy({ source: "builtin", name: "session", args: "info" })).toBe("now");
		expect(slashBusyPolicy({ source: "builtin", name: "session", args: "" })).toBe("now");
		expect(slashBusyPolicy({ source: "builtin", name: "session", args: "pin" })).toBe("queue");
		expect(slashBusyPolicy({ source: "builtin", name: "session", args: "rename" })).toBe("queue");
	});
});
