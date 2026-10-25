/**
 * Production-profile preflight: a battery of environment checks for a
 * provider profile BEFORE its first use, so a broken or unsafe profile fails
 * here with an actionable message instead of at launch time.
 *
 * The fleet owns the host-generic rows:
 *  - profile executable present + executable bit (the in-process `host` kind
 *    has none: its row passes and says so);
 *  - callback URL reachability when configured: a DNS + TCP class check
 *    (skipped when the session would dial through a proxy, which resolves
 *    the host itself), then a real WebSocket upgrade to `/callback/ws`, the
 *    way the session dials it (same proxy resolution). The probe carries no
 *    identity and no credential, so the fleet closes it at once with a typed
 *    refusal, which proves the upgrade passed every hop and reached the
 *    fleet;
 *  - durable state dirs writable (workspace root + logs root; a missing dir
 *    passes when its parent is writable; those dirs are created lazily on
 *    demand, so a preflight must not require them to pre-exist);
 *  - secretRefs shape/resolvability.
 *
 * Each provider owns the rows about its own environment (bwrap binary and
 * user namespaces, runtime entry, tools, denied binds; kubernetes API,
 * namespace, RBAC, StorageClass, Secrets, image). The fleet obtains them by
 * invoking the provider executable's `preflight` op and merges them. The
 * in-process host kind has no executable to ask, so its rows (runtime entry,
 * runtime binary, an explicit no-sandbox row) come from runtime-preflight.ts.
 *
 * Every check that can fail carries an actionable remediation string. No
 * check installs tools, creates clusters, or fabricates credentials. All
 * checks run (no short-circuit); the overall `ok` is the AND of the checks.
 * Writes are confined to the writable-dirs probe (a temp entry created and
 * removed before the check returns).
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { dirname, isAbsolute, join } from "node:path";
import { runProviderOp } from "#lib/runtime/provider-exec";
import {
	PROVIDER_CAPABILITIES,
	buildPreflightRequest,
	isExecutableProfile,
	type ExecutableProfile,
	type PreflightCheck,
	type ProviderKind,
	type ProviderProfile,
} from "#lib/runtime/provider-protocol";
import { assertCallbackProxy, callbackWsUrl, environmentProxy } from "#lib/wire/callback-endpoint";
import {
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_PROTO_HEADER,
	OMP_CALLBACK_PROTO,
	callbackErrorFromClose,
} from "#lib/wire/callback-protocol";
import { preflightHostProfile } from "./runtime-preflight";

/** Wall-clock budget for the provider's preflight op: a kubernetes preflight runs one kubectl call per check. */
const PROVIDER_PREFLIGHT_TIMEOUT_MS = 120_000;
/** Wall-clock budget for the callback WebSocket upgrade probe (one attempt, no retry). */
const CALLBACK_PROBE_TIMEOUT_MS = 5000;

/** Bun's WebSocket client constructor with its upgrade `headers` and `proxy` options (the DOM typings hide them). */
const BunWebSocket = WebSocket as unknown as new (
	url: string | URL,
	options?: Bun.WebSocketOptions,
) => Bun.WebSocket;

// ---------------------------------------------------------------------------
// Typed report
// ---------------------------------------------------------------------------

/** Whole-profile preflight report (typed, serializable). */
export interface PreflightResult {
	ok: boolean;
	profileId: string;
	provider: ProviderKind;
	checks: PreflightCheck[];
}

