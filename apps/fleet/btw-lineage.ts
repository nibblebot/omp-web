// G09 fleet BTW lineage discovery helper: classify BTW sidecars in lineage
// BEFORE mirroring.
//
// The SDK stores durable BTW history outside the main session journal, under
// `<artifacts>/btw-history[/sessions/<scope>]/entry-<id>.json`
// (session/btw-history.ts: scope = session id because workers share the
// artifact root). In lineage-relpath terms that surfaces as
// `<main-stem>/btw-history/...` (or `<proj>/<main-stem>/btw-history/...`),
// i.e. an artifact-subtree file owned by a main session.
//
// This module reuses the shared classification rules instead of inventing a
// second convention:
//   - `classifyLineageEntry` / `isMainRelpath` / `owningMainRel`
//     (#lib/session-files/export-sessions.ts) for export-plan inputs;
//   - `classifyStoredRelpath` (fleet/log-store.ts) for stored-session inputs.
// Both rules land BTW sidecars on `metadata` (they are `.json`, never the
// main `.jsonl`, never `__advisor*`, never subagent `.jsonl`): mirrored as
// opaque sidecars, never as transcript lineage.
//
// Policy (mirrors the contract):
//   - Ordinary export/share omits BTW sidecars (members list is the omit set).
//   - G17 manifests declare inclusion explicitly; inclusion mirrors bytes only.
//   - Restore is NOT supported yet: `restorable` is always false until a
//     verified materialization path for btw-history/ exists. Callers must
//     treat members as opaque bytes (or omit them), never as restorable
//     transcript state.
//
// No edits to edge.ts / server.ts / log-store.ts / stored-sessions.ts were
// needed: this is a NEW helper those files (or G17) can import. See the patch
// intent in the worker output.

import {
	classifyLineageEntry,
	isMainRelpath,
	owningMainRel,
	type SessionExportPlan,
	type SessionLineageEntry,
} from "#lib/session-files/export-sessions";
import { classifyStoredRelpath, type StoredSessionInfo } from "./log-store";

/** Lineage path segment owning every BTW sidecar (SDK historyDirectory). */
export const BTW_HISTORY_SEGMENT = "btw-history";

/** Filename rule for one history checkpoint (SDK recordFileName). */
const BTW_ENTRY_FILENAME_RE = /^entry-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/;

/** True when `relpath` passes through a `btw-history/` directory segment. */
export function isBtwSidecar(relpath: string): boolean {
	return relpath.split("/").includes(BTW_HISTORY_SEGMENT);
}

/** True when the sidecar is a well-formed history checkpoint filename. */
export function isWellFormedBtwSidecar(relpath: string): boolean {
	if (!isBtwSidecar(relpath)) return false;
	const segments = relpath.split("/");
	if (
		relpath.includes("\\") ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		return false;
	}
	const name = relpath.split("/").at(-1) ?? "";
	return BTW_ENTRY_FILENAME_RE.test(name);
}

export interface BtwLineageClassification {
	/**
	 * True when every BTW member mirrors safely as an opaque sidecar (or when
	 * there are no BTW members at all). False names the offending member in
	 * `reason`; the caller must omit (never mirror) that member.
	 */
	supported: boolean;
	reason?: string;
	/** BTW sidecar relpaths found in the input (the ordinary-export omit set). */
	members: string[];
	/**
	 * Explicit restore-support flag. Always false: no verified materialization
	 * path for btw-history/ exists, so members are mirrored bytes at best and
	 * restore must refuse them. Flips only when a verified restore lands.
	 */
	restorable: boolean;
}

/**
 * Classify BTW sidecars in one session's lineage BEFORE mirroring.
 *
 * Accepts either an export plan (G17 manifest input) or a stored session
 * (fleet log-store mirror input) and returns the BTW member set plus the
 * mirror/restore policy. The shared rules verify each member classifies as
 * `metadata` (opaque sidecar) under its owning main; anything else — a BTW
 * path escaping its main's stem dir, or a filename outside the checkpoint
 * shape — marks the lineage unsupported with a reason.
 */
