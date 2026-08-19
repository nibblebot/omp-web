import { describe, expect, test } from "bun:test";
import type { DaemonStatus } from "../../shared/protocol";
import { sessionActivity, type SessionActivity } from "./session-activity";

const cleanGit = { added: 0, modified: 0, deleted: 0, untracked: 0 };
const dirtyGit = { added: 1, modified: 0, deleted: 0, untracked: 0 };

/** Attached session, idle stream, last answer unreviewed / not. */
const ATTACHED_IDLE = {
	attached: true,
	streaming: false,
	uiPending: false,
	unreviewed: false,
	unread: false,
};
const ATTACHED_UNREVIEWED = {
	attached: true,
	streaming: false,
	uiPending: false,
	unreviewed: true,
	unread: false,
};
const ATTACHED_STREAMING = {
	attached: true,
	streaming: true,
	uiPending: false,
	unreviewed: true,
	unread: false,
};
const ATTACHED_BLOCKED = {
	attached: true,
	streaming: true,
	uiPending: true,
	unreviewed: true,
	unread: false,
};
const DETACHED = {
	attached: false,
	streaming: false,
	uiPending: false,
	unreviewed: false,
	unread: false,
};

/**
 * Every non-ready status keeps the status-dot ladder: no dot at all, even
 * with every live signal lit (the live signals only ever describe the one
 * attached session, which is ready by definition when it is streaming).
 */
describe("sessionActivity non-ready statuses → null", () => {
	const statuses: DaemonStatus[] = [
		"spawning",
		"connecting",
		"session",
		"resolving",
		"asleep",
		"reconnecting",
		"error",
	];
	for (const status of statuses) {
		test(`${status} → null`, () => {
			expect(
				sessionActivity(
					{ status, git: { added: 4, modified: 0, deleted: 0, untracked: 0 } },
					ATTACHED_BLOCKED,
				),
			).toBeNull();
		});
	}
});

describe("sessionActivity precedence on ready rows", () => {
	test("blocked beats streaming beats unreviewed", () => {
		expect(sessionActivity({ status: "ready", git: dirtyGit }, ATTACHED_BLOCKED)).toBe("blocked");
	});

	test("streaming beats unreviewed and dirty", () => {
		expect(sessionActivity({ status: "ready", git: dirtyGit }, ATTACHED_STREAMING)).toBe(
			"in_progress",
		);
	});

	test("attached idle + unreviewed answer → unreviewed, even on a clean tree", () => {
		expect(sessionActivity({ status: "ready", git: cleanGit }, ATTACHED_UNREVIEWED)).toBe(
			"unreviewed",
		);
	});

	test("attached idle + reviewed answer (user sent the next prompt) → idle despite dirty tree", () => {
		// The user is engaged with the dirty tree — the attached live chat is
		// the truth, git dirtiness is only the detached-row proxy.
		expect(sessionActivity({ status: "ready", git: dirtyGit }, ATTACHED_IDLE)).toBe("idle");
	});

	test("clean tree with an idle attached stream → idle", () => {
		expect(sessionActivity({ status: "ready", git: cleanGit }, ATTACHED_IDLE)).toBe("idle");
	});
});

describe("sessionActivity detached rows (no remote signal — old edge or down stream)", () => {
	test("uiPending without attached → not blocked", () => {
		expect(
			sessionActivity(
				{ status: "ready", git: dirtyGit },
				{ attached: false, streaming: false, uiPending: true, unreviewed: true, unread: false },
			),
		).toBe("unreviewed");
	});

	test("streaming without attached → not in_progress", () => {
		expect(
			sessionActivity(
				{ status: "ready", git: cleanGit },
				{ attached: false, streaming: true, uiPending: false, unreviewed: true, unread: false },
			),
		).toBe("idle");
	});

	test("absent git object never yields unreviewed (detached clean → idle)", () => {
		expect(sessionActivity({ status: "ready" }, DETACHED)).toBe("idle");
	});

	test("absent git object with an attached idle stream → idle, not unreviewed", () => {
		expect(sessionActivity({ status: "ready" }, ATTACHED_IDLE)).toBe("idle");
		expect(sessionActivity({ status: "ready" }, ATTACHED_STREAMING)).toBe("in_progress");
		expect(sessionActivity({ status: "ready" }, ATTACHED_BLOCKED)).toBe("blocked");
	});

	test("all-zero git object → idle, not unreviewed", () => {
		expect(sessionActivity({ status: "ready", git: cleanGit }, DETACHED)).toBe("idle");
	});
});

