import { encodePathSegments } from "../fleet-api";

/** Analysis hash for a session transcript; `sub` (a subagent file, relative to the sessions dir) opens that subagent inside it. */
export function sessionHash(file: string, sub: string | null): string {
	const base = `#/s/${encodePathSegments(file)}`;
	return sub === null ? base : `${base}?sub=${encodeURIComponent(sub)}`;
}

/**
 * `absolute` relative to `sessionsDir` (`/`-separated), or null when it lies
 * outside that directory. Analysis addresses files by this relative path.
 */
export function sessionRelFile(sessionsDir: string, absolute: string): string | null {
	if (sessionsDir === "") return null;
	const root = sessionsDir.endsWith("/") ? sessionsDir : `${sessionsDir}/`;
	if (!absolute.startsWith(root)) return null;
	const rel = absolute.slice(root.length);
	if (rel === "" || rel.split("/").some((segment) => segment === "" || segment === ".."))
		return null;
	return rel;
}

/**
 * Analysis hash opening one subagent transcript, or null when no link can be
 * made (Analysis off, sessions dir not loaded, or the parent or subagent file
 * unknown or outside the sessions dir). Callers hide the action on null; it is
 * never shown disabled.
 */
export function subagentAnalysisHash(input: {
	analysisEnabled: boolean;
	sessionsDir: string | null;
	parentFile: string | undefined;
	subagentFile: string | null | undefined;
}): string | null {
	if (!input.analysisEnabled || input.sessionsDir === null) return null;
	if (!input.parentFile || !input.subagentFile) return null;
	const parent = sessionRelFile(input.sessionsDir, input.parentFile);
	const sub = sessionRelFile(input.sessionsDir, input.subagentFile);
	if (parent === null || sub === null) return null;
	return sessionHash(parent, sub);
}
