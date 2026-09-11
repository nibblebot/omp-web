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
	/**
	 * Required resume (P5 wake): the resume target is mandatory, so parseConfig
	 * refuses this switch without one, and a resume that cannot be satisfied
	 * (no transcript on disk and none restorable from the fleet log store, or a
	 * failed session switch) exits before readiness instead of booting a fresh
	 * session. Set from --resume-required / OMP_SESSION_RESUME_REQUIRED=1 by
	 * the fleet only after the predecessor was proven terminated, so a fresh
	 * boot would silently lose the session.
	 */
	resumeRequired: boolean;
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
	/**
	 * Internal test hook (OMP_SESSION_TEST_IDLE_CHECK_MS): idle auto-exit check
	 * interval in ms (default 15000, production). Tests shrink it so the idle
	 * path is exercised fast instead of waiting on the real 15s tick.
	 */
	idleCheckMs: number;
	/**
	 * Internal test hook (OMP_SESSION_TEST_UI_REQUEST=1): accept a
	 * `test_ui_request` command that creates a real web ui_request, so tests
	 * exercise the dialog round-trip + ring invalidation (finding #16)
	 * without a model turn. Off in production; a fleet edge's allowlist
	 * rejects the type for browsers.
	 */
	uiRequestTestHook: boolean;
	collabMaxGuests: number;
	collabMaxRooms: number;
	collabHostname?: string;
	collabUrl?: string;
	/**
	 * Callback transport (P3.2): fleet callback pair base URL, e.g.
	 * https://fleet.example.com. HTTPS required and admitted as a bare origin
	 * (parseKubernetesCallbackUrl: no credentials, loopback or unspecified
	 * host, path, query, or fragment); HTTP only with --callback-allow-http
	 * AND a loopback host (isLoopbackHost).
	 */
	callbackUrl?: string;
	/** Roster daemonId the callback pair is bound to; required with --callback-url. */
	callbackWorkspace?: string;
	/** Authorized generation for the pair (defaults to 1 when --callback-url is set). */
	callbackGeneration?: number;
	/** Enrollment credential, presented as Authorization: Bearer on both halves. */
	callbackToken?: string;
	/**
	 * Explicit streaming proxy URL for the callback pair. Absent = direct.
	 * Only http/https proxies are supported; anything else is a startup error
	 * — there is no silent fallback to a direct connection.
	 */
	callbackProxy?: string;
	/** Explicit loopback HTTP exception; honored only for loopback callback URL hosts. */
	callbackAllowHttp: boolean;
}

/** Parse a duration string: `90s`, `30m`, `1h`, or a bare number = milliseconds. */
export function parseDuration(raw: string): number {
	const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
	if (!match)
		throw new Error(`invalid duration "${raw}" (expected e.g. 90s, 30m, 1h, or bare milliseconds)`);
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

/**
 * Loopback hosts: localhost, ::1, or anything in 127.0.0.0/8. Every dotted
 * part must be numeric — "127.a.b.c" resolves off-loopback and is NOT
 * loopback (same strictness as the runtime peer-address check in index.ts).
 */
export function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "localhost" || h === "::1") return true;
	const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
	const parts = v4.split(".");
	return parts.length === 4 && parts.every((p) => /^\d+$/.test(p)) && Number(parts[0]) === 127;
}

/** Unspecified bind addresses: never a dialable fleet host. */
const UNSPECIFIED_HOSTS: Record<string, true> = {
	"0.0.0.0": true,
	"::": true,
	"0:0:0:0:0:0:0:0": true,
};

/**
 * Strict callback-URL admission for the Kubernetes lane (P5.4): the fleet
 * hands this origin to a Pod, so it must be a bare HTTPS origin. Rejects
 * credentials (they would land in Pod environment), loopback and unspecified
 * hosts (a Pod cannot reach the operator's loopback), any non-root path,
 * queries, and fragments. Explicit ports are validated; the returned origin
 * is normalized (no trailing slash, default port dropped).
 *
 * One validator for every consumer: the daemon's own startup admission
 * (parseConfig), the fleet's handoff writer, and preflight all call this, so a
 * URL the daemon would refuse can never be written into a Pod spec first.
 */
