import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as transport from "../../store/transport";

// The transport is mocked per test; the store module is imported after the mock so it binds to it.
let handler: (method: string) => Promise<unknown> = async () => undefined;
mock.module("../../store/transport", () => ({
	...transport,
	call: (method: string) => handler(method),
}));

// Dynamic imports: the transport mock must be registered before the store module binds to it.
const review = await import("../../store/review");
const { setState } = await import("../../state");

const snapshot = {
	available: true,
	cwd: "/repo",
	indexFingerprint: "fp-1",
	worktreeFingerprint: "wt-1",
	eligible: { stage: true, commit: true },
	unstaged: [{ path: "a.ts", kind: "modified" }],
	staged: [],
	head: null,
};

beforeEach(() => {
	review.setReviewCaps({ git: { available: true } } as never);
	setState("review", "gitStatus", snapshot as never);
	setState("review", "gitError", null);
});

describe("git mutations (REV-14)", () => {
	test("a landed change with a failed status refresh is reported as applied", async () => {
		handler = async (method) => {
			if (method === "gitStatus") throw new Error("socket closed");
			return undefined;
		};
		expect(await review.stagePaths(["a.ts"])).toBe(true);
		expect(review.gitError()).toBe(
			"Change applied; status refresh failed: socket closed. Refresh to update.",
		);
	});

	test("a refused change keeps its own error and is not reported as applied", async () => {
		handler = async (method) => {
			if (method === "gitStage") throw new Error("fingerprint mismatch");
			return snapshot;
		};
		expect(await review.stagePaths(["a.ts"])).toBeUndefined();
		expect(review.gitError()).toBe("fingerprint mismatch");
		expect(review.isStaleError(new Error("fingerprint mismatch"))).toBe(true);
	});

	test("a successful change with a fresh status clears the error", async () => {
		handler = async (method) => (method === "gitStatus" ? snapshot : undefined);
		expect(await review.stagePaths(["a.ts"])).toBe(true);
		expect(review.gitError()).toBeNull();
	});
});
