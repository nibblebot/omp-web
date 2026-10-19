import { describe, expect, test } from "bun:test";
import type { ClientCommand } from "#lib/wire/protocol";
import { parseClientCommand } from "../client-command";

describe("parseClientCommand", () => {
	test("accepts a well-formed call and passes it through unchanged", () => {
		const cmd = { type: "call", id: "c1", method: "prompt", args: ["hi"] } satisfies ClientCommand;
		expect(parseClientCommand(cmd)).toBe(cmd);
	});

	test("rejects non-object bodies that JSON.parse can produce", () => {
		for (const raw of [null, 42, "text", true, []]) {
			expect(() => parseClientCommand(raw)).toThrow("must be a JSON object");
		}
	});

	test("rejects a missing or empty type or id", () => {
		expect(() => parseClientCommand({ id: "x" })).toThrow("string type");
		expect(() => parseClientCommand({ type: "call", id: "" })).toThrow("string id");
		expect(() => parseClientCommand({ type: "", id: "x" })).toThrow("string type");
	});

	test("rejects a call without a method name or with non-array args", () => {
		expect(() => parseClientCommand({ type: "call", id: "x" })).toThrow("string method");
		expect(() => parseClientCommand({ type: "call", id: "x", method: "" })).toThrow(
			"string method",
		);
		expect(() =>
			parseClientCommand({ type: "call", id: "x", method: "prompt", args: "hi" }),
		).toThrow("args must be an array");
	});
});
