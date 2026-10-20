import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { deriveDenyRoots, type DenyRoots } from "#lib/runtime/bwrap-args";

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
	// The bundle is either the sibling of a provider bundle's directory
	// (dist-bundle/providers/x.js -> ../cli.js) or the running fleet bundle itself
	// (the in-process host kind runs inside cli.js, so its own directory holds it).
	for (const bundleEntry of [
		normalize(join(moduleDir, "..", "cli.js")),
		normalize(join(moduleDir, "cli.js")),
	]) {
		if (existsSync(bundleEntry)) {
			return {
				entry: bundleEntry,
				bin: env.OMP_RUNTIME_BIN ?? process.execPath,
				args: ["session"],
			};
		}
	}
	// Keep the source candidate visible so preflight reports a missing entry actionably.
	return {
		entry: devCandidates[0],
		bin: env.OMP_RUNTIME_BIN ?? process.execPath,
		args: [],
	};
}

/**
 * The launch of a clone session runtime (bwrap sandbox or host runtime).
 * Clone daemons dial OUT over the callback channel; nobody dials in. The
 * daemon still binds its HTTP listener at boot, and where the runtime shares
 * the host network namespace (a host-network bwrap profile, the host kind)
 * the default port 4721 collides with any other local daemon: an instant,
 * silent death ("Failed to start server. Is port 4721 in use?"). Always bind
 * an ephemeral port unless the operator pinned one (env flag mapping is 1:1).
 */
export function cloneRuntimeLaunch(
	env: Record<string, string | undefined> = process.env,
): RuntimeLaunch {
	const launch = defaultRuntimeLaunch(env);
	if (env.OMP_SESSION_PORT === undefined && !launch.args.includes("--port")) {
		return { ...launch, args: [...launch.args, "--port", "0"] };
	}
	return launch;
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

/**
 * The command that copies a clone runtime's output into its capped daemon log
 * (log-relay.ts, reached as the CLI's internal `log-relay` subcommand). It must
 * outlive the fleet with the runtime, so it is its own process: the source tree
 * runs the CLI entry, the installed bundle runs itself. Append the log path.
 */
export function logRelayLaunch(
	env: Record<string, string | undefined> = process.env,
	moduleDir: string = import.meta.dir,
): { bin: string; args: readonly string[] } {
	const bin = env.OMP_RUNTIME_BIN ?? process.execPath;
	for (const entry of [
		normalize(join(moduleDir, "..", "cli", "omp-web.ts")),
		normalize(join(moduleDir, "cli.js")),
		normalize(join(moduleDir, "..", "cli.js")),
	]) {
		if (existsSync(entry)) return { bin, args: [entry, "log-relay"] };
	}
	// Keep the source entry visible so a failure names a real path.
	return { bin, args: [normalize(join(moduleDir, "..", "cli", "omp-web.ts")), "log-relay"] };
}
