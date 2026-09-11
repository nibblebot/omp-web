import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CallbackErrorCode } from "../shared/callback-protocol";

// ── /download jail (one implementation, two callers) ───────────────────────

/**
 * Canonicalize jail roots: the realpath of both sides closes symlink escapes
 * a lexical prefix check would miss. Shared verbatim by the HTTP /download
 * route (server/index.ts) and the download_bulk command so both enforce
 * exactly one jail; an unresolvable root falls back to its literal path.
 */
export async function canonicalJailRoots(roots: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (const root of roots) out.push(await realpath(root).catch(() => root));
	return out;
}

/** True when a canonical path lives strictly inside one canonical root. */
function isInsideJail(resolved: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const rel = path.relative(root, resolved);
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
}

/** Resolution outcome of {@link resolveJailedFile}. */
export type JailedFileResolution =
	| { ok: true; canonical: string; size: number }
	| {
			ok: false;
			/** HTTP /download's own classification: 404 "Not found" vs 403 "Forbidden". */
			reason: "missing" | "forbidden";
			/** Typed code for the download_bulk failure control. */
			code: CallbackErrorCode;
			/** Names the path; never carries file contents. */
			message: string;
	  };

/**
 * Resolve one requested download path under the HTTP /download rules:
 * absolute paths are used as-is, relative paths resolve against `cwd` with a
 * fallback to the process cwd (where bare-filename exports land); the
 * canonical target must be a regular file strictly inside `roots`. One
 * implementation for GET /download and the download_bulk command, so a
 * weaker second check can never drift in.
 */
export async function resolveJailedFile(input: {
	requested: string;
	cwd: string;
	roots: readonly string[];
}): Promise<JailedFileResolution> {
	const requested = input.requested;
	let canonical = await realpath(
		path.isAbsolute(requested) ? requested : path.resolve(input.cwd, requested),
	).catch(() => null);
	if (canonical === null && !path.isAbsolute(requested)) {
		canonical = await realpath(path.resolve(process.cwd(), requested)).catch(() => null);
	}
	if (canonical === null) {
		return {
			ok: false,
			reason: "missing",
			code: "invalid_request",
			message: `download path does not exist: ${requested}`,
		};
	}
	const fileStat = await stat(canonical).catch(() => null);
	if (fileStat === null || !fileStat.isFile()) {
		return {
			ok: false,
			reason: "missing",
			code: "invalid_request",
			message: `download path is not a regular file: ${canonical}`,
		};
	}
	if (!isInsideJail(canonical, input.roots)) {
		return {
			ok: false,
			reason: "forbidden",
			code: "forbidden",
			message: `download path is outside the permitted roots: ${canonical}`,
		};
	}
	return { ok: true, canonical, size: fileStat.size };
}
