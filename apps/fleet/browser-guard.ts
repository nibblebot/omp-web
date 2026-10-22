/** Fleet request helpers. The loopback browser-request guard (FEDGE-02) lives in #lib/runtime/browser-guard. */

/** Idle window for /auth/* requests on both listeners; other routes keep Bun's idleTimeout 0 (FEDGE-11). */
export const PRE_AUTH_IDLE_TIMEOUT_S = 10;

/** True when the body's media type is application/json (parameters ignored). */
export function isJsonRequest(req: Request): boolean {
	const type = req.headers.get("content-type");
	return type !== null && type.split(";")[0]?.trim().toLowerCase() === "application/json";
}
