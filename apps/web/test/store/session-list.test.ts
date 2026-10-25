import { describe, expect, test } from "bun:test";
import type { SessionStatus, SessionListEntry } from "#lib/wire/protocol";
import {
	type SessionRow,
	formatSessionAge,
	groupSessions,
	matchSessionRow,
	normalizeSessionTitle,
	resolveSessionOwner,
	sessionDisplayTitle,
	sessionExpandText,
	sessionRowFromListEntry,
	sessionStatus,
	validateSessionDelete,
} from "../../store/session-list";

const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime();
const HOUR = 3_600_000;

function row(overrides: Partial<SessionRow> & { id: string }): SessionRow {
	return {
		file: `/sessions/${overrides.id}.jsonl`,
		cwd: "/work/app",
		projectLabel: "app",
		modifiedMs: NOW,
		messageCount: 2,
		pinned: false,
		scope: "local",
		...overrides,
	};
}

describe("groupSessions", () => {
	test("orders Pinned, Today, Earlier; newest first within each; counts sum to total", () => {
		const rows = [
			row({ id: "old", modifiedMs: NOW - 3 * 24 * HOUR }),
			row({ id: "today-a", modifiedMs: NOW - HOUR }),
			row({ id: "pin-old", pinned: true, modifiedMs: NOW - 5 * 24 * HOUR }),
			row({ id: "today-b", modifiedMs: NOW - 2 * HOUR }),
			row({ id: "pin-new", pinned: true, modifiedMs: NOW - 10 * HOUR }),
		];
		const grouped = groupSessions(rows, NOW);
		expect(grouped.groups.map((g) => g.key)).toEqual(["pinned", "today", "earlier"]);
		expect(grouped.groups[0].rows.map((r) => r.id)).toEqual(["pin-new", "pin-old"]);
		expect(grouped.groups[1].rows.map((r) => r.id)).toEqual(["today-a", "today-b"]);
		expect(grouped.groups[2].rows.map((r) => r.id)).toEqual(["old"]);
		expect(grouped.total).toBe(5);
		expect(grouped.groups.reduce((sum, g) => sum + g.count, 0)).toBe(grouped.total);
	});

	test("omits empty groups and reports zero total for no rows", () => {
		expect(groupSessions([], NOW)).toEqual({ groups: [], total: 0 });
		const only = groupSessions([row({ id: "a", modifiedMs: NOW - 4 * 24 * HOUR })], NOW);
		expect(only.groups.map((g) => g.key)).toEqual(["earlier"]);
		expect(only.total).toBe(1);
	});

	test("a pinned row from any day sits in Pinned, not Earlier", () => {
		const grouped = groupSessions([row({ id: "p", pinned: true, modifiedMs: 0 })], NOW);
		expect(grouped.groups.map((g) => g.key)).toEqual(["pinned"]);
	});
});

describe("sessionDisplayTitle", () => {
	test("uses the explicit title", () => {
		const r = row({ id: "s1", title: "Refactor auth", firstMessage: "fix the login bug" });
		expect(sessionDisplayTitle(r)).toBe("Refactor auth");
	});

	test("untitled rows fall back to the first prompt line, never the raw id", () => {
		const r = row({ id: "0123abcd-deadbeef", firstMessage: "  add dark mode\nsecond line" });
		expect(sessionDisplayTitle(r)).toBe("add dark mode");
		expect(sessionDisplayTitle(r)).not.toContain("0123abcd");
	});

	test("an id-valued title is ignored and '(no messages)' is not a prompt", () => {
		const r = row({ id: "abc", title: "abc", firstMessage: "(no messages)" });
		const title = sessionDisplayTitle(r);
		expect(title.startsWith("Untitled")).toBe(true);
		expect(title).not.toContain("abc");
	});

	test("long prompts are truncated with an ellipsis", () => {
		const long = "x".repeat(300);
		const r = row({ id: "s3", firstMessage: long });
		expect(sessionDisplayTitle(r).length).toBe(80);
		expect(sessionDisplayTitle(r).endsWith("…")).toBe(true);
	});
});

