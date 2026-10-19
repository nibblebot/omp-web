/**
 * Origin a dev-proxied request presents to the fleet, or undefined to forward
 * the browser's Origin unchanged. The fleet's browser guard refuses a foreign
 * Origin, and a page served by vite on a LAN address has one. Only a
 * same-origin request (Origin names the Host vite itself served it on) is
 * re-presented as the loopback fleet origin: vite's allowedHosts already
 * gated that Host. Any other Origin passes through, so cross-site requests
 * keep failing the guard.
 */
export function fleetOrigin(
	host: string | undefined,
	origin: string | undefined,
	fleetPort: string,
): string | undefined {
	if (host === undefined || origin === undefined) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	if (parsed.host !== host.toLowerCase()) return undefined;
	return `http://localhost:${fleetPort}`;
}
