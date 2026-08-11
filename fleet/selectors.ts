/**
 * Daemon selector resolution for the fleet control plane.
 *
 * A selector names a set of registry entries:
 * - `all` — every entry.
 * - A bare daemonId (`d3`) — exact match; wins over glob interpretation.
 * - `label:k=v` (alias `tag:k=v`) — entries whose `labels` array contains
 *   exactly `k=v`.
 * - `project:name` — entries whose `project` equals `name` exactly.
 * - Anything else — a name glob: `*` matches any run (including empty),
 *   `?` matches exactly one character, and every other character is literal.
 *   The glob is anchored at both ends.
 *
 * A selector that matches nothing returns an empty array; the caller decides
 * whether that is an error.
 */

import type { RegistryEntry } from "./registry";

const LABEL_SELECTOR = /^(label|tag):(.+)$/;
const PROJECT_SELECTOR = /^project:(.+)$/;

/** Regex specials that must be escaped when a glob literal becomes a pattern. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Translate a `*`/`?` name glob into an anchored RegExp. Literal characters
 * are escaped so names containing regex specials (`.`, `+`, `$`, …) match
 * verbatim. Anchored at both ends, so `foo?` matches `foo1` but not `xfoo1`
 * or `foo`.
 */
function compileGlob(pattern: string): RegExp {
	let source = "^";
	for (const ch of pattern) {
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else source += ch.replace(REGEX_SPECIAL, "\\$&");
	}
	return new RegExp(source + "$");
}

export function matchSelector(entries: RegistryEntry[], selector: string): RegistryEntry[] {
	if (selector === "all") return [...entries];

	// Exact daemonId first: a name that merely glob-matches a daemonId-shaped
	// selector must not be picked up by the name fallthrough below.
	const byId = entries.filter((e) => e.daemonId === selector);
	if (byId.length > 0) return byId;

	const label = LABEL_SELECTOR.exec(selector);
	if (label) {
		const want = label[2];
		return entries.filter((e) => e.labels.includes(want));
	}

	const project = PROJECT_SELECTOR.exec(selector);
	if (project) {
		const want = project[1];
		return entries.filter((e) => e.project === want);
	}

	const glob = compileGlob(selector);
	return entries.filter((e) => glob.test(e.name));
}
