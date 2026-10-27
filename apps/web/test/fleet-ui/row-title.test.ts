import { describe, expect, test } from "bun:test";
import { rowTitle } from "../../fleet-ui/row-title";

const FILE = "/home/u/.omp/sessions/proj/2026-10-26T10-00-00.jsonl";

describe("rowTitle", () => {
	test("a real sessionTitle wins, trimmed", () => {
		expect(rowTitle({ sessionTitle: "  Fix the parser ", lastSessionFile: FILE })).toEqual({
			text: "Fix the parser",
			placeholder: false,
		});
	});

	test("a real title wins even when the session is flagged empty or has no file", () => {
		expect(rowTitle({ sessionTitle: "Fix", sessionEmpty: true, lastSessionFile: FILE }).text).toBe(
			"Fix",
		);
		expect(rowTitle({ sessionTitle: "Fix" }).placeholder).toBe(false);
	});

	test("no lastSessionFile reads as a new session", () => {
		expect(rowTitle({})).toEqual({ text: "New session", placeholder: true });
	});

	test("sessionEmpty true reads as a new session", () => {
		expect(rowTitle({ lastSessionFile: FILE, sessionEmpty: true })).toEqual({
			text: "New session",
			placeholder: true,
		});
	});

	test("messages but no title read as an untitled session", () => {
		expect(rowTitle({ lastSessionFile: FILE })).toEqual({
			text: "Untitled session",
			placeholder: true,
		});
		expect(rowTitle({ lastSessionFile: FILE, sessionEmpty: false }).text).toBe("Untitled session");
	});

	test("a blank title is not a real title", () => {
		expect(rowTitle({ sessionTitle: "   ", lastSessionFile: FILE })).toEqual({
			text: "Untitled session",
			placeholder: true,
		});
		expect(rowTitle({ sessionTitle: "", sessionEmpty: true, lastSessionFile: FILE }).text).toBe(
			"New session",
		);
	});
});
