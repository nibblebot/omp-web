import path from "node:path";
import { isLoopbackHost } from "#lib/platform/hosts";

/**
 * omp-session config surface (docs/src/content/docs/reference/environment.md). Flags map 1:1 to
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
	/**
	 * Session file to switchSession() into at boot (R3); a failed restore exits
	 * OMP_SESSION_EXIT_RESUME_FAILED (78), never a fresh boot.
	 */
	resume?: string;
	/**
	 * `--resume` given without `--resume-unwritten`: a missing absolute file is a
	 * hard failure (exit 78) before bind. Only the flag is strict; the
	 * OMP_SESSION_RESUME env fallback (clone wake) keeps the lenient boot.
	 */
	resumeStrict: boolean;
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
	/**
	 * Callback transport (P3.2): fleet callback pair base URL, e.g.
	 * https://fleet.example.com. HTTPS required; HTTP only with the payload's allowHttp AND a loopback
	 * host (isLoopbackHost). Set only from `--fleet-stdin`.
	 */
	callbackUrl?: string;
	/** Roster daemonId the callback pair is bound to. */
	callbackWorkspace?: string;
	/** Authorized generation for the pair. */
	callbackGeneration?: number;
	/** Enrollment credential, presented as Authorization: Bearer on both halves. */
	callbackToken?: string;
	/**
	 * Explicit streaming proxy URL for the callback pair. Absent = direct.
	 * Only http/https proxies are supported; anything else is a startup error;
	 * there is no silent fallback to a direct connection.
	 */
	callbackProxy?: string;
	/** Explicit loopback HTTP exception (payload `allowHttp`); honored only for loopback callback hosts. */
	callbackAllowHttp: boolean;
	/**
	 * Grace before a session with a callback pair configured but no ready pair shuts itself
	 * down (ms; set by --control-grace, default 10m). 0 disables the grace shutdown.
	 */
	controlGraceMs: number;
	/**
	 * Mirror transcript logs over the callback pair (--log-mirror 0|1, default 1). Local
	 * spawns pass 0: their transcripts already live on the fleet host.
	 */
	logMirror: boolean;
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
 * Parse flags + env into the omp-session config. `fleet` is the payload read from `--fleet-stdin`
 * (the only source of the callback pair and the fleet-issued listener token). Throws with a
 * human-readable message on invalid input; the caller prints it to stderr and exits 1.
 */
export function parseConfig(argv: string[], fleet?: FleetStdinPayload): SessionConfig {
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

	// Callback transport (P3.2, docs/clone-contracts.md "Callback transport"). The pair arrives only
	// in the fleet's `--fleet-stdin` payload. HTTPS always; HTTP only with the payload's allowHttp for
	// a loopback host; an explicit proxy must be http/https, never silently ignored, never fallen back
	// from.
	if (flags.has("fleet-stdin") && fleet === undefined) {
		throw new Error("--fleet-stdin given but no payload was read");
	}
	const callbackAllowHttp = fleet?.callback.allowHttp === true;
	let callbackUrl: string | undefined;
	let callbackWorkspace: string | undefined;
	let callbackGeneration: number | undefined;
	let callbackProxy: string | undefined;
	if (fleet !== undefined) {
		let parsed: URL;
		try {
			parsed = new URL(fleet.callback.url);
		} catch {
			throw new Error(`invalid callback url "${fleet.callback.url}" (not a URL)`);
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new Error(
				`invalid callback url "${fleet.callback.url}" (${parsed.protocol} is not http/https)`,
			);
		}
		if (parsed.protocol === "http:") {
			if (!callbackAllowHttp) {
				throw new Error(
					`callback url refuses http "${fleet.callback.url}" (https required; allowHttp only opens loopback HTTP)`,
				);
			}
			if (!isLoopbackHost(parsed.hostname)) {
				throw new Error(`callback allowHttp only honors loopback hosts, got "${parsed.hostname}"`);
			}
		}
		callbackUrl = parsed.toString();
		callbackWorkspace = fleet.callback.workspace;
		callbackGeneration = fleet.callback.generation;
		if (!Number.isInteger(callbackGeneration) || callbackGeneration < 1) {
			throw new Error(`invalid callback generation "${callbackGeneration}" (positive integer)`);
		}
		if (fleet.callback.proxy !== undefined) {
			let proxyUrl: URL;
			try {
				proxyUrl = new URL(fleet.callback.proxy);
			} catch {
				throw new Error(`invalid callback proxy "${fleet.callback.proxy}" (not a URL)`);
			}
			if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
				throw new Error(
					`unsupported callback proxy scheme "${proxyUrl.protocol}" (${fleet.callback.proxy}); only http/https proxies are supported and there is no direct fallback`,
				);
			}
			callbackProxy = proxyUrl.toString();
		}
	}
	const controlGraceMs = parseDuration(
		flag("control-grace") ?? Bun.env.OMP_SESSION_CONTROL_GRACE ?? "10m",
	);
	const logMirrorRaw = flag("log-mirror") ?? Bun.env.OMP_SESSION_LOG_MIRROR ?? "1";
	if (logMirrorRaw !== "0" && logMirrorRaw !== "1") {
		throw new Error(`invalid --log-mirror "${logMirrorRaw}" (0 or 1)`);
	}
	return {
		cwd,
		port,
		host,
		advertise: flag("advertise") ?? Bun.env.OMP_SESSION_ADVERTISE,
		token: flag("token") ?? fleet?.token,
		resume: flag("resume") ?? Bun.env.OMP_SESSION_RESUME,
		resumeStrict: flag("resume") !== undefined && !flags.has("resume-unwritten"),
		idleTimeoutMs,
		name: flag("name") ?? Bun.env.OMP_SESSION_NAME ?? path.basename(cwd),
		labels,
		readyDeferMs: Math.max(0, Number(Bun.env.OMP_SESSION_TEST_READY_DELAY_MS ?? 0) || 0),
		idleCheckMs: Math.max(1, Number(Bun.env.OMP_SESSION_TEST_IDLE_CHECK_MS ?? 15000) || 15000),
		uiRequestTestHook: Bun.env.OMP_SESSION_TEST_UI_REQUEST === "1",
		collabMaxGuests: Number(Bun.env.OMP_SESSION_COLLAB_MAX_GUESTS ?? 64),
		callbackUrl,
		callbackWorkspace,
		callbackGeneration,
		callbackToken: fleet?.callback.token,
		callbackProxy,
		callbackAllowHttp,
		controlGraceMs,
		logMirror: logMirrorRaw === "1",
	};
}

