/**
 * resume-bootstrap containment tests. The safety contract is that only a
 * transcript proven inside the real sessions root is ever treated as managed:
 * a `..` traversal or a symlinked ancestor must yield no target, so no caller
 * can remove an outside lock or restore an outside file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { clearStaleResumeLock, resolveManagedResumeTarget, withDeadline } from "./resume-bootstrap";
import { MaterializeSessionError } from "./session-materialize";

afterAll(cleanupTempDirs);

/** A concrete sessions root plus a sibling directory OUTSIDE it. */
function fixture(): { root: string; outside: string } {
	const base = tempDir("omp-resume-bootstrap-");
	const root = path.join(base, "sessions");
	const outside = path.join(base, "outside");
	mkdirSync(root, { recursive: true });
	mkdirSync(outside, { recursive: true });
	return { root, outside };
}

describe("resolveManagedResumeTarget", () => {
	test("accepts a plain main transcript inside the sessions root", () => {
		const { root } = fixture();
		expect(resolveManagedResumeTarget(root, path.join(root, "sess-1.jsonl"))).toEqual({
			sessionId: "sess-1",
			mainFile: path.join(root, "sess-1.jsonl"),
			lockFile: path.join(root, "sess-1.jsonl.lock"),
		});
	});

	test("accepts a project-nested main transcript inside the sessions root", () => {
		const { root } = fixture();
		const projectDir = path.join(root, "proj");
		mkdirSync(projectDir);
		expect(resolveManagedResumeTarget(root, path.join(projectDir, "sess-2.jsonl"))).toEqual({
			sessionId: "sess-2",
			mainFile: path.join(projectDir, "sess-2.jsonl"),
			lockFile: path.join(projectDir, "sess-2.jsonl.lock"),
		});
	});

	test("rejects a `..` traversal out of the sessions root", () => {
		const { root, outside } = fixture();
		// Raw string: the `..` must survive into the resolver (not pre-normalized).
		const traversing = `${root}/../outside/sess-3.jsonl`;
		expect(resolveManagedResumeTarget(root, traversing)).toBeNull();
		expect(path.resolve(traversing)).toBe(path.join(outside, "sess-3.jsonl"));
	});

	test("rejects a symlinked parent that escapes the sessions root", () => {
		const { root, outside } = fixture();
		symlinkSync(outside, path.join(root, "linked"));
		expect(resolveManagedResumeTarget(root, path.join(root, "linked", "sess-4.jsonl"))).toBeNull();
	});

	test("rejects a relative resume path and a non-transcript target", () => {
		const { root } = fixture();
		expect(resolveManagedResumeTarget(root, "sess-5.jsonl")).toBeNull();
		expect(resolveManagedResumeTarget(root, path.join(root, "sess-5.txt"))).toBeNull();
	});
});

describe("clearStaleResumeLock", () => {
	test("removes only the managed target's lock, never an outside lock", () => {
		const { root, outside } = fixture();
		const outsideMain = path.join(outside, "sess-6.jsonl");
		writeFileSync(`${outsideMain}.lock`, "{}");
		const insideMain = path.join(root, "sess-6.jsonl");
		writeFileSync(`${insideMain}.lock`, "{}");

		// A traversal target has no managed handle, so the outside lock survives.
		expect(resolveManagedResumeTarget(root, `${root}/../outside/sess-6.jsonl`)).toBeNull();
		expect(existsSync(`${outsideMain}.lock`)).toBe(true);

		const target = resolveManagedResumeTarget(root, insideMain);
		if (target === null) throw new Error("expected a managed target");
		clearStaleResumeLock(target);
		expect(existsSync(`${insideMain}.lock`)).toBe(false);
		expect(existsSync(`${outsideMain}.lock`)).toBe(true);
	});
});

describe("withDeadline", () => {
	test("rejects a stalled step with a typed unavailable error", async () => {
		await expect(
			withDeadline(new Promise<never>(() => {}), 10, "restore stalled"),
		).rejects.toBeInstanceOf(MaterializeSessionError);
	});
});
