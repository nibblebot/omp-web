/**
 * Unit tests for the session-to-project grouping helper
 * (src/tx/util/project-groups.ts): groups are ordered by most-recent member,
 * sessions stay recent-first within a group, cwd-null sessions fall back to
 * their folder as the group key, and a single group still yields a rendered
 * group (uniform list look).
 */
import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../api";
import { groupSessionsByProject } from "./project-groups";

function session(
	file: string,
	opts: Partial<Pick<SessionSummary, "folder" | "cwd" | "lastTs">> = {},
): SessionSummary {
	return {
		file,
		folder: "proj-a",
		cwd: "/w/proj-a",
		title: null,
		id: null,
		firstTs: null,
		lastTs: null,
		turns: 0,
		toolCalls: 0,
		totalTokens: 0,
		totalCost: 0,
		errorTurns: 0,
		modelCount: 0,
		userMessages: 0,
		userChars: 0,
		synced: false,
		onDisk: true,
		size: 0,
		mtimeMs: 0,
		...opts,
	};
}

describe("groupSessionsByProject", () => {
	test("orders groups by their most-recent member's position in the server list", () => {
		// Server order (recent first): proj-b, proj-a, proj-c, proj-a.
		const list = [
			session("b/latest.jsonl", { folder: "proj-b", cwd: "/w/proj-b" }),
			session("a/older.jsonl", { folder: "proj-a", cwd: "/w/proj-a" }),
			session("c/oldest.jsonl", { folder: "proj-c", cwd: "/w/proj-c" }),
			session("a/even-older.jsonl", { folder: "proj-a", cwd: "/w/proj-a" }),
		];
		const groups = groupSessionsByProject(list);
		expect(groups.map((g) => g.key)).toEqual(["/w/proj-b", "/w/proj-a", "/w/proj-c"]);
		expect(groups.map((g) => g.sessions.map((s) => s.file))).toEqual([
			["b/latest.jsonl"],
			["a/older.jsonl", "a/even-older.jsonl"],
			["c/oldest.jsonl"],
		]);
	});

	test("keeps each group's sessions recent-first (server order preserved)", () => {
		const list = [
			session("a/third.jsonl", { cwd: "/w/proj-a" }),
			session("b/first.jsonl", { cwd: "/w/proj-b" }),
			session("b/second.jsonl", { cwd: "/w/proj-b" }),
			session("a/fourth.jsonl", { cwd: "/w/proj-a" }),
		];
		const groups = groupSessionsByProject(list);
		expect(groups[0]!.sessions.map((s) => s.file)).toEqual(["a/third.jsonl", "a/fourth.jsonl"]);
		expect(groups[1]!.sessions.map((s) => s.file)).toEqual(["b/first.jsonl", "b/second.jsonl"]);
	});

	test("uses folder as the key when cwd is null", () => {
		const list = [
			session("x/one.jsonl", { cwd: null, folder: "proj-x" }),
			session("x/two.jsonl", { cwd: null, folder: "proj-x" }),
		];
		const groups = groupSessionsByProject(list);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.key).toBe("proj-x");
		// Header label stays the folder.
		expect(groups[0]!.label).toBe("proj-x");
		expect(groups[0]!.sessions.map((s) => s.file)).toEqual(["x/one.jsonl", "x/two.jsonl"]);
	});

	test("single group still yields one group (header renders uniformly)", () => {
		const list = [
			session("a/second.jsonl"),
			session("a/first.jsonl", { folder: "proj-a", cwd: "/w/proj-a" }),
		];
		const groups = groupSessionsByProject(list);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.label).toBe("proj-a");
		expect(groups[0]!.sessions).toHaveLength(2);
	});

	test("distinct cwd under the same folder name groups separately (worktrees)", () => {
		const list = [
			session("main/latest.jsonl", { folder: "proj-a", cwd: "/w/proj-a" }),
			session("wt/latest.jsonl", { folder: "proj-a", cwd: "/w/proj-a-wt1" }),
		];
		const groups = groupSessionsByProject(list);
		expect(groups.map((g) => g.key)).toEqual(["/w/proj-a", "/w/proj-a-wt1"]);
		// Both headers carry the folder label for disambiguation.
		expect(groups.map((g) => g.label)).toEqual(["proj-a", "proj-a"]);
	});

	test("empty input yields no groups", () => {
		expect(groupSessionsByProject([])).toEqual([]);
	});
});
