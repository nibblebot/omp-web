/**
 * Client-side correlation id, safe on non-secure origins.
 *
 * `crypto.randomUUID` is secure-context-only: a plain-HTTP origin such as
 * `http://192.168.5.15:4713` has none, and an unguarded call at module scope
 * aborts the whole bundle. `crypto.getRandomValues` is not restricted, so the
 * fallback builds the same v4 UUID. These ids are correlation tokens (command
 * dedup, attach routing, the page-scoped client id), never secrets.
 */

/** One RFC 4122 version 4 UUID, derived from `getRandomValues`. */
function uuidFromRandomValues(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	// Version 4 (random) and variant 10xx, per RFC 4122 section 4.4.
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A UUID for client-side correlation ids: `crypto.randomUUID()` where the
 * origin is a secure context, otherwise a generated v4 UUID. Never throws on
 * a plain-HTTP origin.
 */
export function randomId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return uuidFromRandomValues();
}