describe("sessionExpandText", () => {
	test("prefers the latest conversation over the first prompt", () => {
		expect(sessionExpandText(row({ id: "a", recentText: " tail ", firstMessage: "head" }))).toBe(
			"tail",
		);
	});

	test("falls back to the first prompt, and to nothing for '(no messages)'", () => {
		expect(sessionExpandText(row({ id: "a", title: "Named", firstMessage: "head" }))).toBe("head");
		expect(sessionExpandText(row({ id: "a", firstMessage: "(no messages)" }))).toBe("");
		expect(sessionExpandText(row({ id: "a" }))).toBe("");
	});

	test("omits a first prompt the untitled row already shows whole as its title", () => {
		expect(sessionExpandText(row({ id: "a", firstMessage: "fix the sidebar" }))).toBe("");
		const multiLine = "fix the sidebar\nand the dropdown";
		expect(sessionExpandText(row({ id: "a", firstMessage: multiLine }))).toBe(multiLine);
		const long = "x".repeat(81);
		expect(sessionExpandText(row({ id: "a", firstMessage: long }))).toBe(long);
	});
});

describe("sessionRowFromListEntry", () => {
	const entry: SessionListEntry = {
		path: "/sessions/a.jsonl",
		id: "a",
		name: "Billing",
		cwd: "/srv/payments",
		modifiedAt: NOW,
		messageCount: 4,
		firstMessage: "migrate invoices",
		status: "error",
	};

	test("maps the fleet entry to an unpinned local row and flags the current file", () => {
		expect(sessionRowFromListEntry(entry, "/sessions/a.jsonl")).toEqual({
			id: "a",
			file: "/sessions/a.jsonl",
			title: "Billing",
			firstMessage: "migrate invoices",
			status: "error",
			cwd: "/srv/payments",
			projectLabel: "payments",
			modifiedMs: NOW,
			messageCount: 4,
			pinned: false,
			scope: "local",
			current: true,
		});
		expect(sessionRowFromListEntry(entry, undefined).current).toBe(false);
	});

	test("omits absent optional fields", () => {
		const bare = sessionRowFromListEntry(
			{ path: "/s/b.jsonl", id: "b", cwd: "/w/app", modifiedAt: 1, messageCount: 0 },
			undefined,
		);
		expect(bare).not.toHaveProperty("title");
		expect(bare).not.toHaveProperty("firstMessage");
		expect(bare).not.toHaveProperty("status");
	});

	test("an unrecognized status string is dropped", () => {
		const r = sessionRowFromListEntry(
			{
				path: "/s/c.jsonl",
				id: "c",
				cwd: "/w/app",
				modifiedAt: 1,
				messageCount: 1,
				status: "bogus" as SessionListEntry["status"],
			},
			undefined,
		);
		expect(r).not.toHaveProperty("status");
	});
});

describe("matchSessionRow", () => {
	const r = row({
		id: "7f3e2a10-session",
		title: "Billing cleanup",
		cwd: "/srv/payments",
		firstMessage: "migrate invoices table",
		recentText: "the rollback script needs a dry run",
	});

	test("matches title, cwd, id, first prompt and recent conversation text, case-insensitively", () => {
		expect(matchSessionRow(r, "BILLING")).toBe(true);
		expect(matchSessionRow(r, "payments")).toBe(true);
		expect(matchSessionRow(r, "7f3e2a10")).toBe(true);
		expect(matchSessionRow(r, "invoices")).toBe(true);
		expect(matchSessionRow(r, "dry run")).toBe(true);
	});

	test("every term must match; unmatched query excludes the row", () => {
		expect(matchSessionRow(r, "invoices billing")).toBe(true);
		expect(matchSessionRow(r, "invoices nonexistent")).toBe(false);
	});
});

describe("validateSessionDelete", () => {
	const ctx = { attachedFile: "/sessions/current.jsonl", manageAvailable: true };

	test("accepts a .jsonl session with an id and file", () => {
		expect(validateSessionDelete({ id: "a", file: "/sessions/a.jsonl" }, ctx)).toEqual({
			ok: true,
			current: false,
		});
	});

	test("marks the attached session as current", () => {
		expect(
			validateSessionDelete({ id: "c", file: "/sessions/current.jsonl", current: true }, ctx),
		).toEqual({ ok: true, current: true });
	});

	test("refuses non-jsonl files, missing ids and files", () => {
		expect(validateSessionDelete({ id: "a", file: "/sessions/a.txt" }, ctx).ok).toBe(false);
		expect(validateSessionDelete({ id: "", file: "/sessions/a.jsonl" }, ctx).ok).toBe(false);
		expect(validateSessionDelete({ id: "a", file: "" }, ctx).ok).toBe(false);
	});

	test("refuses non-attached deletes when the server does not advertise manage", () => {
		const check = validateSessionDelete(
			{ id: "a", file: "/sessions/a.jsonl" },
			{ attachedFile: null, manageAvailable: false },
		);
		expect(check.ok).toBe(false);
	});
});

