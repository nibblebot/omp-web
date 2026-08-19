import { describe, expect, test } from "bun:test";
import type { DaemonStatus } from "../../shared/protocol";
import { sessionActivity, type SessionActivity } from "./session-activity";

/** Attached session, idle stream. */
const ATTACHED_IDLE = {
	attached: true,
	streaming: false,
	uiPending: false,
	unreviewed: false,
	unread: false,
};
/** Attached session whose turn ended with the answer below the viewport. */
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
	unreviewed: false,
	unread: false,
};
const ATTACHED_BLOCKED = {
	attached: true,
	streaming: true,
	uiPending: true,
	unreviewed: false,
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
			expect(sessionActivity({ status }, ATTACHED_BLOCKED)).toBeNull();
		});
	}
});

describe("sessionActivity precedence on ready rows", () => {
	test("blocked beats streaming", () => {
		expect(sessionActivity({ status: "ready" }, ATTACHED_BLOCKED)).toBe("blocked");
	});

	test("attached streaming → in_progress", () => {
		expect(sessionActivity({ status: "ready" }, ATTACHED_STREAMING)).toBe("in_progress");
	});

	test("attached idle → idle (an attached session being viewed is never unreviewed)", () => {
		expect(sessionActivity({ status: "ready" }, ATTACHED_IDLE)).toBe("idle");
	});

	test("attached idle + answer below the viewport → unreviewed", () => {
		expect(sessionActivity({ status: "ready" }, ATTACHED_UNREVIEWED)).toBe("unreviewed");
	});

	test("blocked and streaming beat unreviewed", () => {
		expect(sessionActivity({ status: "ready" }, { ...ATTACHED_BLOCKED, unreviewed: true })).toBe(
			"blocked",
		);
		expect(sessionActivity({ status: "ready" }, { ...ATTACHED_STREAMING, unreviewed: true })).toBe(
			"in_progress",
		);
	});
});

describe("sessionActivity detached rows (no remote signal — old edge or down stream)", () => {
	test("uiPending without attached → not blocked (client signals describe only the attached session)", () => {
		expect(sessionActivity({ status: "ready" }, { ...DETACHED, uiPending: true })).toBe("idle");
	});

	test("streaming without attached → not in_progress", () => {
		expect(sessionActivity({ status: "ready" }, { ...DETACHED, streaming: true })).toBe("idle");
	});

	test("detached ignores unreviewed (no live chat for detached rows) → idle", () => {
		expect(sessionActivity({ status: "ready" }, { ...DETACHED, unreviewed: true })).toBe("idle");
	});

	test("detached with no signals → idle", () => {
		expect(sessionActivity({ status: "ready" }, DETACHED)).toBe("idle");
	});
});

describe("sessionActivity unread", () => {
	test("detached ready + unread → unread", () => {
		expect(sessionActivity({ status: "ready" }, { ...DETACHED, unread: true })).toBe("unread");
	});

	test("attached row with unread:true → not unread (the flag is cleared on attach)", () => {
		expect(sessionActivity({ status: "ready" }, { ...ATTACHED_IDLE, unread: true })).toBe("idle");
	});

	test("unread on a non-ready status → null", () => {
		expect(sessionActivity({ status: "asleep" }, { ...DETACHED, unread: true })).toBeNull();
	});

	test("unread does not beat blocked/in_progress on an attached row", () => {
		expect(sessionActivity({ status: "ready" }, { ...ATTACHED_STREAMING, unread: true })).toBe(
			"in_progress",
		);
		expect(sessionActivity({ status: "ready" }, { ...ATTACHED_BLOCKED, unread: true })).toBe(
			"blocked",
		);
	});
});

describe("sessionActivity remote realtime activity (daemon_activity frames)", () => {
	const REMOTE_STREAMING = { streaming: true, blocked: false };
	const REMOTE_BLOCKED = { streaming: true, blocked: true };
	const REMOTE_IDLE = { streaming: false, blocked: false };

	test("detached + remote streaming → in_progress", () => {
		expect(sessionActivity({ status: "ready" }, { ...DETACHED, remote: REMOTE_STREAMING })).toBe(
			"in_progress",
		);
	});

	test("detached + remote streaming beats unread (live truth > the unread latch)", () => {
		expect(
			sessionActivity({ status: "ready" }, { ...DETACHED, unread: true, remote: REMOTE_STREAMING }),
		).toBe("in_progress");
	});

	test("detached + remote blocked → blocked", () => {
		expect(sessionActivity({ status: "ready" }, { ...DETACHED, remote: REMOTE_BLOCKED })).toBe(
			"blocked",
		);
	});

	test("detached + remote idle → idle", () => {
		expect(sessionActivity({ status: "ready" }, { ...DETACHED, remote: REMOTE_IDLE })).toBe("idle");
	});

	test("attached row ignores remote (its own live signals win)", () => {
		// Even with a remote "blocked", the attached row's read of its own
		// stream governs — remote is never consulted on attach.
		expect(sessionActivity({ status: "ready" }, { ...ATTACHED_IDLE, remote: REMOTE_BLOCKED })).toBe(
			"idle",
		);
		expect(
			sessionActivity({ status: "ready" }, { ...ATTACHED_STREAMING, remote: REMOTE_IDLE }),
		).toBe("in_progress");
	});
});

describe("sessionActivity result set", () => {
	test("every branch returns a valid SessionActivity value", () => {
		const results: Array<SessionActivity | null> = [
			sessionActivity({ status: "error" }, ATTACHED_BLOCKED),
			sessionActivity({ status: "ready" }, DETACHED),
			sessionActivity({ status: "ready" }, ATTACHED_IDLE),
			sessionActivity({ status: "ready" }, ATTACHED_UNREVIEWED),
			sessionActivity({ status: "ready" }, { ...DETACHED, unread: true }),
			sessionActivity({ status: "ready" }, ATTACHED_STREAMING),
			sessionActivity({ status: "ready" }, ATTACHED_BLOCKED),
		];
		expect(results).toEqual([
			null,
			"idle",
			"idle",
			"unreviewed",
			"unread",
			"in_progress",
			"blocked",
		]);
	});
});
