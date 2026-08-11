import path from "node:path";

/**
 * omp-session config surface (README.md §Config surface). Flags map 1:1 to
 * env vars (`OMP_SESSION_*` only).
 */

export interface SessionConfig {
	/** Bound project root (R2), immutable for the process lifetime. */
	cwd: string;
	/** Listen port; 0 = ephemeral (the real port is reported in the OMP_SESSION| listening line). */
	port: number;
	/** Bind address; anything non-loopback requires --token. */
	host: string;
	/** Reported verbatim as the "advertise" field of the OMP_SESSION| listening line; does not affect the bind. */
	advertise?: string;
	/** Bearer token (R14). Off-loopback peers must present it (header, ?token=, or hello frame). */
	token?: string;
	/** Session file to switchSession() into at boot (R3); failure warns on stderr and starts fresh. */
	resume?: string;
	/** Idle auto-exit (R11); 0 disables. */
	idleTimeoutMs: number;
	/** Registry display name (defaults to the cwd basename). */
	name: string;
	/** Selector labels for fleet fan-out (R9). */
	labels: string[];
	/**
	 * Internal test hook (OMP_SESSION_TEST_READY_DELAY_MS): hold the readiness gate
	 * open N ms after the background model refresh resolves, so tests can
	 * exercise the not_ready path deterministically instead of racing a real
	 * model. 0 = no delay (production).
	 */
	readyDeferMs: number;
	collabMaxGuests: number;
	collabHostname?: string;
	collabUrl?: string;
}

/** Parse a duration string: `90s`, `30m`, `1h`, or a bare number = milliseconds. */
export function parseDuration(raw: string): number {
	const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
	if (!match) throw new Error(`invalid duration "${raw}" (expected e.g. 90s, 30m, 1h, or bare milliseconds)`);
	const n = Number(match[1]);
	switch (match[2]) {
		case "s":
			return n * 1000;
		case "m":
			return n * 60_000;
		case "h":
			return n * 3_600_000;
		default:
			return n;
	}
}

/** Loopback hosts: localhost, ::1, or anything in 127.0.0.0/8. */
export function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "localhost" || h === "::1" || h.startsWith("::ffff:127.")) return true;
	const parts = h.split(".");
	return parts.length === 4 && Number(parts[0]) === 127;
}

/**
 * Parse flags + env into the omp-session config. Throws with a human-readable
 * message on invalid input; the caller prints it to stderr and exits 1.
 */
export function parseConfig(argv: string[]): SessionConfig {
	// Repeated flags collect (--label k=v --label a=b); scalar flags take the first value.
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		const key = eq >= 0 ? body.slice(0, eq) : body;
		let value = eq >= 0 ? body.slice(eq + 1) : undefined;
		if (value === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
		const list = flags.get(key) ?? [];
		list.push(value ?? "");
		flags.set(key, list);
	}
	const flag = (key: string): string | undefined => flags.get(key)?.[0];

	const cwd = flag("cwd") ?? Bun.env.OMP_SESSION_CWD ?? process.cwd();

	const portRaw = flag("port") ?? Bun.env.OMP_SESSION_PORT ?? "4721";
	const port = Number(portRaw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`invalid port "${portRaw}" (0-65535; 0 = ephemeral)`);
	}

	const host = flag("host") ?? Bun.env.OMP_SESSION_HOST ?? "127.0.0.1";

	const idleTimeoutMs = parseDuration(flag("idle-timeout") ?? Bun.env.OMP_SESSION_IDLE_TIMEOUT ?? "30m");

	const labels = [
		...(flags.get("label") ?? []),
		...(Bun.env.OMP_SESSION_LABELS ?? "")
			.split(",")
			.map(s => s.trim())
			.filter(s => s.length > 0),
	];

	return {
		cwd,
		port,
		host,
		advertise: flag("advertise") ?? Bun.env.OMP_SESSION_ADVERTISE,
		token: flag("token") ?? Bun.env.OMP_SESSION_TOKEN,
		resume: flag("resume") ?? Bun.env.OMP_SESSION_RESUME,
		idleTimeoutMs,
		name: flag("name") ?? Bun.env.OMP_SESSION_NAME ?? path.basename(cwd),
		labels,
		readyDeferMs: Math.max(0, Number(Bun.env.OMP_SESSION_TEST_READY_DELAY_MS ?? 0) || 0),
		collabMaxGuests: Number(Bun.env.OMP_SESSION_COLLAB_MAX_GUESTS ?? 64),
		collabHostname: Bun.env.OMP_SESSION_COLLAB_HOSTNAME,
		collabUrl: Bun.env.OMP_SESSION_COLLAB_URL,
	};
}
