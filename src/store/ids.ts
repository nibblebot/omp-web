/**
 * Client-side id generation, safe on non-secure origins.
 *
 * WHY this exists instead of calling `crypto.randomUUID()` directly:
 * `randomUUID` is defined only in a SECURE CONTEXT. Chrome treats `localhost`
 * and `127.0.0.1` as secure, but a plain-HTTP origin reached by any other
 * host, an IP address such as `http://192.168.5.15:4713`, is NOT one. There
 * `crypto.randomUUID` is `undefined`, so an unguarded call throws
 * `TypeError: crypto.randomUUID is not a function`. At module scope (the
 * page-scoped `clientId`) that aborts the whole bundle during evaluation and
 * the UI renders a blank page.
 *
 * `crypto.getRandomValues` is NOT restricted to secure contexts, so a
 * standards-shaped v4 UUID can be built from it wherever `randomUUID` is
 * missing. Ids here are correlation tokens (command dedup, attach routing,
 * the page-scoped client id), never secrets, so a locally generated v4 UUID
 * is all that is required. Same fallback discipline as `src/text/clipboard.ts`.
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