describe("formatSessionAge", () => {
	test("reports relative age against the explicit clock", () => {
		expect(formatSessionAge(NOW - 10_000, NOW)).toBe("just now");
		expect(formatSessionAge(NOW - 5 * 60_000, NOW)).toBe("5m ago");
		expect(formatSessionAge(NOW - 3 * HOUR, NOW)).toBe("3h ago");
		expect(formatSessionAge(NOW - 2 * 24 * HOUR, NOW)).toBe("2d ago");
		expect(formatSessionAge(0, NOW)).toBe("unknown time");
	});
});

describe("sessionStatus and normalizeSessionTitle", () => {
	test("narrows known statuses only; prototype keys are not statuses", () => {
		expect(sessionStatus("interrupted")).toBe("interrupted");
		expect(sessionStatus("toString")).toBeUndefined();
		expect(sessionStatus(42)).toBeUndefined();
	});

	test("titles are trimmed, single-line and 1..200 chars", () => {
		expect(normalizeSessionTitle("  two\n  lines  ")).toBe("two lines");
		expect(normalizeSessionTitle("   ")).toBeNull();
		expect(normalizeSessionTitle("x".repeat(201))).toBeNull();
		expect(normalizeSessionTitle("x".repeat(200))).toHaveLength(200);
	});
});

describe("resolveSessionOwner", () => {
	const session = (workspaceId: string, cwd: string, status: SessionStatus = "asleep") => ({
		workspaceId,
		cwd,
		status,
	});
	const project = (projectId: string, path: string) => ({ projectId, path });

	test("a single roster session on the cwd owns the session", () => {
		const owner = resolveSessionOwner("/work/b", {
			roster: [session("d-a", "/work/a", "ready"), session("d-b", "/work/b", "ready")],
			projects: [],
		});
		expect(owner).toEqual({ kind: "workspace", workspaceId: "d-b" });
	});

	test("trailing slashes never break a match, but a sibling prefix is not a match", () => {
		const ctx = { roster: [session("d-foo", "/work/foo/")], projects: [] };
		expect(resolveSessionOwner("/work/foo", ctx)).toEqual({
			kind: "workspace",
			workspaceId: "d-foo",
		});
		expect(resolveSessionOwner("/work/foobar", ctx)).toEqual({ kind: "none" });
	});

	test("several sessions on one cwd stay ambiguous: the caller must pick one", () => {
		const roster = [session("d-1", "/work/b"), session("d-2", "/work/b", "ready")];
		expect(resolveSessionOwner("/work/b", { roster, projects: [] })).toEqual({
			kind: "ambiguous",
			workspaceIds: ["d-1", "d-2"],
		});
	});

	test("a registered project with no session owns its checkout and the folders under it", () => {
		const ctx = {
			roster: [session("d-a", "/work/a", "ready")],
			projects: [project("p1", "/work/b"), project("p2", "/work/b/nested")],
		};
		expect(resolveSessionOwner("/work/b", ctx)).toEqual({
			kind: "project",
			projectId: "p1",
			path: "/work/b",
		});
		expect(resolveSessionOwner("/work/b/nested/sub", ctx)).toEqual({
			kind: "project",
			projectId: "p2",
			path: "/work/b/nested",
		});
	});

	test("a session on the folder is preferred over the project that owns it", () => {
		const owner = resolveSessionOwner("/work/b", {
			roster: [session("d-b", "/work/b")],
			projects: [project("p1", "/work/b")],
		});
		expect(owner).toEqual({ kind: "workspace", workspaceId: "d-b" });
	});

	test("a cwd no session or project owns has no owner", () => {
		const owner = resolveSessionOwner("/work/gone", {
			roster: [session("d-a", "/work/a", "ready")],
			projects: [project("p1", "/work/b")],
		});
		expect(owner).toEqual({ kind: "none" });
	});
});
