import { describe, expect, test } from "bun:test";
import {
	type SessionRow,
	formatSessionAge,
	groupSessions,
	matchSessionRow,
	normalizeSessionTitle,
	sessionDisplayTitle,
	sessionStatus,
	sessionSubtitle,
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

describe("sessionDisplayTitle and sessionSubtitle", () => {
	test("uses the explicit title and shows the first prompt as subtitle", () => {
		const r = row({ id: "s1", title: "Refactor auth", firstMessage: "fix the login bug" });
		expect(sessionDisplayTitle(r)).toBe("Refactor auth");
		expect(sessionSubtitle(r)).toBe("fix the login bug");
	});

	test("untitled rows fall back to the first prompt line, never the raw id", () => {
		const r = row({ id: "0123abcd-deadbeef", firstMessage: "  add dark mode\nsecond line" });
		expect(sessionDisplayTitle(r)).toBe("add dark mode");
		expect(sessionDisplayTitle(r)).not.toContain("0123abcd");
		expect(sessionSubtitle(r)).toBeUndefined();
	});

	test("an id-valued title is ignored and '(no messages)' is not a prompt", () => {
		const r = row({ id: "abc", title: "abc", firstMessage: "(no messages)" });
		const title = sessionDisplayTitle(r);
		expect(title.startsWith("Untitled")).toBe(true);
		expect(title).not.toContain("abc");
	});

	test("subtitle is omitted when it would repeat the title", () => {
		const r = row({ id: "s2", title: "same", firstMessage: "same" });
		expect(sessionSubtitle(r)).toBeUndefined();
	});

	test("long prompts are truncated with an ellipsis", () => {
		const long = "x".repeat(300);
		const r = row({ id: "s3", firstMessage: long });
		expect(sessionDisplayTitle(r).length).toBe(80);
		expect(sessionDisplayTitle(r).endsWith("…")).toBe(true);
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
