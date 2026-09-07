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
 *  - callback URL reachability CLASS-CHECK (DNS + TCP only; no bytes are
 *    ever written, so no credential or request can leak) when configured;
 *  - durable state dirs writable (workspace root + logs root; a missing dir
 *    passes when its parent is writable — those dirs are created lazily on
 *    demand, so a preflight must not require them to pre-exist);
 *  - profile tools: absolute, existing, and outside every forbidden root —
 *    a profile requesting a denied bind fails HERE with an actionable
 *    message (the same denylist the argv builder enforces at request time,
 *    P5.5);
 *  - k8s-only fields (storage class/size, image, namespace, secretRefs) are
 *    reported as NOT-YET-SUPPORTED (P5.3) rather than failed: on the bwrap
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
import {
	DeniedBindError,
	assertAllowedSource,
	assertWorkspaceVolume,
	defaultRuntimeLaunch,
	deriveDenyRoots,
} from "./bwrap-args";

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
	 * Callback URL to class-check (DNS + TCP only, never a request). When
	 * omitted the callback check reports "not configured" and passes.
	 */
	callbackUrl?: string;
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
				detail: `reachable: ${url.hostname}:${port} (TCP connect to ${address} succeeded; no request sent)`,
			};
		}
	}
	return {
		name: "callback-url",
		ok: false,
		detail: `TCP connect failed for ${url.hostname}:${port} (tried ${addresses.join(", ")})`,
		remediation:
			`the callback server must be reachable from the daemon host: start it (fleet serve on the ` +
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
 * Kubernetes provider rows (P5.3, P5.6): operator-explicit context,
 * namespace, image, and storage. These become hard failures — a kubernetes
 * profile without an explicit context must never silently use the ambient
 * current-context.
 */
async function checkKubernetesProvider(
	profile: ProviderProfile,
	ctx: PreflightContext,
): Promise<PreflightCheck[]> {
	if (profile.provider !== "kubernetes") return [];
	const context = profile.context ?? ctx.env?.OMP_KUBE_CONTEXT;
	const rows: PreflightCheck[] = [
		{
			name: "k8s-context",
			ok: context !== undefined && context !== "",
			detail: context !== undefined && context !== "" ? context : "no context configured",
			remediation:
				"set providerProfiles.<id>.context or OMP_KUBE_CONTEXT; the provider never " +
				"falls back to the ambient current-context",
		},
		{
			name: "k8s-namespace",
			ok: profile.namespace !== undefined && profile.namespace !== "",
			detail: profile.namespace ?? "not configured",
			remediation: "set providerProfiles.<id>.namespace (the operator-approved namespace)",
		},
		{
			name: "k8s-image",
			ok: profile.image !== undefined && profile.image !== "",
			detail: profile.image ?? "not configured",
			remediation: "set providerProfiles.<id>.image (the session runtime image)",
		},
	];
	if (profile.storage !== undefined) {
		const storage = profile.storage;
		const parts = [`class ${storage.class ?? "(default)"}`];
		if (storage.size !== undefined) parts.push(`size ${storage.size}`);
		rows.push({
			name: "k8s-storage",
			ok: true,
			detail: `${parts.join(", ")} (allocated via PVC; verify capacity before launch)`,
		});
	}
	return rows;
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
 * outcome — failures are rows; only an internal bug throws. Kubernetes
 * profiles run the host-generic checks plus the real API-requirement rows
 * (context/namespace/image/storage), never a not-yet-supported placeholder.
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
		await checkCallback(ctx),
		...(await checkDurableDirs(ctx)),
		await checkProfileTools(profile),
		await checkDeniedBinds(profile, ctx),
		await checkProfileSecrets(profile, ctx),
		...(await checkKubernetesProvider(profile, ctx)),
		checkStrayK8sFields(profile),
	];
	return {
		ok: checks.every((check) => check.ok),
		profileId: profile.id,
		provider: profile.provider,
		checks,
	};
}
