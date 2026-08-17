/**
 * Shared test utilities. Import ONLY from *.test.ts files: cleanup state lives
 * here, but the afterAll hook MUST be registered in the importing test file
 * (top level, `afterAll(cleanupTempDirs)`): bun 1.3.14 only reliably runs
 * afterAll hooks registered in the test file's own module — hooks registered
 * in an imported module are attributed to whichever file imported it first and
 * are skipped for the rest of a multi-file run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tracked: string[] = [];

/**
 * Fresh mkdtemp dir under os.tmpdir(), tracked for removal by
 * `cleanupTempDirs`. Use instead of raw mkdtempSync in tests so repeated
 * suite runs never leak dirs.
 */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tracked.push(dir);
	return dir;
}

/**
 * Remove every dir created by tempDir (recursive, force, best-effort).
 * Register ONCE at the top level of each importing test file:
 *
 *   import { afterAll } from "bun:test";
 *   import { cleanupTempDirs, tempDir } from "./testkit";
 *   afterAll(cleanupTempDirs);
 */
export function cleanupTempDirs(): void {
	for (const dir of tracked.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort: a leaked dir in tmpdir beats a red suite.
		}
	}
}
