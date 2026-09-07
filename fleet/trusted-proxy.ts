/**
 * Trusted-proxy matching (P2.3): IP/CIDR literal parsing and peer matching
 * for the fleet's forwarded-header policy. X-Forwarded-For / X-Forwarded-Proto
 * are honored ONLY when the direct socket peer matches the configured
 * trustedProxies list; this module is the single parser/matcher for that
 * list, shared by fleet/config.ts (entry validation at load) and
 * fleet/fleet-auth-gate.ts (per-request peer resolution).
 *
 * Matching rules:
 *   - A literal is either a bare IP (exact match) or `ip/prefix` (CIDR).
 *   - IPv4 and IPv6 literals are supported; IPv4-mapped IPv6 addresses
 *     (`::ffff:a.b.c.d`) compare as their IPv4 form, so a v4 rule matches a
 *     dual-stack socket peer and vice versa.
 *   - Anything that does not parse is NEVER a match (fail closed).
 */

export interface ParsedIp {
	bits: bigint;
	width: 32 | 128;
}

/** A compiled trusted-proxy list entry. */
export interface ProxyRule {
	/** Original literal as configured (for diagnostics). */
	readonly literal: string;
	matches(ip: string): boolean;
}

/** Strict dotted-quad: 1-3 digits per part, no leading zeros (no octal
 *  ambiguity like "010.0.0.1"), each ≤ 255. Returns the 32-bit value. */
function parseIpv4(value: string): bigint | null {
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	let bits = 0n;
	for (const part of parts) {
		if (!/^[0-9]{1,3}$/.test(part)) return null;
		if (part.length > 1 && part.startsWith("0")) return null;
		const n = Number(part);
		if (n > 255) return null;
		bits = (bits << 8n) | BigInt(n);
	}
	return bits;
}

/** Full IPv6: up to 8 hex groups, at most one "::" compression (which must
 *  compress at least one group), optional embedded dotted-quad tail counting
 *  as two groups. Zone ids ("%eth0") are rejected — not comparable. Returns
 *  the 128-bit value. */
function parseIpv6(value: string): bigint | null {
	const input = value.toLowerCase();
	if (input.includes("%")) return null;
	const halves = input.split("::");
	if (halves.length > 2) return null;
	const parseGroups = (text: string): number[] | null => {
		if (text === "") return [];
		const raw = text.split(":");
		const groups: number[] = [];
		for (let i = 0; i < raw.length; i++) {
			const group = raw[i]!;
			if (group.includes(".")) {
				// Embedded IPv4 is only ever the final group.
				if (i !== raw.length - 1) return null;
				const v4 = parseIpv4(group);
				if (v4 === null) return null;
				groups.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn));
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
			groups.push(Number.parseInt(group, 16));
		}
		return groups;
	};
	const head = parseGroups(halves[0]!);
	if (head === null) return null;
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		return head.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
	}
	const tail = parseGroups(halves[1]!);
	if (tail === null) return null;
	const missing = 8 - head.length - tail.length;
	if (missing < 1) return null; // "::" must stand for at least one group
	const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
	return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

/** Parse a bare IP literal. IPv4-mapped IPv6 normalizes to its IPv4 form so
 *  v4 and mapped-v6 spellings of the same peer compare equal. */
export function parseIp(value: string): ParsedIp | null {
	const input = value.trim();
	if (input === "") return null;
	if (input.includes(":")) {
		const bits = parseIpv6(input);
		if (bits === null) return null;
		if (bits >> 32n === 0xffffn) return { bits: bits & 0xffffffffn, width: 32 };
		return { bits, width: 128 };
	}
	const bits = parseIpv4(input);
	return bits === null ? null : { bits, width: 32 };
}

/** Compile one configured literal (`ip` or `ip/prefix`); null when malformed.
 *  A CIDR prefix wider than the address family is malformed; host bits in
 *  the literal are masked off, not rejected. Surrounding whitespace is
 *  tolerated; an empty literal is malformed. */
export function parseProxyRule(raw: string): ProxyRule | null {
	const literal = raw.trim();
	if (literal === "") return null;
	const slash = literal.indexOf("/");
	let prefix: number | null = null;
	let ipPart = literal;
	if (slash !== -1) {
		ipPart = literal.slice(0, slash);
		const prefixText = literal.slice(slash + 1);
		if (!/^[0-9]{1,3}$/.test(prefixText)) return null;
		prefix = Number(prefixText);
	}
	const parsed = parseIp(ipPart);
	if (parsed === null) return null;
	if (prefix !== null && prefix > parsed.width) return null;
	const shift = BigInt(parsed.width - (prefix ?? parsed.width));
	const network = parsed.bits >> shift;
	return {
		literal,
		matches(ip: string): boolean {
			const candidate = parseIp(ip);
			if (candidate === null || candidate.width !== parsed.width) return false;
			return candidate.bits >> shift === network;
		},
	};
}

/** Compile the configured list once (gate construction). Invalid literals
 *  are returned in `invalid` for a load-time warning and never match. */
export function compileTrustedProxies(literals: readonly string[]): {
	rules: ProxyRule[];
	invalid: string[];
} {
	const rules: ProxyRule[] = [];
	const invalid: string[] = [];
	for (const literal of literals) {
		const rule = parseProxyRule(literal);
		if (rule === null) invalid.push(literal);
		else rules.push(rule);
	}
	return { rules, invalid };
}

/** True iff the direct socket peer matches any compiled rule. A null peer
 *  (e.g. unix socket) is never a trusted proxy. */
export function isTrustedProxy(
	peer: string | null | undefined,
	rules: readonly ProxyRule[],
): boolean {
	if (peer === null || peer === undefined) return false;
	return rules.some((rule) => rule.matches(peer));
}
