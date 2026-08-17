import type { Route } from "./types";

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

export function errorJson(message: string, status = 400): Response {
	return json({ error: message }, status);
}

/**
 * Run a request through a route registry. Returns null when nothing matches.
 * Every handler call is wrapped in try/catch so a handler bug can never leak
 * a non-JSON 500 (or HTML) — responses are always JSON.
 */
export async function dispatchRequest(
	req: Request,
	registry: Route[],
	url: URL = new URL(req.url),
): Promise<Response | null> {
	for (const r of registry) {
		if (r.method !== req.method) continue;
		const m = url.pathname.match(r.pattern);
		if (!m) continue;
		try {
			return await r.handler({ req, url, params: m.slice(1) });
		} catch (err) {
			console.error("[http] handler error", { method: req.method, path: url.pathname, error: err });
			return errorJson("internal server error", 500);
		}
	}
	return null;
}
