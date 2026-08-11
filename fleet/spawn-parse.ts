/**
 * Pure parse/format helpers for the fleet's session-spawn surface
 * (README.md §Spawn templates). No subprocess, no live sessions — the spawn
 * SUPERVISOR imports from here.
 *
 * Wire contract:
 * - omp-session prints `OMP_SESSION|{"event":"listening",bind,port,url,advertise?}` on
 *   stdout immediately after bind; a remote wrapper MAY print
 *   `OMP_SESSION|{"event":"endpoint","url":…}` when the reachable address differs
 *   from the bind.
 * - Templates are trusted config: `{key}` substitution is plain text
 *   replacement, never shell-escaped.
 */

import type { StdoutContractLine } from "../src/protocol";

/** `OMP_SESSION|` prefix on contract stdout lines (R6b). */
const OMP_SESSION_PREFIX = "OMP_SESSION|";

/**
 * `{key}` substitution for spawn templates. Unknown keys are left verbatim
 * (a missing var is a template bug the caller should surface, not silent
 * data loss); `{labels}` in vars simply expands to whatever the caller built
 * (empty string when there are no labels). Values are inserted raw — no
 * shell escaping, templates are trusted config.
 */
export function fillTemplate(command: string, vars: Record<string, string>): string {
	return command.replace(/\{(\w+)\}/g, (match, key: string) => {
		return key in vars ? vars[key] : match;
	});
}

/**
 * Parse one `OMP_SESSION|` stdout line into a {@link StdoutContractLine}, or
 * `null` for anything that isn't one: non-prefixed lines (interleaved human
 * logs), malformed JSON, valid JSON with an unknown event, or a known event
 * with the wrong shape. Never throws.
 *
 * Validation per contract: `listening` requires `bind:string`,
 * `port:number`, `url:string` (advertise optional, must be a string when
 * present); `endpoint` requires `url:string`. Extra fields are ignored.
 */
export function parseContractLine(line: string): StdoutContractLine | null {
	if (typeof line !== "string" || !line.startsWith(OMP_SESSION_PREFIX)) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(OMP_SESSION_PREFIX.length));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.event === "listening") {
		if (
			typeof obj.bind !== "string" ||
			typeof obj.port !== "number" ||
			typeof obj.url !== "string" ||
			(obj.advertise !== undefined && typeof obj.advertise !== "string")
		) {
			return null;
		}
		const out: StdoutContractLine = { event: "listening", bind: obj.bind, port: obj.port, url: obj.url };
		if (obj.advertise !== undefined) {
			out.advertise = obj.advertise;
		}
		return out;
	}
	if (obj.event === "endpoint") {
		if (typeof obj.url !== "string") {
			return null;
		}
		return { event: "endpoint", url: obj.url };
	}
	return null;
}

/** How a resolved daemon endpoint was determined (R6b precedence tier). */
export interface ResolvedEndpoint {
	url: string;
	source: "wrapper" | "template" | "advertise" | "loopback";
}

/**
 * Resolve the reachable endpoint for a spawned session from its parsed
 * `OMP_SESSION|` lines, per R6b precedence:
 *
 *  1. wrapper `{event:"endpoint"}` url — the LAST endpoint line wins;
 *  2. `templateHost` + the last `listening` port;
 *  3. the last `listening` `advertise` url;
 *  4. loopback `ws://127.0.0.1:<port>`.
 *
 * Returns `null` until at least one `listening` line has been seen
 * (endpoint-only output doesn't count).
 */
export function resolveEndpoint(lines: StdoutContractLine[], templateHost?: string): ResolvedEndpoint | null {
	let listening: StdoutContractLine & { event: "listening" } | null = null;
	let lastEndpoint: string | null = null;
	for (const line of lines) {
		if (line.event === "listening") {
			listening = line;
		} else if (line.event === "endpoint") {
			lastEndpoint = line.url;
		}
	}
	if (listening === null) {
		return null;
	}
	if (lastEndpoint !== null) {
		return { url: lastEndpoint, source: "wrapper" };
	}
	if (templateHost) {
		return { url: `ws://${templateHost}:${listening.port}`, source: "template" };
	}
	if (listening.advertise !== undefined) {
		return { url: listening.advertise, source: "advertise" };
	}
	return { url: `ws://127.0.0.1:${listening.port}`, source: "loopback" };
}
