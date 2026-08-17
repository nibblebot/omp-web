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
 * - The advertised `url` is ws-shaped (`ws://host:port`) for legacy reasons
 *   (OMP_PROTO 2 is plain HTTP SSE): resolveEndpoint keeps it verbatim and
 *   the connector normalizes the scheme via daemonHttpBase. Consumers must
 *   never treat it as a WebSocket endpoint.
 * - Templates are trusted config; `{key}` substitution is plain text
 *   replacement with NO shell escaping. The substituted VALUES are not
 *   trusted (control-plane spawn takes name/labels from HTTP JSON), so any
 *   caller interpolating them into a shell command MUST shell-quote every
 *   value first (see shellQuote; supervisor.ts #launch does this).
 */

import { OMP_SESSION_PREFIX, type StdoutContractLine } from "../shared/protocol";

/**
 * `{key}` substitution for spawn templates. Unknown keys are left verbatim
 * (a missing var is a template bug the caller should surface, not silent
 * data loss); `{labels}` in vars simply expands to whatever the caller built
 * (empty string when there are no labels).
 *
 * This is PURE text substitution: values are inserted verbatim with no
 * shell escaping. The template itself is trusted config, but the values
 * substituted at runtime may be attacker-controlled (e.g. name/labels from
 * POST /ctl/spawn), so a caller that interpolates the result into a shell
 * command MUST run every value through {@link shellQuote} first —
 * supervisor.ts #launch does exactly that.
 */
export function fillTemplate(command: string, vars: Record<string, string>): string {
	return command.replace(/\{(\w+)\}/g, (match, key: string) => {
		return key in vars ? vars[key] : match;
	});
}

/**
 * Wrap a value in single quotes for safe insertion into a POSIX shell
 * command, escaping any embedded `'` as `'\''` (close quote, escaped quote,
 * reopen quote). Everything inside single quotes — spaces, `$()`, backticks,
 * `$VAR`, newlines — is literal, so this renders attacker-controlled values
 * inert when they end up in a template's `{key}` slot. Pair with
 * fillTemplate: quote first, then substitute.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * True when `raw` is a ws:// or wss:// URL — the fleet dial wire contract.
 * This is the SINGLE shared check for endpoint URLs: server.ts's /ctl/add +
 * spawn-hook validation, the supervisor's resolved-endpoint guard, and
 * parseContractLine all delegate here. Malformed strings ("garbage"),
 * hostless ws://, and non-ws protocols all fail. Pure: never throws.
 */
export function isValidEndpointUrl(raw: unknown): boolean {
	if (typeof raw !== "string" || raw === "") return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	return url.protocol === "ws:" || url.protocol === "wss:";
}

/**
 * Parse one `OMP_SESSION|` stdout line into a {@link StdoutContractLine}, or
 * `null` for anything that isn't one: non-prefixed lines (interleaved human
 * logs), malformed JSON, valid JSON with an unknown event, a known event
 * with the wrong shape, or a contract line carrying a malformed endpoint URL
 * (those are dropped as noise — a wrapper that prints garbage must not wedge
 * the resolve path). Never throws.
 *
 * Validation per contract: `listening` requires `bind:string`,
 * `port:number`, `url` a ws(s) URL (advertise optional, must be a ws(s) URL
 * when present); `endpoint` requires `url` a ws(s) URL. Extra fields are
 * ignored.
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
			!isValidEndpointUrl(obj.url) ||
			(obj.advertise !== undefined &&
				(typeof obj.advertise !== "string" || !isValidEndpointUrl(obj.advertise)))
		) {
			return null;
		}
		const out: StdoutContractLine = {
			event: "listening",
			bind: obj.bind,
			port: obj.port,
			url: obj.url,
		};
		if (obj.advertise !== undefined) {
			out.advertise = obj.advertise;
		}
		return out;
	}
	if (obj.event === "endpoint") {
		if (typeof obj.url !== "string" || !isValidEndpointUrl(obj.url)) {
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
export function resolveEndpoint(
	lines: StdoutContractLine[],
	templateHost?: string,
): ResolvedEndpoint | null {
	let listening: (StdoutContractLine & { event: "listening" }) | null = null;
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
