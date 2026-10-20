/**
 * Production-profile preflight: a battery of environment checks for a
 * provider profile BEFORE its first use, so a broken or unsafe profile fails
 * here with an actionable message instead of at launch time.
 *
 * The fleet owns the host-generic rows:
 *  - profile executable present + executable bit (the in-process `host` kind
 *    has none: its row passes and says so);
 *  - callback URL reachability CLASS-CHECK (DNS + TCP only; no bytes are
 *    ever written, so no credential or request can leak) when configured;
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
import { preflightHostProfile } from "./runtime-preflight";

/** Wall-clock budget for the provider's preflight op: a kubernetes preflight runs one kubectl call per check. */
const PROVIDER_PREFLIGHT_TIMEOUT_MS = 120_000;

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
	 * Callback URL to class-check (DNS + TCP only, never a request). When
	 * omitted the callback check reports "not configured" and passes.
	 */
	callbackUrl?: string;
	/** Operator environment for secretRefs resolution; defaults to process.env. */
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

/** DNS + TCP class-check with a hard deadline. Nothing is ever written to
 *  the socket, so no credential or request can leak. */
async function checkCallback(ctx: PreflightContext): Promise<PreflightCheck> {
	const urlRaw = ctx.callbackUrl;
	if (urlRaw === undefined) {
		return {
			name: "callback-url",
			ok: true,
			detail: "not configured (no callback URL passed to preflight)",
		};
	}
	let url: URL;
	try {
		url = new URL(urlRaw);
	} catch {
		return {
			name: "callback-url",
			ok: false,
			detail: `callback URL is not a URL: ${urlRaw}`,
			remediation: `fix the callback URL (expected http:// or https://)`,
		};
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			name: "callback-url",
			ok: false,
			detail: `callback URL uses ${url.protocol}// (not http/https)`,
			remediation: `serve the callback over http:// or https://`,
		};
	}
	if (url.hostname === "") {
		return {
			name: "callback-url",
			ok: false,
			detail: `callback URL has no host: ${urlRaw}`,
			remediation: `include a hostname in the callback URL`,
		};
	}
	let port: number;
	try {
		port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad port");
	} catch {
		return {
			name: "callback-url",
			ok: false,
			detail: `callback URL has an invalid port: ${urlRaw}`,
			remediation: `use a valid port in the callback URL`,
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
		return {
			name: "callback-url",
			ok: false,
			detail: `DNS lookup failed for ${url.hostname}: ${errMessage(err)}`,
			remediation: `check that ${url.hostname} resolves (fix the callback URL or DNS)`,
		};
	}
	if (addresses.length === 0) {
		return {
			name: "callback-url",
			ok: false,
			detail: `DNS returned no addresses for ${url.hostname}`,
			remediation: `check that ${url.hostname} has an A/AAAA record`,
		};
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
				name: "callback-url",
				ok: true,
				detail: `reachable: ${url.hostname}:${port} (TCP connect to ${address} succeeded; no request sent)`,
			};
		}
	}
	return {
		name: "callback-url",
		ok: false,
		detail: `TCP connect failed for ${url.hostname}:${port} (tried ${addresses.join(", ")})`,
		remediation:
			`the callback server must be reachable from the daemon host: start it (omp-web on the ` +
			`reachable bind), open firewall port ${port}, or fix the callback URL`,
	};
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
		await checkCallback(ctx),
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