describe("sessionActivity unread", () => {
	test("detached ready + unread → unread, even on a dirty tree", () => {
		expect(
			sessionActivity(
				{ status: "ready", git: dirtyGit },
				{ attached: false, streaming: false, uiPending: false, unreviewed: false, unread: true },
			),
		).toBe("unread");
	});

	test("detached ready + unread on a clean tree → unread", () => {
		expect(
			sessionActivity(
				{ status: "ready", git: cleanGit },
				{ attached: false, streaming: false, uiPending: false, unreviewed: false, unread: true },
			),
		).toBe("unread");
	});

	test("attached row with unread:true → not unread (falls through to existing rules)", () => {
		// clean-git attached idle → idle, the unread flag is ignored on attach
		expect(
			sessionActivity(
				{ status: "ready", git: cleanGit },
				{ attached: true, streaming: false, uiPending: false, unreviewed: false, unread: true },
			),
		).toBe("idle");
		// attached unreviewed → unreviewed, not unread
		expect(
			sessionActivity(
				{ status: "ready", git: cleanGit },
				{ attached: true, streaming: false, uiPending: false, unreviewed: true, unread: true },
			),
		).toBe("unreviewed");
	});

	test("unread on a non-ready status → null", () => {
		expect(
			sessionActivity(
				{ status: "asleep", git: dirtyGit },
				{ attached: false, streaming: false, uiPending: false, unreviewed: false, unread: true },
			),
		).toBeNull();
	});

	test("unread does not beat blocked/in_progress on an attached row", () => {
		expect(
			sessionActivity(
				{ status: "ready", git: dirtyGit },
				{ attached: true, streaming: true, uiPending: false, unreviewed: true, unread: true },
			),
		).toBe("in_progress");
		expect(
			sessionActivity(
				{ status: "ready", git: dirtyGit },
				{ attached: true, streaming: true, uiPending: true, unreviewed: true, unread: true },
			),
		).toBe("blocked");
	});
});

describe("sessionActivity remote realtime activity (daemon_activity frames)", () => {
	const REMOTE_STREAMING = { streaming: true, blocked: false };
	const REMOTE_BLOCKED = { streaming: true, blocked: true };
	const REMOTE_IDLE = { streaming: false, blocked: false };

	test("detached + remote streaming → in_progress, even on a clean tree", () => {
		expect(
			sessionActivity(
				{ status: "ready", git: cleanGit },
				{ ...DETACHED, remote: REMOTE_STREAMING },
			),
		).toBe("in_progress");
	});

	test("detached + remote streaming beats unread (live truth > the unread latch)", () => {
		expect(
			sessionActivity(
				{ status: "ready", git: dirtyGit },
				{ ...DETACHED, unread: true, remote: REMOTE_STREAMING },
			),
		).toBe("in_progress");
	});

	test("detached + remote blocked → blocked", () => {
		expect(
			sessionActivity({ status: "ready", git: cleanGit }, { ...DETACHED, remote: REMOTE_BLOCKED }),
		).toBe("blocked");
	});

	test("detached + remote idle + dirty git → unreviewed (git fallback still applies)", () => {
		expect(
			sessionActivity({ status: "ready", git: dirtyGit }, { ...DETACHED, remote: REMOTE_IDLE }),
		).toBe("unreviewed");
	});

	test("detached + remote idle + clean git → idle", () => {
		expect(
			sessionActivity({ status: "ready", git: cleanGit }, { ...DETACHED, remote: REMOTE_IDLE }),
		).toBe("idle");
	});

	test("attached row ignores remote (its own live signals win)", () => {
		// Even with a remote "blocked", the attached row's read of its own
		// stream governs — remote is never consulted on attach.
		expect(
			sessionActivity(
				{ status: "ready", git: cleanGit },
				{ ...ATTACHED_IDLE, remote: REMOTE_BLOCKED },
			),
		).toBe("idle");
		expect(
			sessionActivity(
				{ status: "ready", git: cleanGit },
				{ ...ATTACHED_STREAMING, remote: REMOTE_IDLE },
			),
		).toBe("in_progress");
	});
});

describe("sessionActivity result set", () => {
	test("every branch returns a valid SessionActivity value", () => {
		const results: Array<SessionActivity | null> = [
			sessionActivity({ status: "error", git: cleanGit }, ATTACHED_BLOCKED),
			sessionActivity({ status: "ready", git: cleanGit }, DETACHED),
			sessionActivity({ status: "ready", git: dirtyGit }, DETACHED),
			sessionActivity(
				{ status: "ready", git: { added: 0, modified: 1, deleted: 0, untracked: 0 } },
				DETACHED,
			),
			sessionActivity({ status: "ready", git: cleanGit }, ATTACHED_UNREVIEWED),
			sessionActivity({ status: "ready", git: cleanGit }, ATTACHED_STREAMING),
			sessionActivity({ status: "ready", git: cleanGit }, ATTACHED_BLOCKED),
		];
		expect(results).toEqual([
			null,
			"idle",
			"unreviewed",
			"unreviewed",
			"unreviewed",
			"in_progress",
			"blocked",
		]);
	});
});
