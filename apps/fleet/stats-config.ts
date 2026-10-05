/**
 * Stats config resolution (fleet/stats). Resolved once at startup.
 *
 * Precedence:
 * - config root: literal $PI_CONFIG_DIR (default ~/.omp), then the active
 *                OMP_PROFILE / PI_PROFILE's profiles/<name> directory
 * - stats DB:    config root/stats.db, or an existing XDG omp[/profiles/<name>] root
 * - sessions:    $PI_CODING_AGENT_DIR/sessions for the default profile,
 *                else the same existing XDG root/sessions, else config root/agent/sessions
 *
 * NOTE: real-world stats.db rows store ABSOLUTE session_file paths
 * (e.g. /home/u/.omp/agent/sessions/<proj>/<file>.jsonl), not the
 * relative paths the DB schema comment implies. Everything is normalized
 * through fleet/stats/paths.ts.
 *
 * The fleet control plane owns the listen port, so no port/host here.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { FleetLogStore } from "./log-store";

/** Secret-free registry projection for labeling store rows (structural). */
export interface StoredProvenanceLike {
	projectId: string;
	kind: "clone" | "worktree" | "direct";
	profileId?: string;
	branch?: string;
	pinnedRevision?: string;
	source?: { local?: string; remote?: string };
}

export interface StoredStatsSource {
	store: FleetLogStore;
	/** Live-registry lookup; undefined → the workspace is orphaned. */
	provenance?: (workspaceId: string) => StoredProvenanceLike | undefined;
}

export interface StatsConfig {
	configRoot: string;
	statsDbPath: string;
	sessionsDir: string;
	/** P8.6: fleet log store mounted into stats (absent = fleet-local only). */
	stored?: StoredStatsSource;
}

export function resolveStatsConfig(
	env: Record<string, string | undefined> = process.env,
): StatsConfig {
	const home = homedir();
	const profileName = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
	const profile = profileName && profileName !== "default" ? profileName : undefined;
	const baseRoot = env.PI_CONFIG_DIR || join(home, ".omp");
	const configRoot = profile ? join(baseRoot, "profiles", profile) : baseRoot;
	const agentDir = profile ? join(configRoot, "agent") : env.PI_CODING_AGENT_DIR;
	const xdgRoot = env.XDG_DATA_HOME
		? profile
			? join(env.XDG_DATA_HOME, "omp", "profiles", profile)
			: join(env.XDG_DATA_HOME, "omp")
		: undefined;
	// SDK DirResolver only adopts existing XDG roots and only for its default
	// agent directory. Named profiles require their own migrated root.
	const useXdg =
		(process.platform === "linux" || process.platform === "darwin") &&
		(!agentDir || agentDir === join(configRoot, "agent")) &&
		xdgRoot !== undefined &&
		existsSync(xdgRoot);
	const dataRoot = useXdg ? xdgRoot : configRoot;
	const sessionsDir = useXdg
		? join(dataRoot, "sessions")
		: join(agentDir || join(configRoot, "agent"), "sessions");

	return {
		configRoot,
		statsDbPath: join(dataRoot, "stats.db"),
		sessionsDir,
	};
}
