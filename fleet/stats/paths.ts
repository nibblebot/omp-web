/**
 * Path safety + normalization for session files.
 *
 * The public `:file` identifier is a RELATIVE path from sessionsDir
 * (OS separators). Internally we normalize everything to absolute paths
 * because real stats.db rows store absolute session_file values.
 */
import { join, resolve, relative, sep, isAbsolute, normalize } from "node:path";

/** Reject anything that escapes sessionsDir; return absolute path or null. */
export function toAbs(sessionsDir: string, rel: string): string | null {
	const r = normalize(rel);
	if (r.startsWith("..") || isAbsolute(r) || r === "." || r === "") return null;
	const abs = resolve(sessionsDir, r);
	const root = resolve(sessionsDir) + sep;
	if (abs !== resolve(sessionsDir) && !abs.startsWith(root)) return null;
	return abs;
}

/**
 * Decode a URL-encoded `:file` route param and sanitize it.
 * Returns the sanitized relative path (with `/` separators) or null.
 */
export function decodeFileParam(sessionsDir: string, raw: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (decoded.includes("\\")) decoded = decoded.replaceAll("\\", "/");
	const abs = toAbs(sessionsDir, decoded);
	if (!abs) return null;
	return relative(sessionsDir, abs);
}

/**
 * Normalize any session_file value found in the DB to an absolute path.
 * Real DBs store absolute paths; the schema comment says relative — accept both.
 */
export function normDbFile(sessionsDir: string, f: string): string {
	if (isAbsolute(f)) return normalize(f);
	return resolve(sessionsDir, f);
}

/** Absolute -> relative (OS separators, no leading ./). */
export function toRel(sessionsDir: string, abs: string): string {
	const r = relative(sessionsDir, abs);
	return r === "" ? "" : r;
}

/** Human folder label: first path segment of the rel path. */
export function folderOf(rel: string): string {
	const i = rel.indexOf(sep);
	return i === -1 ? rel : rel.slice(0, i);
}

/** True when the rel path is a main-agent session: <proj>/<file>.jsonl (2 segments). */
export function isMainSession(rel: string): boolean {
	// Windows paths arrive with backslashes; normalize to `/` so the split is
	// OS-independent — `proj\file.jsonl` and `proj/file.jsonl` behave the same
	// everywhere.
	const parts = rel.replaceAll("\\", "/").split("/");
	return parts.length === 2 && parts[1]!.endsWith(".jsonl") && !parts[1]!.startsWith("__advisor");
}
