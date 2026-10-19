import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as transport from "../../store/transport";
import {
	cancelDangerConfirm,
	confirmDangerConfirm,
	dangerConfirm,
} from "../../prompt/danger-confirm";

// The transport is mocked per test; the store module is imported after the mock so it binds to it.
let handler: (method: string, args: unknown) => Promise<unknown> = async () => undefined;
const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: (method: string, args: unknown) => handler(method, args),
}));

afterAll(() => {
	// mock.restore() leaves module mocks installed; reinstall the real exports for later files.
	mock.module("../../store/transport", () => originalTransport);
});

// Dynamic imports: the transport mock must be registered before the store module binds to it.
const review = await import("../../store/review");
const { setState } = await import("../../state");
// Dynamic: the testkit loads the state module graph, so it must follow the transport mock.
const { restoreBrowserGlobals, setBrowserGlobal } = await import("../web.testkit");

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
	setState("capabilities", { git: { available: true } } as never);
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

describe("review confirm requests", () => {
	const calls: Array<{ method: string; args: unknown }> = [];
	// The store's mutation chain runs entirely on microtasks; no timers needed.
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	const deferred = () => {
		let resolve!: () => void;
		const promise = new Promise<void>((done) => (resolve = done));
		return { promise, resolve };
	};
	const recorder =
		(onMutation: () => void = () => {}) =>
		async (method: string, args: unknown) => {
			calls.push({ method, args });
			if (method === "gitStage" || method === "gitCommit") onMutation();
			return method === "gitStatus" ? snapshot : undefined;
		};
	const stagedSnapshot = {
		...snapshot,
		unstaged: [],
		staged: [{ path: "c.ts", kind: "modified" }],
	} as never;

	beforeEach(() => {
		calls.length = 0;
		// window.confirm must never run: the danger dialog is the only guard.
		setBrowserGlobal("window", {
			confirm: () => {
				throw new Error("window.confirm must not be used");
			},
		} as unknown as Window & typeof globalThis);
		handler = recorder();
	});

	afterEach(() => {
		cancelDangerConfirm();
		restoreBrowserGlobals();
	});

	test("Stage all opens the dialog and stages only on confirm", async () => {
		const staged = deferred();
		handler = recorder(staged.resolve);
		review.requestStageAll();
		expect(dangerConfirm()).toMatchObject({
			title: "Stage all changes?",
			confirmLabel: "Stage 1 file",
		});
		expect(calls).toEqual([]);

		confirmDangerConfirm();
		await staged.promise;
		expect(calls[0]).toMatchObject({ method: "gitStage", args: [{ paths: [], all: true }] });
		expect(dangerConfirm()).toBeNull();
	});

	test("cancelling Stage all stages nothing", async () => {
		review.requestStageAll();
		cancelDangerConfirm();
		await settle();
		expect(dangerConfirm()).toBeNull();
		expect(calls).toEqual([]);
	});

	test("Commit shows the staged count and subject, and commits only on confirm", async () => {
		setState("review", "gitStatus", stagedSnapshot);
		const committed = deferred();
		const onCommitted = mock(committed.resolve);
		review.requestCommit("feat: add x\n\nlong body", onCommitted);
		expect(dangerConfirm()).toMatchObject({
			title: "Commit staged changes?",
			confirmLabel: "Commit",
		});
		expect(dangerConfirm()?.body).toContain("1 file staged");
		expect(dangerConfirm()?.body).toContain("feat: add x");
		expect(dangerConfirm()?.body).not.toContain("long body");
		expect(calls).toEqual([]);

		confirmDangerConfirm();
		await committed.promise;
		expect(calls[0]).toMatchObject({
			method: "gitCommit",
			args: [{ message: "feat: add x\n\nlong body" }],
		});
		expect(onCommitted).toHaveBeenCalledTimes(1);
	});

	test("cancelling Commit commits nothing and keeps the message", async () => {
		setState("review", "gitStatus", stagedSnapshot);
		const onCommitted = mock(() => {});
		review.requestCommit("feat: add x", onCommitted);
		cancelDangerConfirm();
		await settle();
		expect(calls).toEqual([]);
		expect(onCommitted).not.toHaveBeenCalled();
	});

	test("a refused commit does not clear the message", async () => {
		setState("review", "gitStatus", stagedSnapshot);
		const attempted = deferred();
		handler = async (method, args) => {
			calls.push({ method, args });
			if (method !== "gitCommit") return snapshot;
			attempted.resolve();
			throw new Error("hook rejected");
		};
		const onCommitted = mock(() => {});
		review.requestCommit("feat: add x", onCommitted);
		confirmDangerConfirm();
		await attempted.promise;
		await settle();
		expect(onCommitted).not.toHaveBeenCalled();
	});
});
