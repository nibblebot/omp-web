/**
 * In-pod workspace preparation (P5.3/P5.4): called by apps/session/
 * entrypoint.sh only when the per-workspace PVC lacks the verified init
 * marker (i.e. a NEW workspace volume). Reuses the fleet's own
 * prepareWorkspace so clone semantics are identical across providers.
 *
 * Env contract (set by the pod spec; see kubernetes-provider.ts):
 *   OMP_WORKSPACE_ID, OMP_PREP_SOURCE_REMOTE (required),
 *   OMP_PREP_REVISION (pinned full commit; optional, resolves HEAD once),
 *   OMP_PREP_BRANCH (optional, defaults to deriveWorkspaceBranch).
 *
 * Fails with the frozen vocabulary to stderr + exit code; the provider
 * surfaces pod termination reasons actionably on ensure-running.
 */
import { prepareWorkspace } from "../../lib/runtime/prepare-workspace";

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
	const revision = process.env.OMP_PREP_REVISION;
	const branch = process.env.OMP_PREP_BRANCH;
	const root = process.env.OMP_WORKSPACE_ROOT ?? "/workspace";

	try {
		const result = await prepareWorkspace({
			workspaceId,
			workspaceRoot: root,
			source: { remote },
			...(revision !== undefined && revision !== "" ? { revision } : {}),
			...(branch !== undefined && branch !== "" ? { branch } : {}),
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
