import { isIP } from "node:net";

/**
 * Strict callback-ORIGIN admission for the Kubernetes lane (P5.4): the fleet
 * hands this origin to a Pod, so it must be a bare HTTPS origin (no
 * credentials, loopback/unspecified host, path, query, or fragment).
 *
 * `new URL` already yields the WHATWG-canonical host, so only the spellings
 * that survive it need classifying; no DNS resolution (a name is loopback only
 * when it is literally localhost). The daemon's own parseConfig deliberately
 * does not use this — a host-network bwrap fleet may hand its daemon a
 * loopback HTTPS URL (server/config.ts).
 */
export function parseKubernetesCallbackOrigin(value: string): string {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw.length === 0) {
		throw new Error(
			'callback url is empty (expected an https origin, e.g. "https://fleet.example.com")',
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(
			`invalid callback url "${value}" (not an absolute URL; expected an https origin, e.g. "https://fleet.example.com")`,
		);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(
			`invalid callback url "${value}" (scheme "${parsed.protocol.replace(":", "") || "none"}" is not https; the Kubernetes callback endpoint must be an HTTPS origin)`,
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new Error(
			`invalid callback url "${value}" carries credentials; the enrollment credential travels in the protected handoff, never in the URL`,
		);
	}
	if (parsed.pathname !== "" && parsed.pathname !== "/") {
		throw new Error(
			`invalid callback url "${value}" has path "${parsed.pathname}"; pass the bare origin (the callback routes /callback/up and /callback/down are appended by the daemon)`,
		);
	}
	if (parsed.search !== "") {
		throw new Error(
			`invalid callback url "${value}" has a query string; pass the bare origin (identity rides request headers, never the URL)`,
		);
	}
	if (parsed.hash !== "") {
		throw new Error(`invalid callback url "${value}" has a fragment; pass the bare origin`);
	}
	const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
	if (host.length === 0) {
		throw new Error(`invalid callback url "${value}" has no host; expected an https origin`);
	}
	const unreachable = unreachableHostKind(host);
	if (unreachable === "loopback") {
		throw new Error(
			`invalid callback url "${value}" uses loopback host "${host}", which a Pod cannot reach; use the fleet host's Pod-reachable HTTPS address`,
		);
	}
	if (unreachable === "unspecified") {
		throw new Error(
			`invalid callback url "${value}" uses unspecified address "${host}"; use the fleet host's Pod-reachable HTTPS address`,
		);
	}
	if (parsed.port !== "") {
		const port = Number(parsed.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(
				`invalid callback url "${value}" has invalid port "${parsed.port}" (1-65535)`,
			);
		}
	}
	return parsed.origin;
}

/**
 * Classify a WHATWG-canonical host the same way a Pod dial would: `localhost`
 * (with any trailing dots), canonical dotted IPv4 in 127/8, `::1`, `::`, and
 * the canonical `::ffff:<hex>:<hex>` IPv4-mapped form. Names that are not
 * literally localhost are dialable (no DNS here).
 */
function unreachableHostKind(host: string): "loopback" | "unspecified" | null {
	if (host.replace(/\.+$/, "") === "localhost") return "loopback";
	const family = isIP(host);
	if (family === 4) {
		if (host.startsWith("127.")) return "loopback";
		return host === "0.0.0.0" ? "unspecified" : null;
	}
	if (family !== 6) return null;
	if (host === "::1") return "loopback";
	if (host === "::") return "unspecified";
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
	if (mapped === null) return null;
	const hi = parseInt(mapped[1], 16);
	const lo = parseInt(mapped[2], 16);
	if ((hi | lo) === 0) return "unspecified";
	return hi >> 8 === 127 ? "loopback" : null;
}
