/**
 * Loopback hosts: localhost, ::1, or anything in 127.0.0.0/8. Every dotted
 * part must be numeric: "127.a.b.c" resolves off-loopback and is NOT
 * loopback (same strictness as the runtime peer-address check in index.ts).
 */
export function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "localhost" || h === "::1") return true;
	const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
	const parts = v4.split(".");
	return parts.length === 4 && parts.every((p) => /^\d+$/.test(p)) && Number(parts[0]) === 127;
}
