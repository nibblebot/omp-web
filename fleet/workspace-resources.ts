/**
 * Post-verification workspace resource deletion (P7.5 step 4), dispatched by
 * the workspace's PERSISTED provider kind after the store flipped read-only.
 * Kubernetes removes the fleet's private provider-state directory only (the
 * Pod/PVC were deleted by the provider op); bwrap and every legacy record
 * remove the guarded local volume.
 *
 * Every interpolated id is validated as a single safe path segment, and every
 * candidate must (a) sit strictly below its canonical dedicated parent and
 * (b) resolve (realpath) to exactly its own expected path — so a malformed or
 * escaping id, a symlinked candidate, or a symlinked state parent is refused,
 * never followed.
 */

import { existsSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { RESOURCE_IDENTITY_RE } from "../shared/provider-protocol";
import type { RegistryEntry } from "./registry";
import { realpathOf } from "./worktrees";

export interface WorkspaceResourceDeleter {
	/** Delete the provider volume for a verified workspace; throws to leave remainingResources recorded. */
	deleteWorkspaceResources(workspaceId: string, entry: RegistryEntry): Promise<void>;
}

/** Strict containment: equality with the parent is refused. */
function isStrictlyUnder(candidate: string, parent: string): boolean {
	return candidate.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export function createWorkspaceResourceDeleter(workspaceDir: string): WorkspaceResourceDeleter {
	return {
		async deleteWorkspaceResources(workspaceId, entry) {
			// A workspace id is interpolated into paths: only a single safe
			// segment may reach them. `..` (or an empty/slashed id) would
			// normalize the legacy state candidate onto the workspace root and
			// the local-volume candidate onto its PARENT.
			if (
				workspaceId === "" ||
				workspaceId === "." ||
				workspaceId === ".." ||
				workspaceId.includes("/") ||
				workspaceId.includes("\\")
			) {
				throw new Error(
					`refusing to delete resources for a non-segment workspace id ${JSON.stringify(workspaceId)}`,
				);
			}
			const realRoot = realpathOf(workspaceDir);
			if (entry.workspace?.providerKind === "kubernetes" || entry.workspace?.kubernetes) {
				const candidates: Array<{ path: string; parent: string }> = [];
				const identity = entry.workspace?.kubernetes?.resourceIdentity;
				if (typeof identity === "string" && identity !== "") {
					// The identity is interpolated too: only the 32-hex resource
					// shape may reach it (`..`/`.` would resolve to the shared
					// state root or the whole workspace root).
					if (!RESOURCE_IDENTITY_RE.test(identity)) {
						throw new Error(
							`refusing to delete provider state for a non-resource identity ${JSON.stringify(identity)} (workspace ${workspaceId})`,
						);
					}
					const parent = join(realRoot, ".kubernetes");
					candidates.push({ path: join(parent, identity), parent });
				}
				const legacyParent = join(realRoot, ".provider-state");
				candidates.push({ path: join(legacyParent, workspaceId), parent: legacyParent });
				for (const { path: candidate, parent } of candidates) {
					if (!existsSync(candidate)) continue;
					if (!isStrictlyUnder(candidate, parent) || realpathOf(candidate) !== candidate) {
						throw new Error(
							`refusing to delete provider state outside its managed parent: ${candidate} (workspace ${workspaceId})`,
						);
					}
					rmSync(candidate, { recursive: true, force: true });
				}
				return;
			}
			const cwd = entry.cwd ?? "";
			if (cwd === "") return; // No volume to remove (a placeholder).
			const expected = join(realRoot, workspaceId);
			if (!isStrictlyUnder(expected, realRoot) || realpathOf(cwd) !== expected) {
				throw new Error(
					`refusing to delete clone volume that is not ${workspaceId}'s own directory under workspaceDir: ${cwd}`,
				);
			}
			rmSync(expected, { recursive: true, force: true });
		},
	};
}
