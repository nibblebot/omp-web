/**
 * Preflight rows about the clone session runtime itself, shared by the
 * providers that launch it on the fleet host: the runtime entry (the
 * omp-session entry the clone runs) and the runtime binary (bun) must resolve.
 * bwrap runs them inside its sandbox (apps/fleet/bwrap-preflight.ts); the
 * `host` kind runs them as the fleet user, and its in-process provider owns
 * the rest of its rows here (`preflightHostProfile`).
 *
 * Every failing check carries an actionable remediation. No check installs
 * anything or writes to disk.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PreflightCheck } from "#lib/runtime/provider-protocol";
import { defaultRuntimeLaunch } from "./runtime-launch";

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

export function checkRuntimeEntry(env: Record<string, string | undefined>): PreflightCheck {
	const launch = defaultRuntimeLaunch(env);
	const entry = resolve(launch.entry);
	if (!existsSync(entry)) {
		return {
			name: "runtime-entry",
			ok: false,
			detail: `runtime entry not found: ${entry}`,
			remediation:
				`the clone runs the repo's apps/session/index.ts (dev) or the installed cli.js ` +
				`(bundle). Set OMP_RUNTIME_ENTRY to the built session runtime entry, or ` +
				`rebuild/install omp-web`,
		};
	}
	const detail = launch.args.length > 0 ? `${entry} (bundle session mode)` : entry;
	return { name: "runtime-entry", ok: true, detail };
}

export function checkRuntimeBin(env: Record<string, string | undefined>): PreflightCheck {
	const wanted = defaultRuntimeLaunch(env).bin;
	const shown = env.OMP_RUNTIME_BIN ?? `bun (${wanted})`;
	const bin = resolveToolPath(wanted);
	if (bin === null) {
		return {
			name: "runtime-bin",
			ok: false,
			detail: `runtime binary not found: ${shown}`,
			remediation: `install bun (the clone's omp-session runs under bun) or set OMP_RUNTIME_BIN`,
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
 * The rows the in-process host runtime owns. There is no provider executable
 * to ask, so the fleet produces them itself. The last row is always present
 * and always passes: it states, in every report, that the profile runs without
 * a sandbox, so the absence of sandbox rows is never silent.
 */
export function preflightHostProfile(
	env: Record<string, string | undefined> = process.env,
): PreflightCheck[] {
	return [
		checkRuntimeEntry(env),
		checkRuntimeBin(env),
		{
			name: "host-isolation",
			ok: true,
			detail:
				"no sandbox: the session runs on the fleet host as the fleet user, with that user's filesystem, network and credentials",
		},
	];
}
