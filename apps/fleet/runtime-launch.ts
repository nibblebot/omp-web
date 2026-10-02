import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { deriveDenyRoots, type DenyRoots } from "../../lib/runtime/bwrap-args";

export interface RuntimeLaunch {
	/** Absolute runtime entry the sandbox runs. */
	entry: string;
	/** Runtime binary (bun). */
	bin: string;
	/** Extra fixed argv for the entry (e.g. ["session"] for the bundle). */
	args: readonly string[];
}

/**
 * Resolve the app-owned session launch from operator overrides or the physical
 * app directory. Source fleet code launches apps/session/index.ts; independently
 * bundled providers launch the sibling cli.js with its session subcommand.
 * Development source wins when a provider bundle runs inside the checkout.
 */
export function defaultRuntimeLaunch(
	env: Record<string, string | undefined> = process.env,
	moduleDir: string = import.meta.dir,
): RuntimeLaunch {
	const entryOverride = env.OMP_RUNTIME_ENTRY;
	if (entryOverride !== undefined && entryOverride !== "") {
		return {
			entry: entryOverride,
			bin: env.OMP_RUNTIME_BIN ?? process.execPath,
			args: [],
		};
	}
	const devCandidates = [
		normalize(join(moduleDir, "..", "session", "index.ts")),
		normalize(join(moduleDir, "..", "..", "apps", "session", "index.ts")),
	];
	for (const devEntry of devCandidates) {
		if (existsSync(devEntry)) {
			return {
				entry: devEntry,
				bin: env.OMP_RUNTIME_BIN ?? process.execPath,
				args: [],
			};
		}
	}
	const bundleEntry = normalize(join(moduleDir, "..", "cli.js"));
	if (existsSync(bundleEntry)) {
		return {
			entry: bundleEntry,
			bin: env.OMP_RUNTIME_BIN ?? process.execPath,
			args: ["session"],
		};
	}
	// Keep the source candidate visible so preflight reports a missing entry actionably.
	return {
		entry: devCandidates[0],
		bin: env.OMP_RUNTIME_BIN ?? process.execPath,
		args: [],
	};
}

/**
 * Keep application administration-root discovery out of sandbox policy. The
 * source fleet directory and installed provider directory are denied at their
 * respective physical locations, independent of the reusable library's path.
 */
export function defaultDenyRoots(
	env: Record<string, string | undefined> = process.env,
	moduleDir: string = import.meta.dir,
): DenyRoots {
	return deriveDenyRoots(env, moduleDir);
}
