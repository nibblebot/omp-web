/**
 * bwrap provider preflight (the `preflight` op of apps/fleet/bwrap-provider.ts):
 * the environment checks that only make sense for the bwrap sandbox, owned by
 * the provider rather than the fleet:
 *  - bwrap binary present + version, and user namespaces usable (probe
 *    `bwrap --ro-bind / / echo`, the same mount/namespace shape the real
 *    sandbox uses, trivially);
 *  - runtime entry (the sandboxed omp-session entry) + runtime binary (bun)
 *    resolvable;
 *  - profile tools: absolute and existing (a missing tool ro-binds nothing);
 *  - denied binds: the workspace volume root and every profile tool sit
 *    outside every forbidden root (the same denylist the argv builder
 *    enforces at request time).
 *
 * Every failing check carries an actionable remediation. No check installs
 * anything or writes to disk. All checks run (no short-circuit).
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	DeniedBindError,
	assertAllowedSource,
	assertWorkspaceVolume,
} from "#lib/runtime/bwrap-args";
import type { PreflightCheck, BwrapProfile } from "#lib/runtime/provider-protocol";
import { defaultDenyRoots } from "./runtime-launch";
import { checkRuntimeBin, checkRuntimeEntry } from "./runtime-preflight";

/** Inputs beyond the profile: the fleet workspace volume root and the provider's environment. */
export interface BwrapPreflightOptions {
	/** Fleet workspace volume root (managed clone workspaces live under it). */
	workspaceRoot: string;
	/**
	 * Provider environment: OMP_BWRAP_BIN, OMP_RUNTIME_ENTRY, OMP_RUNTIME_BIN,
	 * and the operator HOME the deny roots derive from. Defaults to process.env.
	 */
	env?: Record<string, string | undefined>;
}

/** Human message for an unexpected thrown value. */
function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** bwrap path used for probes: absolute directly, else PATH resolution. */
function resolveBwrap(env: Record<string, string | undefined>): string {
	const bwrapBin = env.OMP_BWRAP_BIN ?? "bwrap";
	return isAbsolute(bwrapBin) ? bwrapBin : (Bun.which(bwrapBin) ?? bwrapBin);
}

async function checkBwrapBinary(env: Record<string, string | undefined>): Promise<PreflightCheck> {
	const resolved = resolveBwrap(env);
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
				remediation: `the bwrap binary at ${resolved} does not run; reinstall bubblewrap`,
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

async function checkBwrapUserns(env: Record<string, string | undefined>): Promise<PreflightCheck> {
	const resolved = resolveBwrap(env);
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
					`user namespaces appear unavailable; enable unprivileged user namespaces ` +
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
			remediation: `cannot spawn ${resolved}; fix its permissions/loader or reinstall bubblewrap`,
		};
	}
}

/** Profile tools must be absolute and existing (a missing tool ro-binds
 *  nothing and breaks the sandbox at launch). */
function checkProfileTools(profile: BwrapProfile): PreflightCheck {
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
 * Denied-bind sanity: a profile that requests a bind inside a
 * forbidden root (operator home/ssh state, container sockets, fleet/provider
 * state) fails HERE with an actionable message.
 */
function checkDeniedBinds(
	profile: BwrapProfile,
	opts: BwrapPreflightOptions,
	env: Record<string, string | undefined>,
): PreflightCheck {
	const roots = defaultDenyRoots(env);
	try {
		// The workspace root is the sanctioned volume root for clone dirs; it
		// must never alias credentials/sockets/provider state.
		assertWorkspaceVolume(resolve(opts.workspaceRoot), roots);
	} catch (err) {
		if (err instanceof DeniedBindError) {
			return {
				name: "denied-binds",
				ok: false,
				detail: `the workspace root ${opts.workspaceRoot} is inside a forbidden root (${err.root}, ${err.kind})`,
				remediation:
					`move the fleet workspace root outside ${err.root}; operator home/ssh state, ` +
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
					`remove "${tool}" from providerProfiles."${profile.id}".tools; operator home/ssh ` +
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
 * Run the bwrap-owned battery for a profile. Never throws for a check
 * outcome: failures are rows; only an internal bug throws.
 */
export async function preflightBwrapProfile(
	profile: BwrapProfile,
	opts: BwrapPreflightOptions,
): Promise<PreflightCheck[]> {
	const env = opts.env ?? process.env;
	return [
		await checkBwrapBinary(env),
		await checkBwrapUserns(env),
		checkRuntimeEntry(env),
		checkRuntimeBin(env),
		checkProfileTools(profile),
		checkDeniedBinds(profile, opts, env),
	];
}
