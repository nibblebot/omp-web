/**
 * Regression tests for the queue bar's live notice (hs2p): a steer the running
 * turn delivers is reported as delivered, never as "Queue cleared"; a Stop that
 * pauses the queue is announced; only clear all says "Queue cleared".
 */

import { describe, expect, test } from "bun:test";
import { queueTransitionNotice } from "../components/chat/composer/queue-notice";

const idle = { chips: 0, paused: 0 };

describe("queue bar live notice (hs2p)", () => {
	test("a steer the running turn delivers is announced as delivered, not cleared", () => {
		const notice = queueTransitionNotice({ chips: 1, paused: 0 }, idle);
		expect(notice).toBe("1 message delivered");
		expect(notice).not.toContain("cleared");
	});

	test("clear all is the only action that announces Queue cleared", () => {
		expect(queueTransitionNotice({ chips: 2, paused: 0 }, idle, "cleared")).toBe("Queue cleared");
	});

	test("removing the last chip by hand stays silent", () => {
		expect(queueTransitionNotice({ chips: 1, paused: 0 }, idle, "removed")).toBe("");
	});

	test("Stop pauses live chips and the notice says so", () => {
		expect(queueTransitionNotice({ chips: 2, paused: 0 }, { chips: 2, paused: 2 })).toBe(
			"2 messages paused. Resume queue to send",
		);
	});

	test("Resume queue drains paused chips as delivered", () => {
		expect(queueTransitionNotice({ chips: 2, paused: 2 }, idle)).toBe("2 messages delivered");
	});

	test("a first queued message is announced; no change keeps the last notice", () => {
		expect(queueTransitionNotice(idle, { chips: 1, paused: 0 })).toBe("1 message queued");
		expect(queueTransitionNotice({ chips: 1, paused: 0 }, { chips: 1, paused: 0 })).toBeUndefined();
		expect(queueTransitionNotice(idle, idle)).toBeUndefined();
	});
});
