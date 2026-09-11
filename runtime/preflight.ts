/**
 * Production-profile preflight (P5.6): a battery of environment checks for a
 * provider profile BEFORE its first use, so a broken or unsafe profile fails
 * here with an actionable message instead of at launch time.
 *
 * Scope (frozen by the P5.6 lane contract):
 *  - bwrap binary present + version + user namespaces usable (probe
 *    `bwrap --ro-bind / / echo` — the same mount/namespace shape the real
 *    sandbox uses, trivially);
 *  - profile executable present + executable bit;
 *  - runtime entry (the sandboxed omp-session entry) + runtime binary (bun)
 *    resolvable;
 *  - callback URL reachability CLASS-CHECK from the FLEET HOST (DNS + TCP
 *    only; no bytes are ever written, so no credential or request can leak);
 *    optional for bwrap (no gateway required), REQUIRED for a kubernetes
 *    profile, which admits only an origin the shared Kubernetes origin
 *    validator accepts (`shared/callback-url.ts`) and cannot admit the
 *    loopback HTTP URL `serve` derives when none is configured;
 *  - durable state dirs writable (workspace root + logs root; a missing dir
 *    passes when its parent is writable — those dirs are created lazily on
 *    demand, so a preflight must not require them to pre-exist);
 *  - profile tools: absolute, existing, and outside every forbidden root —
 *    a profile requesting a denied bind fails HERE with an actionable
 *    message (the same denylist the argv builder enforces at request time,
 *    P5.5);
 *  - kubernetes profiles run the provider's own requirement preflight
 *    (`providers/kubernetes/preflight.ts`) in process, alongside the
 *    executable, callback, and durable-directory checks; an executor that
 *    cannot run becomes a failed row with remediation instead of an
 *    exception;
 *  - k8s-only fields on a bwrap profile stay informational: on the bwrap
 *    provider they are inert, and preflight must distinguish an inert
 *    declaration from an unsafe promise.
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProviderProfile } from "../shared/provider-protocol";
import { parseKubernetesCallbackOrigin } from "../shared/callback-url";
import {
	DeniedBindError,
	assertAllowedSource,
	assertWorkspaceVolume,
	defaultRuntimeLaunch,
	deriveDenyRoots,
} from "./bwrap-args";
import type { KubeExec } from "./providers/kubernetes/kubectl";
import { preflightKubernetesProfile } from "./providers/kubernetes/preflight";

// ---------------------------------------------------------------------------
// Typed report
// ---------------------------------------------------------------------------

/** One preflight check outcome. `remediation` is present exactly when the
 *  check failed and an operator action can fix it (not-yet-supported k8s
 *  rows are `ok: true` and carry the P5.3 status in `detail`). */
export interface PreflightCheck {
	name: string;
	ok: boolean;
	/** Human detail: what was probed and what came back. */
	detail: string;
	/** Actionable fix, present on failure. */
	remediation?: string;
}

/** Whole-profile preflight report (typed, serializable). */
export interface PreflightResult {
	ok: boolean;
	profileId: string;
	provider: "bwrap" | "kubernetes";
	checks: PreflightCheck[];
}

