/**
 * In-pod workspace preparation (P5.3/P5.4): run by runtime/image/
 * entrypoint.sh on every pod start, before the session daemon. Reuses the
 * fleet's own prepareWorkspace so clone semantics are identical across
 * providers.
 *
 * A volume with no verified marker (empty, or left pinned by an interrupted
 * first preparation) is initialized through prepareWorkspace. A volume that
 * is already initialized only has its marker read and validated: workspace,
 * source, pin, and branch must match the pod env exactly, and the checkout is
 * never touched, so later commits and working files survive a pod
 * replacement. A corrupt or mismatched marker fails here, before the daemon.
 *
 * Env contract (set by the pod spec; see kubernetes-provider.ts):
 *   OMP_WORKSPACE_ID, OMP_PREP_SOURCE_REMOTE, OMP_PREP_REVISION,
 *   OMP_PREP_BRANCH (all required).
 *
 * Fails with the frozen vocabulary to stderr + exit code; the provider
 * surfaces pod termination reasons actionably on ensure-running.
 */
import {
	PrepareWorkspaceError,
	prepareWorkspace,
	readWorkspaceInitMarker,
} from "../prepare-workspace";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error(`${name} is required for in-pod workspace preparation`);
	}
	return value;
}

async function main(): Promise<void> {
	const workspaceId = requiredEnv("OMP_WORKSPACE_ID");
	const remote = requiredEnv("OMP_PREP_SOURCE_REMOTE");
	const revision = requiredEnv("OMP_PREP_REVISION");
	const branch = requiredEnv("OMP_PREP_BRANCH");
	const root = process.env.OMP_WORKSPACE_ROOT ?? "/workspace";

	try {
		const existing = await readWorkspaceInitMarker(root);
		if (existing !== null) {
			// Already initialized. The marker is the volume's identity: compare
			// every field with the pod env and stop there. prepareWorkspace is
			// deliberately NOT called, because its validity check is HEAD ==
			// pin and re-preparing would reset the checkout over later commits
			// and working files.
			if (existing.workspaceId !== workspaceId) {
				throw new PrepareWorkspaceError(
					"conflict",
					`volume is initialized for workspace ${existing.workspaceId}, refusing workspace ${workspaceId}`,
				);
			}
			if (existing.source.remote !== remote) {
				throw new PrepareWorkspaceError(
					"conflict",
					`volume is initialized from remote ${existing.source.remote}, refusing ${remote}`,
				);
			}
			if (existing.resolvedCommit !== revision.toLowerCase()) {
				throw new PrepareWorkspaceError(
					"conflict",
					`volume is initialized at pinned commit ${existing.resolvedCommit}, refusing revision ${revision}`,
				);
			}
			if (existing.branch !== branch) {
				throw new PrepareWorkspaceError(
					"conflict",
					`volume is initialized on branch "${existing.branch}", refusing branch "${branch}"`,
				);
			}
			process.stdout.write(
				`prepare: workspace ${workspaceId} already initialized at ${existing.resolvedCommit}; keeping the existing checkout\n`,
			);
			return;
		}

		const result = await prepareWorkspace({
			workspaceId,
			workspaceRoot: root,
			source: { remote },
			revision,
			branch,
		});
		process.stdout.write(
			`prepare: workspace ${workspaceId} initialized at ${result.marker.resolvedCommit}\n`,
		);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		process.stderr.write(`prepare: workspace initialization failed: ${message}\n`);
		process.exit(1);
	}
}

await main();
