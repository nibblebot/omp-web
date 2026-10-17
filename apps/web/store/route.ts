/**
 * The browser URL hash as a typed route. The one module that owns the
 * deep-link grammar; there is no router, so everything that reads or writes
 * `location.hash` for Chat goes through `parseRoute` / `formatRoute`.
 *
 *   #/d/<daemonId>                    a daemon (its current session)
 *   #/d/<daemonId>/s/<sessionId>      one session of that daemon
 *   #/s/<file>, #/stored/<ws>/<id>    Analysis deep links (owned by tx/, kept verbatim)
 *
 * IDs are one `encodeURIComponent` segment each. Extend by adding a variant
 * to `Route` and one arm to each function (`#/d/<id>/agent/<agentId>`, U04);
 * unknown shapes parse to `none`, never to a partial match, so an older tab
 * ignores a newer link instead of misreading it.
 */
export type Route =
	| { kind: "none" }
	| { kind: "daemon"; daemonId: string }
	| { kind: "session"; daemonId: string; sessionId: string }
	/** A legacy Analysis hash, carried verbatim (`hash` includes the leading `#`). */
	| { kind: "analysis"; hash: string };

/** Analysis hashes (`#/s/<file>`, `#/stored/<ws>/<id>`; the leading `/` is optional). */
const ANALYSIS_HASH = /^#\/?(s|stored)\/.+/;

function decodeSegment(segment: string): string | null {
	if (segment === "") return null;
	try {
		return decodeURIComponent(segment);
	} catch {
		return null; // malformed percent-encoding
	}
}

/** Parse a `location.hash` value. Never throws; anything unrecognised is `none`. */
export function parseRoute(hash: string): Route {
	if (ANALYSIS_HASH.test(hash)) return { kind: "analysis", hash };
	const parts = hash.replace(/^#\/?/, "").split("/");
	if (parts[0] !== "d") return { kind: "none" };
	const daemonId = decodeSegment(parts[1] ?? "");
	if (daemonId === null) return { kind: "none" };
	if (parts.length === 2) return { kind: "daemon", daemonId };
	if (parts.length === 4 && parts[2] === "s") {
		const sessionId = decodeSegment(parts[3]!);
		if (sessionId !== null) return { kind: "session", daemonId, sessionId };
	}
	return { kind: "none" };
}

/** The hash for a route (with the leading `#`); `none` is the empty string. */
export function formatRoute(route: Route): string {
	switch (route.kind) {
		case "none":
			return "";
		case "daemon":
			return `#/d/${encodeURIComponent(route.daemonId)}`;
		case "session":
			return `#/d/${encodeURIComponent(route.daemonId)}/s/${encodeURIComponent(route.sessionId)}`;
		case "analysis":
			return route.hash;
	}
}
