/**
 * Unit tests for the transcript-browser hash routes (src/tx/util/route.ts):
 * parse and format round-trip, `?sub=` subagent links, stored routes, and
 * malformed hashes falling back to the list.
 */
import { describe, expect, test } from "bun:test";
import { parseTxHash, storedHash } from "../../../tx/util/route";
import { sessionHash } from "../../../store/slices/analysis";

describe("parseTxHash", () => {
	test("empty and root hashes are the list", () => {
		expect(parseTxHash("")).toEqual({ view: "list" });
		expect(parseTxHash("#")).toEqual({ view: "list" });
		expect(parseTxHash("#/")).toEqual({ view: "list" });
	});

	test("session file decodes each segment, with no sub", () => {
		expect(parseTxHash("#/s/proj%20a/chat%2301.jsonl")).toEqual({
			view: "session",
			file: "proj a/chat#01.jsonl",
			sub: null,
		});
	});

	test("?sub= names a subagent transcript inside the session", () => {
		expect(parseTxHash("#/s/main.jsonl?sub=child%2Fagent.jsonl")).toEqual({
			view: "session",
			file: "main.jsonl",
			sub: "child/agent.jsonl",
		});
	});

	test("empty ?sub= is treated as the main transcript", () => {
		expect(parseTxHash("#/s/main.jsonl?sub=")).toEqual({
			view: "session",
			file: "main.jsonl",
			sub: null,
		});
	});

	test("stored route decodes workspace and session", () => {
		expect(parseTxHash("#/stored/ws%201/sess1")).toEqual({
			view: "stored",
			workspaceId: "ws 1",
			sessionId: "sess1",
		});
	});

	test("malformed or unknown routes fall back to the list", () => {
		expect(parseTxHash("#/stored/a")).toEqual({ view: "list" });
		expect(parseTxHash("#/stored//sess1")).toEqual({ view: "list" });
		expect(parseTxHash("#/stored/%E0/sess1")).toEqual({ view: "list" });
		expect(parseTxHash("#/s/%E0.jsonl")).toEqual({ view: "list" });
		expect(parseTxHash("#/garbage")).toEqual({ view: "list" });
	});
});

describe("format and parse round-trip", () => {
	test("session links, with and without a subagent, parse back", () => {
		const file = "proj a/chat#01.jsonl";
		expect(parseTxHash(sessionHash(file, null))).toEqual({ view: "session", file, sub: null });
		expect(parseTxHash(sessionHash(file, "sub dir/agent.jsonl"))).toEqual({
			view: "session",
			file,
			sub: "sub dir/agent.jsonl",
		});
	});

	test("stored links parse back", () => {
		expect(parseTxHash(storedHash("ws 1", "sess/1"))).toEqual({
			view: "stored",
			workspaceId: "ws 1",
			sessionId: "sess/1",
		});
	});
});
