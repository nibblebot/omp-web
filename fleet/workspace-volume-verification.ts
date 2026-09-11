/**
 * Pure volume/store completeness cross-check for the clone delete gate
 * (clone-plan P7.5). The gate verifies the fleet log store first; this module
 * then proves the workspace VOLUME's own session tree is byte-identical to the
 * verified store, so an empty store can never trivially pass when sessions
 * existed on the volume. It is deliberately free of registry/server state —
 * the gate computes `everStarted` and the volume root.
 *
 * The enumeration is NOT re-implemented here: runtime/export-sessions.ts'
 * canonical planner (`planSessionExport`) is the SAME authority the daemon's
 * quiesce path uses, so the volume side and the streamed store side see the
 * same file set. That planner owns main-file discovery (depth-1
 * `<sessionId>.jsonl`, depth-2 `<proj>/<sessionId>.jsonl`), artifact-subtree
 * walking, symlink/non-regular/escape rejection, the 10k-file / 16 GiB bounds,
 * and the exclusion of unrelated content (a main's `.lock`, tmp/bak files,
 * project dirs with no declared main) — so neither side can drift from the
 * other by hand-rolling a walker.
 *
 * A volume the fleet cannot read (kubernetes PVCs) has no tree to compare, so
 * a VALIDATED quiesce `receipt` is the completeness authority there, including
 * its valid empty-manifest case. A sessions tree that EXISTS but cannot be
 * enumerated is never "empty": it fails closed.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ArchiveManifest } from "../shared/archive-manifest";
import { planSessionExport } from "../runtime/export-sessions";
import type { CloneDeletionReceipt } from "./registry";

/** Result of the volume ↔ store completeness cross-check. */
export type VolumeVerificationResult = { ok: true } | { ok: false; message: string };

/** One volume file the completeness cross-check compares against the store. */
interface VolumeFile {
	/** Lineage key (main-file stem) owning the file. */
	sessionId: string;
	/** POSIX relpath inside the sessions dir — the store's stream relpath. */
	relpath: string;
	size: number;
}

/** Enumerate the volume's declared session files through the canonical planner. */
function enumerateVolumeFiles(sessionsDir: string): VolumeFile[] {
	return planSessionExport(sessionsDir).files.map((file) => ({
		sessionId: file.sessionId,
		relpath: file.relToSessions,
		size: statSync(join(sessionsDir, file.relToSessions)).size,
	}));
}

/** sha256 hex of a file read via a bounded chunk stream. */
async function sha256File(absolute: string): Promise<string> {
	const hash = createHash("sha256");
	const reader = Bun.file(absolute).stream().getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		hash.update(value);
	}
	return hash.digest("hex");
}

/**
 * Independent completeness check: the workspace volume's own session tree
 * (`.home/agent/sessions`) must be byte-identical to the verified store. This
 * is what makes an empty store FAIL deletion when sessions actually existed on
 * the volume. The gate calls this AFTER store verification and BEFORE the
 * read-only flip; a mismatch blocks and retains everything.
 *
 * `everStarted` distinguishes "the volume is unreadable AND the workspace ran,
 * so completeness is unprovable" from a never-started workspace with no
 * volume tree at all.
 */
export async function verifyVolumeAgainstStore(opts: {
	daemonId: string;
	/** Volume root; may not exist (a kubernetes PVC is not fleet-readable). */
	volumeRoot: string;
	storeManifest: ArchiveManifest | undefined;
	receipt: CloneDeletionReceipt | undefined;
	everStarted: boolean;
}): Promise<VolumeVerificationResult> {
	const { daemonId, volumeRoot, storeManifest, receipt, everStarted } = opts;
	const sessionsDir = join(volumeRoot, ".home", "agent", "sessions");

	// The volume is fleet-readable when its root exists.
	const volumePresent = existsSync(volumeRoot);
	let files: VolumeFile[] = [];
	if (volumePresent && existsSync(sessionsDir)) {
		try {
			files = enumerateVolumeFiles(sessionsDir);
		} catch (error) {
			// A tree the canonical planner refuses — unreadable, symlinked,
			// escaping, over the traversal bounds, or holding a file with no
			// owning lineage — proves nothing about completeness. It is never
			// treated as an empty tree.
			return {
				ok: false,
				message: `cannot verify the session tree for ${daemonId}: ${error instanceof Error ? error.message : String(error)}; deletion blocked`,
			};
		}
	}

	if (!volumePresent) {
		// A kubernetes volume is not fleet-readable, so there is no
		// volume-side tree to compare: the validated quiesce receipt is
		// the completeness authority there, INCLUDING its valid empty
		// case (a clone that started but never produced a session
		// legitimately has no volume tree and no store sessions).
		if (receipt?.state === "verified" && receipt.validated !== undefined) {
			return { ok: true };
		}
		if (everStarted && storeManifest === undefined) {
			// Store verified (storeManifest is present only on ok:true
			// with provenance) — if the store really has zero sessions
			// AND we cannot read the volume, completeness is unprovable.
			return {
				ok: false,
				message: `cannot verify store completeness for ${daemonId}: volume is not fleet-readable and the store has no sessions to compare`,
			};
		}
		return { ok: true }; // k8s volume with verified stored sessions, or never started.
	}
	if (files.length === 0) {
		return { ok: true }; // Nothing on the volume to compare; store empty is provably complete.
	}
	if (storeManifest === undefined) {
		return {
			ok: false,
			message: `workspace ${daemonId} has ${files.length} session file(s) on its volume but the store verification produced no manifest`,
		};
	}
	// Index the store manifest by (sessionId, stream relpath): the store holds
	// each verified file at `logs/<workspaceId>/<sessionId>/<relpath>`, and
	// `<relpath>` is verbatim the sessions-dir-relative path the daemon
	// streamed — the same space the volume planner reports.
	const stored = new Map<string, { size: number; sha256: string }>();
	for (const file of storeManifest.files) {
		stored.set(`${file.sessionId}/${file.path}`, { size: file.size, sha256: file.sha256 });
	}
	// Every volume file must exist byte-identically in the store.
	for (const file of files) {
		const key = `${file.sessionId}/${file.relpath}`;
		const side = stored.get(key);
		if (side === undefined) {
			return {
				ok: false,
				message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} (${file.size} bytes) is missing from the fleet store; deletion blocked (logs were not fully streamed)`,
			};
		}
		if (side.size !== file.size) {
			return {
				ok: false,
				message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} is truncated in the fleet store (${side.size}/${file.size} bytes); deletion blocked`,
			};
		}
		const absolute = join(sessionsDir, file.relpath);
		const sha = await sha256File(absolute);
		if (sha !== side.sha256) {
			return {
				ok: false,
				message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} differs from its stored bytes; deletion blocked (rewrite not re-streamed)`,
			};
		}
	}
	return { ok: true };
}
