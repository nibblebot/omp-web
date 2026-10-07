import { BlockList, isIP } from "node:net";

/** 127.0.0.0/8 and ::1; BlockList also matches their IPv4-mapped IPv6 forms. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/**
 * Loopback hosts: localhost, or an IP literal in 127.0.0.0/8 / ::1 (including
 * ::ffff:127.x). Anything `isIP` rejects is NOT loopback: "127.a.b.c" or
 * "127.0.0.999" would resolve as a hostname, possibly off-loopback.
 */
export function isLoopbackHost(host: string): boolean {
	if (host.toLowerCase() === "localhost") return true;
	const family = isIP(host);
	if (family === 0) return false;
	return LOOPBACK.check(host, family === 4 ? "ipv4" : "ipv6");
}