export function classifyBtwLineage(
	plan: SessionExportPlan | StoredSessionInfo,
): BtwLineageClassification {
	const members = plan.files
		.map((file) => ("relpath" in file ? file.relpath : file.relToSessions))
		.filter(isBtwSidecar)
		.sort();
	if (isStoredSessionInfo(plan)) {
		for (const file of plan.files) {
			if (!isBtwSidecar(file.relpath)) continue;
			// Reuse the store's own rule: BTW checkpoints are `.json`, so the
			// frozen classifier must land them on `metadata` (opaque), never
			// on main/subagent/advisor transcript lineage.
			const kind = classifyStoredRelpath(plan.sessionId, file.relpath);
			if (kind !== "metadata") {
				return {
					supported: false,
					reason:
						`BTW sidecar ${file.relpath} classifies as "${kind}", ` +
						`not opaque metadata; omitting it from the mirror`,
					members,
					restorable: false,
				};
			}
			if (!isWellFormedBtwSidecar(file.relpath)) {
				return {
					supported: false,
					reason:
						`BTW sidecar ${file.relpath} is not a well-formed history checkpoint; ` +
						`omitting it from the mirror`,
					members,
					restorable: false,
				};
			}
		}
		members.sort();
		return { supported: true, members, restorable: false };
	}
	const relpaths = plan.files.map((file) => file.relToSessions);
	const mains = new Set<string>();
	for (const file of plan.files) {
		if (file.kind === "main") mains.add(file.relToSessions);
	}
	for (const relpath of relpaths) {
		if (!isBtwSidecar(relpath)) continue;
		let classified: Omit<SessionLineageEntry, "relToSessions">;
		try {
			classified = classifyLineageEntry(relpath, mains);
		} catch (error) {
			return {
				supported: false,
				reason:
					`BTW sidecar ${relpath} has no owning main ` +
					`(${error instanceof Error ? error.message : String(error)}); omitting it`,
				members,
				restorable: false,
			};
		}
		if (classified.kind !== "metadata") {
			return {
				supported: false,
				reason:
					`BTW sidecar ${relpath} classifies as "${classified.kind}", ` +
					`not opaque metadata; omitting it from the mirror`,
				members,
				restorable: false,
			};
		}
		if (!isWellFormedBtwSidecar(relpath)) {
			return {
				supported: false,
				reason:
					`BTW sidecar ${relpath} is not a well-formed history checkpoint; ` +
					`omitting it from the mirror`,
				members,
				restorable: false,
			};
		}
		// Belt-and-braces: the shared helpers must agree the member nests
		// under its owning main's stem dir.
		const parent = owningMainRel(relpath, mains);
		if (parent === undefined || parent !== classified.parentPath) {
			return {
				supported: false,
				reason: `BTW sidecar ${relpath} escapes its owning main; omitting it`,
				members,
				restorable: false,
			};
		}
	}
	members.sort();
	return { supported: true, members, restorable: false };
}

/** Narrow the plan|stored union on the stored shape (StoredFileInfo.relpath). */
function isStoredSessionInfo(
	input: SessionExportPlan | StoredSessionInfo,
): input is StoredSessionInfo {
	return "sessionId" in input;
}

/**
 * Ordinary export/share omit-set: every BTW sidecar relpath in the input.
 * G17 manifests declare inclusion explicitly instead of calling this.
 */
export function omitBtwSidecars(plan: SessionExportPlan | StoredSessionInfo): string[] {
	return classifyBtwLineage(plan).members;
}

/**
 * True when `relpath` is the main session file of lineage key `sessionId`
 * (re-export of the shared rule for G17 manifest builders that need the
 * main-first check alongside BTW discovery).
 */
export function isBtwOwningMain(relpath: string, sessionId: string): boolean {
	return isMainRelpath(relpath, sessionId);
}
