/**
 * Symlink-escape containment for :file route handlers.
 *
 * Lexical sanitization (src/paths.ts decodeFileParam/toAbs) rejects `..`
 * traversal, but a symlink — the final component or any intermediate
 * directory — can still point outside sessionsDir. Every handler that
 * opens a session file by route param must verify that the RESOLVED
 * realpath of the file stays inside the realpath of sessionsDir.
 */
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";

/** Cached realpath of sessionsDir — constant for the life of the process. */
const rootCache = new Map<string, string | null>();

export function sessionsRootReal(sessionsDir: string): string | null {
	if (rootCache.has(sessionsDir)) return rootCache.get(sessionsDir)!;
	let real: string;
	try {
		real = realpathSync.native(sessionsDir);
	} catch {
		rootCache.set(sessionsDir, null);
		return null;
	}
	rootCache.set(sessionsDir, real);
	return real;
}

/** True when `real` is `root` itself or strictly beneath it. */
export function isInsideRoot(root: string, real: string): boolean {
	return real === root || real.startsWith(root + sep);
}

/**
 * Resolve a sanitized rel path (output of decodeFileParam) to a contained
 * absolute path. Returns the lexical abs path, or null when the path is
 * missing OR its realpath escapes sessionsDir (symlinked file, symlinked
 * intermediate directory). Callers decide how to map null to a response.
 */
export function resolveContained(sessionsDir: string, rel: string): string | null {
	const root = sessionsRootReal(sessionsDir);
	if (root === null) return null;
	const abs = join(sessionsDir, rel);
	let real: string;
	try {
		real = realpathSync.native(abs);
	} catch {
		return null;
	}
	return isInsideRoot(root, real) ? abs : null;
}
