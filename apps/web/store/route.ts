/**
 * The browser URL hash as a typed route. The one module that owns the
 * deep-link grammar; there is no router, so everything that reads or writes
 * `location.hash` for Chat goes through `parseRoute` / `formatRoute`.
 *
 *   #/w/<workspaceId>                    a workspace (its current session)
 *   #/w/<workspaceId>/s/<sessionId>      one session of that workspace
 *   #/s/<file>, #/stored/<ws>/<id>    Analysis deep links (owned by tx/, kept verbatim)
 *
 * IDs are one `encodeURIComponent` segment each. Extend by adding a variant
 * to `Route` and one arm to each function (`#/w/<id>/agent/<agentId>`, U04);
 * unknown shapes parse to `none`, never to a partial match, so an older tab
 * ignores a newer link instead of misreading it.
 */
export type Route =
	| { kind: "none" }
	| { kind: "workspace"; workspaceId: string }
	| { kind: "session"; workspaceId: string; sessionId: string; dock?: DockRoute }
	/** A legacy Analysis hash, carried verbatim (`hash` includes the leading `#`). */
	| { kind: "analysis"; hash: string };

/** The dock panel the URL names (U18): `kind` picks the panel, `id` an item inside it. */
export interface DockRoute {
	kind: string;
	id?: string;
}

/** Analysis hashes (`#/s/<file>`, `#/stored/<ws>/<id>`; the leading `/` is optional). */
const ANALYSIS_HASH = /^#\/?(s|stored)\/.+/;
const DOCK_KIND = /^[a-z][a-z0-9-]*$/;

function decodeSegment(segment: string): string | null {
	if (segment === "") return null;
	try {
		return decodeURIComponent(segment);
	} catch {
		return null; // malformed percent-encoding
	}
}

/** The dock segment: `<kind>` or `<kind>/<id>`. Null for any other shape. */
function parseDock(segments: string[]): DockRoute | null {
	const kind = segments[0] ?? "";
	if (!DOCK_KIND.test(kind)) return null;
	if (segments.length === 1) return { kind };
	if (segments.length !== 2) return null;
	const id = decodeSegment(segments[1] ?? "");
	return id === null ? null : { kind, id };
}

/** Parse a `location.hash` value. Never throws; anything unrecognised is `none`. */
export function parseRoute(hash: string): Route {
	if (ANALYSIS_HASH.test(hash)) return { kind: "analysis", hash };
	const parts = hash.replace(/^#\/?/, "").split("/");
	if (parts[0] !== "w") return { kind: "none" };
	const workspaceId = decodeSegment(parts[1] ?? "");
	if (workspaceId === null) return { kind: "none" };
	if (parts.length === 2) return { kind: "workspace", workspaceId };
	if (parts.length >= 4 && parts[2] === "s") {
		const sessionId = decodeSegment(parts[3]!);
		if (sessionId === null) return { kind: "none" };
		if (parts.length === 4) return { kind: "session", workspaceId, sessionId };
		const dock = parseDock(parts.slice(4));
		if (dock !== null) return { kind: "session", workspaceId, sessionId, dock };
	}
	return { kind: "none" };
}

/** The hash for a route (with the leading `#`); `none` is the empty string. */
export function formatRoute(route: Route): string {
	switch (route.kind) {
		case "none":
			return "";
		case "workspace":
			return `#/w/${encodeURIComponent(route.workspaceId)}`;
		case "session": {
			const base = `#/w/${encodeURIComponent(route.workspaceId)}/s/${encodeURIComponent(route.sessionId)}`;
			const dock = route.dock;
			if (dock === undefined) return base;
			const id = dock.id === undefined ? "" : `/${encodeURIComponent(dock.id)}`;
			return `${base}/${encodeURIComponent(dock.kind)}${id}`;
		}
		case "analysis":
			return route.hash;
	}
}