/** Inputs the preflight needs beyond the profile itself. */
export interface PreflightContext {
	/** Fleet workspace root (managed clone workspaces live under it). */
	workspaceRoot: string;
	/** Fleet logs root (durable streamed-lineage store). */
	logsRoot: string;
	/**
	 * Callback base URL to probe: DNS + TCP, then a credential-less WebSocket
	 * upgrade to its `/callback/ws`. When omitted the callback check reports
	 * "not configured" and passes.
	 */
	callbackUrl?: string;
	/** Budget for the WebSocket upgrade probe; defaults to CALLBACK_PROBE_TIMEOUT_MS. */
	callbackProbeTimeoutMs?: number;
	/** Operator environment for secretRefs resolution and the HTTP(S)_PROXY / NO_PROXY the callback dial resolves; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Wall-clock budget for the provider's preflight op; defaults to PROVIDER_PREFLIGHT_TIMEOUT_MS. */
	providerTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Human message for an unexpected thrown value (several call sites). */
function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** True when the file exists and carries at least one execute bit. */
function isExecutable(p: string): boolean {
	try {
		return (statSync(p).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/** Resolve a tool path the way spawning would: absolute paths must exist,
 *  bare names resolve through PATH. */
function resolveToolPath(tool: string): string | null {
	if (tool.length === 0) return null;
	if (isAbsolute(tool)) return existsSync(tool) ? tool : null;
	return Bun.which(tool);
}

/**
 * Prove `dir` is (or will be) writable without leaving anything behind: a
 * dir that exists must accept a created+removed temp subdir; a missing dir
 * passes when its PARENT accepts one (the fleet creates these roots lazily
 * on demand, so preflight must not demand they pre-exist).
 */
function probeDirWritable(dir: string): { ok: true; note: string } | { ok: false; detail: string } {
	if (existsSync(dir)) {
		if (!statSync(dir).isDirectory()) {
			return { ok: false, detail: `${dir} exists but is not a directory` };
		}
		let probe: string | null = null;
		try {
			probe = mkdtempSync(join(dir, ".preflight-"));
			return { ok: true, note: `writable: ${dir}` };
		} catch (err) {
			return { ok: false, detail: `cannot create a temp dir inside ${dir}: ${errMessage(err)}` };
		} finally {
			if (probe !== null) rmSync(probe, { recursive: true, force: true });
		}
	}
	const parent = dirname(dir);
	if (!existsSync(parent)) {
		return { ok: false, detail: `${dir} does not exist and its parent ${parent} does not exist` };
	}
	let probe: string | null = null;
	try {
		probe = mkdtempSync(join(parent, ".preflight-"));
		return { ok: true, note: `${dir} is missing but its parent is writable, created on demand` };
	} catch (err) {
		return { ok: false, detail: `cannot create ${dir}: ${errMessage(err)}` };
	} finally {
		if (probe !== null) rmSync(probe, { recursive: true, force: true });
	}
}

/** One durable-dir row. */
function dirCheck(name: string, dir: string, what: string): PreflightCheck {
	const probe = probeDirWritable(dir);
	if (!probe.ok) {
		return {
			name,
			ok: false,
			detail: probe.detail,
			remediation: `make ${what} (${dir}) creatable/writable by the fleet user: \`mkdir -p ${dir}\` and \`chmod u+w ${dir}\``,
		};
	}
	return { name, ok: true, detail: probe.note };
}

/** Bound a DNS/fs promise by a timer so a hung resolver cannot stall the
 *  whole report. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((ok, fail) => {
		const timer = setTimeout(() => fail(new Error(`${what} timed out after ${ms}ms`)), ms);
		timer.unref();
		promise.then(
			(value) => {
				clearTimeout(timer);
				ok(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				fail(err);
			},
		);
	});
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** The executable row of a profile with no executable: the in-process host runtime. */
const HOST_RUNTIME_ROW: PreflightCheck = {
	name: "profile-executable",
	ok: true,
	detail: "in-process host runtime (no provider executable)",
};

async function checkExecutable(profile: ExecutableProfile): Promise<PreflightCheck> {
	const exe = resolveToolPath(profile.executable);
	if (exe === null) {
		return {
			name: "profile-executable",
			ok: false,
			detail: `provider executable not found: ${profile.executable}`,
			remediation:
				`point providerProfiles."${profile.id}".executable at an installed provider ` +
				`executable (absolute path, or a name on PATH)`,
		};
	}
	if (!isExecutable(exe)) {
		return {
			name: "profile-executable",
			ok: false,
			detail: `provider executable is not executable: ${exe}`,
			remediation: `run \`chmod +x ${exe}\` (or point providerProfiles."${profile.id}".executable at a runnable script)`,
		};
	}
	return { name: "profile-executable", ok: true, detail: exe };
}

/** Rows the provider owns: its `preflight` op, run through the shared provider executor (the in-process host runtime answers in process). */
async function checkProviderRows(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightCheck[]> {
	if (!isExecutableProfile(profile)) return preflightHostProfile(ctx.env ?? process.env);
	const failing = (detail: string, remediation: string): PreflightCheck[] => [
		{ name: "provider-preflight", ok: false, detail, remediation },
	];
	try {
		const response = await runProviderOp(
			profile.executable,
			buildPreflightRequest(profile, ctx.workspaceRoot),
			{ timeoutMs: ctx.providerTimeoutMs ?? PROVIDER_PREFLIGHT_TIMEOUT_MS },
		);
		if (!response.ok) {
			const { code, message } = response.error;
			return failing(
				`provider ${profile.executable} answered preflight with ${code}: ${message}`,
				code === "invalid_request"
					? `the provider executable does not support the preflight op (it predates it); ` +
							`update providerProfiles."${profile.id}".executable to a current ${profile.provider} provider`
					: `fix the provider error above, then re-run preflight`,
			);
		}
		if (response.checks.length === 0) {
			return failing(
				`provider ${profile.executable} returned no preflight checks`,
				`update providerProfiles."${profile.id}".executable to a current ${profile.provider} provider`,
			);
		}
		return response.checks;
	} catch (err) {
		return failing(
			`provider ${profile.executable} could not run preflight: ${errMessage(err)}`,
			`check that providerProfiles."${profile.id}".executable is a working ${profile.provider} provider ` +
				`(older executables that predate the preflight op fail here)`,
		);
	}
}

/** `proxy` without credentials, for display (a proxy URL may carry userinfo). */
function displayProxy(proxy: string): string {
	const url = new URL(proxy);
	url.username = "";
	url.password = "";
	return url.toString();
}

/** What a credential-less upgrade to the callback endpoint ended as. */
type CallbackProbe =
	| { kind: "fleet"; code: number; reason: string }
	| { kind: "refused"; detail: string }
	| { kind: "foreign"; detail: string }
	| { kind: "timeout"; opened: boolean };

/**
 * One WebSocket upgrade to `wsUrl` (through `proxy` when given) carrying no
 * identity and no credential, bounded by `timeoutMs`, never retried. The fleet
 * upgrades an unauthenticated request and closes it at once with a typed
 * refusal (close code 4000 + status); that answer is the proof of reach. The
 * socket is always closed before this returns.
 */
function probeCallbackSocket(
	wsUrl: string,
	proxy: string | undefined,
	timeoutMs: number,
): Promise<CallbackProbe> {
	return new Promise<CallbackProbe>((resolve) => {
		let opened = false;
		let error = "";
		let socket: Bun.WebSocket;
		try {
			socket = new BunWebSocket(wsUrl, {
				headers: { [CALLBACK_PROTO_HEADER]: String(OMP_CALLBACK_PROTO) },
				perMessageDeflate: false,
				...(proxy !== undefined ? { proxy } : {}),
			});
		} catch (err) {
			resolve({ kind: "refused", detail: errMessage(err) });
			return;
		}
		const finish = (outcome: CallbackProbe) => {
			clearTimeout(timer);
			socket.close();
			resolve(outcome);
		};
		const timer = setTimeout(() => finish({ kind: "timeout", opened }), timeoutMs);
		timer.unref();
		socket.addEventListener("open", () => {
			opened = true;
		});
		socket.addEventListener("error", (event) => {
			error = "message" in event && typeof event.message === "string" ? event.message : "";
		});
		socket.addEventListener("message", (event: Event) => {
			const data = "data" in event ? event.data : undefined;
			const pairReady = typeof data === "string" && data.includes(CALLBACK_PAIR_READY_TYPE);
			finish({
				kind: "foreign",
				detail: pairReady
					? "the endpoint accepted a credential-less pair"
					: "the endpoint answered the upgrade with data instead of a typed refusal",
			});
		});
		socket.addEventListener("close", (event) => {
			if (!opened) {
				finish({
					kind: "refused",
					detail: error !== "" ? error : event.reason || `close ${event.code}`,
				});
			} else if (callbackErrorFromClose(event.code, event.reason) !== null) {
				finish({ kind: "fleet", code: event.code, reason: event.reason });
			} else {
				finish({
					kind: "foreign",
					detail: `the endpoint upgraded, then closed with code ${event.code} instead of a typed refusal`,
				});
			}
		});
	});
}

/** The `callback-ws` row for one probe outcome. */
function callbackWsRow(
	probe: CallbackProbe,
	wsUrl: string,
	via: string,
	timeoutMs: number,
): PreflightCheck {
	const name = "callback-ws";
	const path = `GET ${new URL(wsUrl).pathname}`;
	switch (probe.kind) {
		case "fleet":
			return {
				name,
				ok: true,
				detail: `reached the fleet${via}: ${wsUrl} upgraded and the fleet answered a credential-less dial with its typed refusal (close ${probe.code}${probe.reason === "" ? "" : `, ${probe.reason}`})`,
			};
		case "refused":
			return {
				name,
				ok: false,
				detail: `WebSocket upgrade to ${wsUrl}${via} failed: ${probe.detail}`,
				remediation:
					`${path} must reach the omp-web control plane as a WebSocket upgrade: a reverse proxy or ingress ` +
					`must forward the Upgrade and Connection headers over HTTP/1.1 to the upstream, and the callback ` +
					`URL must name the control plane (a proxy that strips Upgrade, or a different service, answers a plain HTTP response)`,
			};
		case "foreign":
			return {
				name,
				ok: false,
				detail: `${wsUrl}${via} is a WebSocket endpoint but not the omp-web fleet: ${probe.detail}`,
				remediation: `point the callback URL at the omp-web control plane (the fleet closes a credential-less ${path} upgrade with a 4xxx refusal)`,
			};
		case "timeout":
			return {
				name,
				ok: false,
				detail: probe.opened
					? `${wsUrl}${via} upgraded but did not answer within ${timeoutMs}ms (the fleet closes a credential-less upgrade at once)`
					: `no WebSocket upgrade answer from ${wsUrl}${via} within ${timeoutMs}ms`,
				remediation: probe.opened
					? `point the callback URL at the omp-web control plane`
					: `check that the proxy or ingress forwards ${path} and does not hold the upgrade open or buffer it`,
			};
	}
}

/**
 * The callback rows. `callback-url`: URL shape, then DNS + TCP with a hard
 * deadline (nothing is written to the socket), skipped when the session would
 * dial through a proxy because the proxy resolves the host, not this host.
 * `callback-ws`: a credential-less WebSocket upgrade to `/callback/ws` through
 * the same proxy the session resolves, run only when `callback-url` passed.
 */
async function checkCallback(ctx: PreflightContext): Promise<PreflightCheck[]> {
	const urlRaw = ctx.callbackUrl;
	if (urlRaw === undefined) {
		return [
			{
				name: "callback-url",
				ok: true,
				detail: "not configured (no callback URL passed to preflight)",
			},
		];
	}
	const urlRow = await checkCallbackUrl(urlRaw, ctx);
	if (!urlRow.check.ok) return [urlRow.check];
	const timeoutMs = ctx.callbackProbeTimeoutMs ?? CALLBACK_PROBE_TIMEOUT_MS;
	const wsUrl = callbackWsUrl(urlRaw);
	const via = urlRow.proxy === undefined ? "" : ` via proxy ${displayProxy(urlRow.proxy)}`;
	const probe = await probeCallbackSocket(wsUrl, urlRow.proxy, timeoutMs);
	return [urlRow.check, callbackWsRow(probe, wsUrl, via, timeoutMs)];
}

async function checkCallbackUrl(
	urlRaw: string,
	ctx: PreflightContext,
): Promise<{ check: PreflightCheck; proxy?: string }> {
	const fail = (detail: string, remediation: string) => ({
		check: { name: "callback-url", ok: false, detail, remediation },
	});
	let url: URL;
	try {
		url = new URL(urlRaw);
	} catch {
		return fail(
			`callback URL is not a URL: ${urlRaw}`,
			`fix the callback URL (expected http:// or https://)`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return fail(
			`callback URL uses ${url.protocol}// (not http/https)`,
			`serve the callback over http:// or https://`,
		);
	}
	if (url.hostname === "") {
		return fail(`callback URL has no host: ${urlRaw}`, `include a hostname in the callback URL`);
	}
	let port: number;
	try {
		port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad port");
	} catch {
		return fail(
			`callback URL has an invalid port: ${urlRaw}`,
			`use a valid port in the callback URL`,
		);
	}
	let proxy: string | undefined;
	try {
		proxy = environmentProxy(url, ctx.env ?? process.env);
		if (proxy !== undefined) assertCallbackProxy(proxy);
	} catch (err) {
		return fail(
			errMessage(err),
			`set HTTP_PROXY / HTTPS_PROXY (minus NO_PROXY) to an http:// or https:// proxy URL, or unset it (there is no direct fallback)`,
		);
	}
	if (proxy !== undefined) {
		return {
			check: {
				name: "callback-url",
				ok: true,
				detail: `${url.hostname}:${port} is dialed through proxy ${displayProxy(proxy)}; direct DNS and TCP not checked (the proxy resolves and connects)`,
			},
			proxy,
		};
	}
	const deadline = Date.now() + 5000;
	const remaining = () => {
		const left = deadline - Date.now();
		return left > 0 ? left : 0;
	};

	// DNS class-check (hostname → addresses), bounded.
	let addresses: string[];
	try {
		const found = await withTimeout(
			lookup(url.hostname, { all: true }),
			Math.max(remaining(), 1),
			`DNS lookup for ${url.hostname}`,
		);
		addresses = found.map((entry) => entry.address);
	} catch (err) {
		return fail(
			`DNS lookup failed for ${url.hostname}: ${errMessage(err)}`,
			`check that ${url.hostname} resolves (fix the callback URL or DNS)`,
		);
	}
	if (addresses.length === 0) {
		return fail(
			`DNS returned no addresses for ${url.hostname}`,
			`check that ${url.hostname} has an A/AAAA record`,
		);
	}

	// TCP class-check (connect only, nothing is written), bounded per try.
	for (const address of addresses) {
		const budget = remaining();
		if (budget <= 0) break;
		const connected = await new Promise<boolean>((ok) => {
			const sock = connect({ host: address, port, timeout: budget });
			const done = (value: boolean) => {
				sock.destroy();
				ok(value);
			};
			sock.once("connect", () => done(true));
			sock.once("timeout", () => done(false));
			sock.once("error", () => done(false));
		});
		if (connected) {
			return {
				check: {
					name: "callback-url",
					ok: true,
					detail: `reachable: ${url.hostname}:${port} (TCP connect to ${address} succeeded)`,
				},
			};
		}
	}
	return fail(
		`TCP connect failed for ${url.hostname}:${port} (tried ${addresses.join(", ")})`,
		`the callback server must be reachable from the session host: start it (omp-web on the ` +
			`reachable bind), open firewall port ${port}, or fix the callback URL`,
	);
}

/** One row per durable state dir. */
async function checkDurableDirs(ctx: PreflightContext): Promise<PreflightCheck[]> {
	return [
		dirCheck("durable-workspace-root", ctx.workspaceRoot, "the workspace root"),
		dirCheck("durable-logs-root", ctx.logsRoot, "the logs root"),
	];
}

/**
 * Profile secret references must be resolvable on this host
 * BEFORE any launch. bwrap: `env:NAME` scheme only; values are supplied to
 * the fleet as environment variables; the sandbox never mounts operator
 * agent state. Kubernetes: values are cluster secret references resolved
 * API-side; this row is informational.
 */
async function checkProfileSecrets(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightCheck> {
	const refs = profile.secretRefs;
	if (refs === undefined || Object.keys(refs).length === 0) {
		return { name: "profile-secrets", ok: true, detail: "no secretRefs configured" };
	}
	if (PROVIDER_CAPABILITIES[profile.provider].secretResolution === "provider") {
		return {
			name: "profile-secrets",
			ok: true,
			detail: `secret references are resolved by the ${profile.provider} provider API-side (${Object.keys(refs).join(", ")})`,
		};
	}
	const environment = ctx.env ?? process.env;
	const missing: string[] = [];
	for (const [name, ref] of Object.entries(refs)) {
		if (!ref.startsWith("env:")) {
			return {
				name: "profile-secrets",
				ok: false,
				detail: `secretRefs.${name}: unsupported scheme "${ref}"`,
				remediation: `use "env:NAME" references; model credentials are supplied to the fleet as environment variables, never mounted from the operator agent dir`,
			};
		}
		const varName = ref.slice("env:".length);
		if (varName.length === 0) {
			return {
				name: "profile-secrets",
				ok: false,
				detail: `secretRefs.${name}: empty environment variable name`,
				remediation: `use "env:NAME" with a concrete variable name`,
			};
		}
		if (environment[varName] === undefined) {
			missing.push(varName);
		}
	}
	if (missing.length > 0) {
		return {
			name: "profile-secrets",
			ok: false,
			detail: `model credential env vars not set on the fleet host: ${missing.join(", ")}`,
			remediation:
				`set ${missing.join(", ")} for the provider process (systemd EnvironmentFile, ` +
				`container env, or a local env file) before launching this profile`,
		};
	}
	return {
		name: "profile-secrets",
		ok: true,
		detail: `${Object.keys(refs).length} secretRef(s) resolvable via env`,
	};
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Run the full preflight battery for a profile: the host-generic rows above,
 * then (when the provider executable is runnable) the rows the provider owns,
 * obtained by invoking its `preflight` op. A provider that rejects the op
 * (an older executable answers `invalid_request`), fails to run, or returns
 * no checks yields a failing row with remediation, never success. Never
 * throws for a check outcome: failures are rows; only an internal bug throws.
 */
export async function runProfilePreflight(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightResult> {
	const executable = isExecutableProfile(profile)
		? await checkExecutable(profile)
		: HOST_RUNTIME_ROW;
	const checks: PreflightCheck[] = [
		executable,
		...(await checkCallback(ctx)),
		...(await checkDurableDirs(ctx)),
		await checkProfileSecrets(profile, ctx),
		...(executable.ok ? await checkProviderRows(profile, ctx) : []),
	];
	return {
		ok: checks.every((check) => check.ok),
		profileId: profile.id,
		provider: profile.provider,
		checks,
	};
}