/** Inputs the preflight needs beyond the profile itself. */
export interface PreflightContext {
	/** Fleet workspace root (managed clone workspaces live under it). */
	workspaceRoot: string;
	/** Fleet logs root (durable streamed-lineage store). */
	logsRoot: string;
	/** Runtime entry the sandbox runs; provider default when omitted. */
	runtimeEntry?: string;
	/** Runtime binary (bun); provider default (process.execPath) when omitted. */
	runtimeBin?: string;
	/** bwrap binary; provider default ("bwrap" on PATH) when omitted. */
	bwrapBin?: string;
	/**
	 * Callback URL to class-check (DNS + TCP only, never a request). Optional
	 * for a bwrap profile: when omitted the check reports "not configured" and
	 * passes. A kubernetes profile requires it, because absent means `serve`
	 * derives a loopback HTTP URL that the Pod-reachable-HTTPS admission
	 * rejects, so the omission is a failed row with remediation. The check
	 * runs from the FLEET HOST, so it proves host reachability only.
	 */
	callbackUrl?: string;
	/**
	 * Kubernetes executor for the provider requirement preflight. Defaults to
	 * spawning `kubectl`; tests and the installed CLI inject an executor.
	 */
	kubeExec?: KubeExec;
	/** Operator environment for deny-root derivation; defaults to process.env. */
	env?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Human message for an unexpected thrown value (several call sites). */
function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Runtime entry default mirrors the provider's launch resolution. */
export function defaultRuntimeEntry(): string {
	return defaultRuntimeLaunch(process.env).entry;
}

/** Runtime binary default mirrors the provider (bun runs the provider, so
 *  execPath is it). */
export function defaultRuntimeBin(): string {
	return defaultRuntimeLaunch(process.env).bin;
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

/** bwrap path used for probes: absolute directly, else PATH resolution. */
function resolveBwrap(ctx: PreflightContext): string {
	const bwrapBin = ctx.bwrapBin ?? "bwrap";
	return isAbsolute(bwrapBin) ? bwrapBin : (Bun.which(bwrapBin) ?? bwrapBin);
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
		return { ok: true, note: `${dir} is missing but its parent is writable — created on demand` };
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

async function checkBwrapBinary(ctx: PreflightContext): Promise<PreflightCheck> {
	const resolved = resolveBwrap(ctx);
	if (!existsSync(resolved)) {
		return {
			name: "bwrap-binary",
			ok: false,
			detail: `bwrap not found at ${resolved}`,
			remediation:
				`install bubblewrap so bwrap is on PATH (e.g. \`nix profile install nixpkgs#bubblewrap\`), ` +
				`or point the provider at an installed binary via OMP_BWRAP_BIN`,
		};
	}
	let version = "";
	try {
		const proc = Bun.spawn([resolved, "--version"], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		version = `${stdout}${stderr}`.trim().split("\n")[0] ?? "";
		if ((code ?? 1) !== 0) {
			return {
				name: "bwrap-binary",
				ok: false,
				detail: `bwrap --version exited ${String(code)}: ${version}`,
				remediation: `the bwrap binary at ${resolved} does not run — reinstall bubblewrap`,
			};
		}
	} catch (err) {
		return {
			name: "bwrap-binary",
			ok: false,
			detail: `cannot run bwrap --version: ${errMessage(err)}`,
			remediation: `fix the bwrap binary at ${resolved} (permissions/loader) or reinstall bubblewrap`,
		};
	}
	return { name: "bwrap-binary", ok: true, detail: `bwrap ${version} at ${resolved}` };
}

async function checkBwrapUserns(ctx: PreflightContext): Promise<PreflightCheck> {
	const resolved = resolveBwrap(ctx);
	// Same namespace/mount shape as the real sandbox (ro-bind / then exec a
	// trivial command); exit 0 proves userns + mount + exec all work.
	const argv = [resolved, "--ro-bind", "/", "/", "--", "echo", "preflight-userns-ok"];
	try {
		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const detail = `${stdout}${stderr}`.trim().split("\n").slice(0, 3).join(" ");
		if ((code ?? 1) !== 0) {
			return {
				name: "bwrap-userns",
				ok: false,
				detail: `sandbox probe failed (rc ${String(code)}): ${detail || "no output"}`,
				remediation:
					`user namespaces appear unavailable — enable unprivileged user namespaces ` +
					`(kernel.unprivileged_userns_clone=1 / AppArmor profile permitting bwrap) or run the fleet ` +
					`under a user-namespace-capable service`,
			};
		}
		return { name: "bwrap-userns", ok: true, detail: `sandbox probe ran (${argv.join(" ")})` };
	} catch (err) {
		return {
			name: "bwrap-userns",
			ok: false,
			detail: `sandbox probe could not run: ${errMessage(err)}`,
			remediation: `cannot spawn ${resolved} — fix its permissions/loader or reinstall bubblewrap`,
		};
	}
}

async function checkExecutable(profile: ProviderProfile): Promise<PreflightCheck> {
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

async function checkRuntimeEntry(ctx: PreflightContext): Promise<PreflightCheck> {
	const launch = defaultRuntimeLaunch(process.env);
	const entry = resolve(ctx.runtimeEntry ?? launch.entry);
	if (!existsSync(entry)) {
		return {
			name: "runtime-entry",
			ok: false,
			detail: `runtime entry not found: ${entry}`,
			remediation:
				`the sandbox runs the repo's server/index.ts (dev) or the installed cli.js ` +
				`(bundle). Set OMP_RUNTIME_ENTRY to the built session runtime entry, or ` +
				`rebuild/install omp-web`,
		};
	}
	const detail = launch.args.length > 0 ? `${entry} (bundle session mode)` : entry;
	return { name: "runtime-entry", ok: true, detail };
}

async function checkRuntimeBin(ctx: PreflightContext): Promise<PreflightCheck> {
	const shown = ctx.runtimeBin ?? `bun (${defaultRuntimeBin()})`;
	const bin = resolveToolPath(ctx.runtimeBin ?? defaultRuntimeBin());
	if (bin === null) {
		return {
			name: "runtime-bin",
			ok: false,
			detail: `runtime binary not found: ${shown}`,
			remediation: `install bun (the sandboxed omp-session runs under bun) or set OMP_RUNTIME_BIN`,
		};
	}
	if (!isExecutable(bin)) {
		return {
			name: "runtime-bin",
			ok: false,
			detail: `runtime binary is not executable: ${bin}`,
			remediation: `fix permissions on ${bin} (chmod +x)`,
		};
	}
	return { name: "runtime-bin", ok: true, detail: bin };
}

/**
 * Remediation shared by every kubernetes callback-gateway failure: the one
 * thing an operator can set to make the lane admit a clone.
 */
const KUBE_CALLBACK_REMEDIATION =
	`set OMP_FLEET_CALLBACK_URL to the fleet host's Pod-reachable HTTPS origin ` +
	`(bare origin; no credentials, loopback or unspecified address, path, query, or fragment)`;

/**
 * DNS + TCP class-check with a hard deadline, run from the FLEET HOST: it
 * proves host reachability only (a Pod reaches the gateway through the
 * cluster network, verified by the Pod itself at enrollment). Nothing is ever
 * written to the socket, so no credential or request can leak.
 *
 * A kubernetes profile admits only what the shared Kubernetes origin
 * validator returns, and requires the URL at all: with none configured
 * `serve` derives a loopback HTTP callback URL that admission rejects, so the
 * omission itself is a failed row instead of a fleet-host-side silence.
 */
async function checkCallback(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightCheck> {
	const urlRaw = ctx.callbackUrl;
	if (urlRaw === undefined) {
		if (profile.provider === "kubernetes") {
			return {
				name: "callback-url",
				ok: false,
				detail:
					"no callback gateway configured (OMP_FLEET_CALLBACK_URL is unset); a kubernetes " +
					"clone hands this origin to its Pod and admission requires a Pod-reachable HTTPS origin",
				remediation: KUBE_CALLBACK_REMEDIATION,
			};
		}
		return {
			name: "callback-url",
			ok: true,
			detail: "not configured (no callback URL passed to preflight)",
		};
	}
	let url: URL;
	if (profile.provider === "kubernetes") {
		try {
			url = new URL(parseKubernetesCallbackOrigin(urlRaw));
		} catch (err) {
			return {
				name: "callback-url",
				ok: false,
				detail: `callback URL rejected for the kubernetes lane: ${errMessage(err)}`,
				remediation: KUBE_CALLBACK_REMEDIATION,
			};
		}
	} else {
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
			detail: `DNS lookup from the fleet host failed for ${url.hostname}: ${errMessage(err)}`,
			remediation: `check that ${url.hostname} resolves from the fleet host (fix the callback URL or DNS)`,
		};
	}
	if (addresses.length === 0) {
		return {
			name: "callback-url",
			ok: false,
			detail: `DNS from the fleet host returned no addresses for ${url.hostname}`,
			remediation: `check that ${url.hostname} has an A/AAAA record resolvable from the fleet host`,
		};
	}

	// TCP class-check (connect only — nothing is written), bounded per try.
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
				detail: `reachable from the fleet host: ${url.hostname}:${port} (TCP connect to ${address} succeeded; no request sent)`,
			};
		}
	}
	return {
		name: "callback-url",
		ok: false,
		detail: `TCP connect from the fleet host failed for ${url.hostname}:${port} (tried ${addresses.join(", ")})`,
		remediation:
			`the callback server must be reachable from the fleet host: start it (fleet serve on the ` +
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

/** Profile tools must be absolute and existing (a missing tool ro-binds
 *  nothing and breaks the sandbox at launch). */
async function checkProfileTools(profile: ProviderProfile): Promise<PreflightCheck> {
	for (const tool of profile.tools) {
		if (!isAbsolute(tool)) {
			return {
				name: "profile-tools",
				ok: false,
				detail: `tool path is not absolute: "${tool}"`,
				remediation:
					`use an absolute tool path in providerProfiles."${profile.id}".tools ` +
					`(bare names cannot be ro-bound)`,
			};
		}
		if (!existsSync(tool)) {
			return {
				name: "profile-tools",
				ok: false,
				detail: `tool not found: ${tool}`,
				remediation: `install the tool at ${tool} or remove it from providerProfiles."${profile.id}".tools`,
			};
		}
	}
	return {
		name: "profile-tools",
		ok: true,
		detail: `${profile.tools.length} tool(s) absolute and present`,
	};
}

/**
 * Denied-bind sanity (P5.5): a profile that requests a bind inside a
 * forbidden root (operator home/ssh state, container sockets, fleet/provider
 * state) fails HERE with an actionable message.
 */
async function checkDeniedBinds(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightCheck> {
	const roots = deriveDenyRoots(ctx.env ?? process.env);
	try {
		// The workspace root is the sanctioned volume root for clone dirs; it
		// must never alias credentials/sockets/provider state.
		assertWorkspaceVolume(resolve(ctx.workspaceRoot), roots);
	} catch (err) {
		if (err instanceof DeniedBindError) {
			return {
				name: "denied-binds",
				ok: false,
				detail: `the workspace root ${ctx.workspaceRoot} is inside a forbidden root (${err.root}, ${err.kind})`,
				remediation:
					`move the fleet workspace root outside ${err.root} — operator home/ssh state, ` +
					`container sockets, and fleet/provider state are never bindable`,
			};
		}
		throw err;
	}
	for (const tool of profile.tools) {
		try {
			assertAllowedSource(tool, roots);
		} catch (err) {
			if (!(err instanceof DeniedBindError)) throw err;
			return {
				name: "denied-binds",
				ok: false,
				detail: `tool ${tool} resolves inside a forbidden root (${err.root}, ${err.kind})`,
				remediation:
					`remove "${tool}" from providerProfiles."${profile.id}".tools — operator home/ssh ` +
					`state, container sockets, and fleet/provider state are never mounted into a sandbox`,
			};
		}
	}
	return {
		name: "denied-binds",
		ok: true,
		detail: "workspace root and all profile tools are outside forbidden roots",
	};
}

/**
 * P5.4/P5.5: profile secret references must be resolvable on this host
 * BEFORE any launch. bwrap: `env:NAME` scheme only — values are supplied to
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
	if (profile.provider === "kubernetes") {
		return {
			name: "profile-secrets",
			ok: true,
			detail: `k8s secret references are resolved by the provider API-side (${Object.keys(refs).join(", ")})`,
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
				remediation: `use "env:NAME" references — model credentials are supplied to the fleet as environment variables, never mounted from the operator agent dir`,
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

/**
 * Kubernetes requirement rows: the provider's own requirement preflight
 * (`providers/kubernetes/preflight.ts`) run in process with the same executor
 * the provider uses; its rows already carry specific remediation. An executor
 * that throws (kubectl missing, unspawnable API client) becomes a failed row
 * here instead of escaping the report.
 */
async function providerRequirementChecks(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightCheck[]> {
	if (profile.provider !== "kubernetes") return [];
	try {
		const result = await preflightKubernetesProfile(profile, {
			exec: ctx.kubeExec,
			env: ctx.env ?? process.env,
		});
		return result.checks;
	} catch (err) {
		return [
			{
				name: "kube-preflight",
				ok: false,
				detail: `kubernetes requirement preflight could not run: ${errMessage(err)}`,
				remediation:
					`install kubectl (>= 1.27) on the fleet host, or set OMP_KUBE_BIN to an absolute ` +
					`kubectl path the fleet user can execute, then re-run ` +
					`\`omp-web preflight --profile ${profile.id}\``,
			},
		];
	}
}

/** k8s-only fields on a non-kubernetes profile: informational only. */
function checkStrayK8sFields(profile: ProviderProfile): PreflightCheck {
	const parts: string[] = [];
	if (profile.provider !== "kubernetes" && profile.provider !== "bwrap") {
		parts.push(`provider "${profile.provider}"`);
	}
	if (profile.image !== undefined) parts.push(`image "${profile.image}"`);
	if (profile.namespace !== undefined) parts.push(`namespace "${profile.namespace}"`);
	if (profile.context !== undefined) parts.push(`context "${profile.context}"`);
	if (profile.storage !== undefined) {
		const storage = profile.storage;
		const fields: string[] = [];
		if (storage.class !== undefined) fields.push(`class "${storage.class}"`);
		if (storage.size !== undefined) fields.push(`size "${storage.size}"`);
		parts.push(`storage (${fields.join(", ")})`);
	}
	if (parts.length === 0) {
		return { name: "k8s-fields", ok: true, detail: "no k8s-only fields configured" };
	}
	return {
		name: "k8s-fields",
		ok: true,
		detail: `configured but not yet supported on ${profile.provider} (P5.3): ${parts.join("; ")}`,
	};
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Run the full preflight battery for a profile. Never throws for a check
 * outcome: failures are rows; only an internal bug throws. Kubernetes
 * profiles run the host-generic checks alongside the provider's own
 * requirement preflight (context, API, namespace, RBAC, StorageClass,
 * Secret keys, image); the former k8s summary rows are gone, so there is
 * exactly one owner per requirement.
 */
export async function runProfilePreflight(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightResult> {
	const hostChecks: PreflightCheck[] =
		profile.provider === "bwrap"
			? [
					await checkBwrapBinary(ctx),
					await checkBwrapUserns(ctx),
					await checkRuntimeEntry(ctx),
					await checkRuntimeBin(ctx),
				]
			: [
					// Kubernetes runs the daemon in a pod image, not a host
					// bwrap sandbox: host bwrap/runtime checks are not applicable.
				];
	const checks: PreflightCheck[] = [
		...hostChecks,
		await checkExecutable(profile),
		await checkCallback(profile, ctx),
		...(await checkDurableDirs(ctx)),
		await checkProfileTools(profile),
		await checkDeniedBinds(profile, ctx),
		await checkProfileSecrets(profile, ctx),
		...(await providerRequirementChecks(profile, ctx)),
		// k8s-only fields are informational on the providers where they are
		// inert; a kubernetes profile's fields are checked by the provider
		// preflight above, so the stray-fields row is bwrap-only.
		...(profile.provider === "kubernetes" ? [] : [checkStrayK8sFields(profile)]),
	];
	return {
		ok: checks.every((check) => check.ok),
		profileId: profile.id,
		provider: profile.provider,
		checks,
	};
}