/**
 * The pair identity and listener token the fleet hands a daemon on stdin (`--fleet-stdin`): one
 * JSON object read to EOF at boot. Neither the callback credential nor the listener token is in
 * the daemon's environment or argv, so agent tool subprocesses and other local users cannot read
 * them.
 */
export interface FleetStdinPayload {
	v: 1;
	callback: {
		url: string;
		workspace: string;
		generation: number;
		token: string;
		allowHttp?: true;
		proxy?: string;
	};
	token?: string;
}

/**
 * Parse the `--fleet-stdin` payload. Checks shape and field types only; `parseConfig` applies the
 * URL, https/loopback, generation, workspace and proxy rules. Throws a human-readable message
 * that never echoes secret values; the caller prints it and exits 1.
 */
export function parseFleetStdin(text: string): FleetStdinPayload {
	let raw: {
		v?: unknown;
		callback?: {
			url?: unknown;
			workspace?: unknown;
			generation?: unknown;
			token?: unknown;
			allowHttp?: unknown;
			proxy?: unknown;
		};
		token?: unknown;
	};
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("invalid --fleet-stdin payload (not JSON)");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("invalid --fleet-stdin payload (not an object)");
	}
	if (raw.v !== 1) throw new Error('unsupported --fleet-stdin payload version (expected "v": 1)');
	const callback = raw.callback;
	if (typeof callback !== "object" || callback === null || Array.isArray(callback)) {
		throw new Error("--fleet-stdin payload requires a callback object");
	}
	if (typeof callback.url !== "string" || callback.url === "") {
		throw new Error("--fleet-stdin callback.url must be a non-empty string");
	}
	if (typeof callback.workspace !== "string" || callback.workspace === "") {
		throw new Error("--fleet-stdin callback.workspace must be a non-empty string");
	}
	if (typeof callback.generation !== "number") {
		throw new Error("--fleet-stdin callback.generation must be a number");
	}
	if (typeof callback.token !== "string" || callback.token === "") {
		throw new Error("--fleet-stdin callback.token must be a non-empty string");
	}
	if (callback.allowHttp !== undefined && callback.allowHttp !== true) {
		throw new Error("--fleet-stdin callback.allowHttp must be true when present");
	}
	if (callback.proxy !== undefined && typeof callback.proxy !== "string") {
		throw new Error("--fleet-stdin callback.proxy must be a string when present");
	}
	if (raw.token !== undefined && (typeof raw.token !== "string" || raw.token === "")) {
		throw new Error("--fleet-stdin token must be a non-empty string when present");
	}
	return {
		v: 1,
		callback: {
			url: callback.url,
			workspace: callback.workspace,
			generation: callback.generation,
			token: callback.token,
			...(callback.allowHttp === true ? { allowHttp: true } : {}),
			...(callback.proxy !== undefined ? { proxy: callback.proxy } : {}),
		},
		...(raw.token !== undefined ? { token: raw.token } : {}),
	};
}