export function parseKubernetesCallbackUrl(value: string): string {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw.length === 0) {
		throw new Error(
			'callback url is empty (expected an https origin, e.g. "https://fleet.example.com")',
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(
			`invalid callback url "${value}" (not an absolute URL; expected an https origin, e.g. "https://fleet.example.com")`,
		);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(
			`invalid callback url "${value}" (scheme "${parsed.protocol.replace(":", "") || "none"}" is not https; the Kubernetes callback endpoint must be an HTTPS origin)`,
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new Error(
			`invalid callback url "${value}" carries credentials; the enrollment credential travels in the protected handoff, never in the URL`,
		);
	}
	if (parsed.pathname !== "" && parsed.pathname !== "/") {
		throw new Error(
			`invalid callback url "${value}" has path "${parsed.pathname}"; pass the bare origin (the callback routes /callback/up and /callback/down are appended by the daemon)`,
		);
	}
	if (parsed.search !== "") {
		throw new Error(
			`invalid callback url "${value}" has a query string; pass the bare origin (identity rides request headers, never the URL)`,
		);
	}
	if (parsed.hash !== "") {
		throw new Error(`invalid callback url "${value}" has a fragment; pass the bare origin`);
	}
	const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
	if (host.length === 0) {
		throw new Error(`invalid callback url "${value}" has no host; expected an https origin`);
	}
	if (isLoopbackHost(host)) {
		throw new Error(
			`invalid callback url "${value}" uses loopback host "${host}", which a Pod cannot reach; use the fleet host's Pod-reachable HTTPS address`,
		);
	}
	if (UNSPECIFIED_HOSTS[host] === true) {
		throw new Error(
			`invalid callback url "${value}" uses unspecified address "${host}"; use the fleet host's Pod-reachable HTTPS address`,
		);
	}
	if (parsed.port !== "") {
		const port = Number(parsed.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(
				`invalid callback url "${value}" has invalid port "${parsed.port}" (1-65535)`,
			);
		}
	}
	return parsed.origin;
}

/**
 * Required-resume switch (P5 wake): a bare `--resume-required` and a `1`/`true`
 * value (flag or `OMP_SESSION_RESUME_REQUIRED`) enable it; an absent flag or
 * any other value leaves it off, so a stray value never arms a hard failure.
 */
function parseResumeRequired(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const value = raw.trim().toLowerCase();
	return value === "" || value === "1" || value === "true";
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
		if (value === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--"))
			value = argv[++i];
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

	const idleTimeoutMs = parseDuration(
		flag("idle-timeout") ?? Bun.env.OMP_SESSION_IDLE_TIMEOUT ?? "30m",
	);

	const labels = [
		...(flags.get("label") ?? []),
		...(Bun.env.OMP_SESSION_LABELS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	];

	// Callback transport (P3.2, docs/clone-contracts.md "Callback transport").
	// Enforcement lives here so a bad setup is a visible startup error instead
	// of a runtime surprise: HTTPS always, HTTP only behind an explicit
	// --callback-allow-http for a loopback host; an explicit proxy must be
	// http/https — never silently ignored, never fallen back from.
	const callbackAllowHttp =
		flags.has("callback-allow-http") || Bun.env.OMP_SESSION_CALLBACK_ALLOW_HTTP === "1";
	const callbackUrlRaw = flag("callback-url") ?? Bun.env.OMP_SESSION_CALLBACK_URL;
	let callbackUrl: string | undefined;
	if (callbackUrlRaw !== undefined) {
		let parsed: URL;
		try {
			parsed = new URL(callbackUrlRaw);
		} catch {
			throw new Error(`invalid --callback-url "${callbackUrlRaw}" (not a URL)`);
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new Error(
				`invalid --callback-url "${callbackUrlRaw}" (${parsed.protocol} is not http/https)`,
			);
		}
		if (parsed.protocol === "http:") {
			if (!callbackAllowHttp) {
				throw new Error(
					`--callback-url refuses http "${callbackUrlRaw}" (https required; --callback-allow-http only opens loopback HTTP)`,
				);
			}
			if (!isLoopbackHost(parsed.hostname)) {
				throw new Error(
					`--callback-allow-http only honors loopback hosts, got "${parsed.hostname}"`,
				);
			}
			callbackUrl = parsed.toString();
		} else {
			// HTTPS admission is the strict origin check the Kubernetes lane
			// shares with handoff validation and preflight (P5.4): credentials,
			// loopback/unspecified hosts, paths, queries, and fragments are all
			// refused here too, so a startup never accepts a URL the provider
			// (or a Pod) cannot dial.
			callbackUrl = parseKubernetesCallbackUrl(callbackUrlRaw);
		}
	}
	const callbackWorkspace = flag("callback-workspace") ?? Bun.env.OMP_SESSION_CALLBACK_WORKSPACE;
	if (callbackUrl !== undefined && callbackWorkspace === undefined) {
		throw new Error("--callback-url requires --callback-workspace (the pair is workspace-bound)");
	}
	const callbackGenerationRaw =
		flag("callback-generation") ?? Bun.env.OMP_SESSION_CALLBACK_GENERATION;
	let callbackGeneration: number | undefined;
	if (callbackGenerationRaw !== undefined) {
		callbackGeneration = Number(callbackGenerationRaw);
		if (!Number.isInteger(callbackGeneration) || callbackGeneration < 1) {
			throw new Error(
				`invalid --callback-generation "${callbackGenerationRaw}" (positive integer)`,
			);
		}
	} else if (callbackUrl !== undefined) {
		callbackGeneration = 1; // authorizedGeneration starts at 1
	}
	const callbackProxyRaw = flag("callback-proxy") ?? Bun.env.OMP_SESSION_CALLBACK_PROXY;
	let callbackProxy: string | undefined;
	if (callbackProxyRaw !== undefined) {
		let parsed: URL;
		try {
			parsed = new URL(callbackProxyRaw);
		} catch {
			throw new Error(`invalid --callback-proxy "${callbackProxyRaw}" (not a URL)`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(
				`unsupported --callback-proxy scheme "${parsed.protocol}" (${callbackProxyRaw}); only http/https proxies are supported and there is no direct fallback`,
			);
		}
		callbackProxy = parsed.toString();
	}
	// Required resume can never be satisfied without a target, so arming it
	// with no --resume/OMP_SESSION_RESUME would boot a fresh session and lose
	// the one the fleet asked to continue (finding #6). Fail closed at parse
	// time: the caller prints this to stderr and exits 1.
	const resume = flag("resume") ?? Bun.env.OMP_SESSION_RESUME;
	const resumeRequired = parseResumeRequired(
		flag("resume-required") ?? Bun.env.OMP_SESSION_RESUME_REQUIRED,
	);
	if (resumeRequired && (resume === undefined || resume.trim() === "")) {
		throw new Error(
			"--resume-required needs a resume target (--resume or OMP_SESSION_RESUME); refusing to boot a fresh session",
		);
	}
	return {
		cwd,
		port,
		host,
		advertise: flag("advertise") ?? Bun.env.OMP_SESSION_ADVERTISE,
		token: flag("token") ?? Bun.env.OMP_SESSION_TOKEN,
		resume,
		resumeRequired,
		idleTimeoutMs,
		name: flag("name") ?? Bun.env.OMP_SESSION_NAME ?? path.basename(cwd),
		labels,
		readyDeferMs: Math.max(0, Number(Bun.env.OMP_SESSION_TEST_READY_DELAY_MS ?? 0) || 0),
		idleCheckMs: Math.max(1, Number(Bun.env.OMP_SESSION_TEST_IDLE_CHECK_MS ?? 15000) || 15000),
		uiRequestTestHook: Bun.env.OMP_SESSION_TEST_UI_REQUEST === "1",
		collabMaxGuests: Number(Bun.env.OMP_SESSION_COLLAB_MAX_GUESTS ?? 64),
		// Floor of 1: the daemon's own collab host must always be able to
		// create its room (0 would brick collab with no way to opt out).
		collabMaxRooms: Math.max(1, Number(Bun.env.OMP_SESSION_COLLAB_MAX_ROOMS ?? 256) || 256),
		collabHostname: Bun.env.OMP_SESSION_COLLAB_HOSTNAME,
		collabUrl: Bun.env.OMP_SESSION_COLLAB_URL,
		callbackUrl,
		callbackWorkspace,
		callbackGeneration,
		callbackToken: flag("callback-token") ?? Bun.env.OMP_SESSION_CALLBACK_TOKEN,
		callbackProxy,
		callbackAllowHttp,
	};
}
