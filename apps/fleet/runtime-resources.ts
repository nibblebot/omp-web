/**
 * Durable fleet-owned BLOB + design for session volumes, and the workspace
 * session-tree walker the lifecycle gate uses. Contract-locked to
 * shared/archive-manifest.ts manifest rules and clone-plan P4.6/P7.2
 * bounds (10k files / 16 GiB, symlink/type rejection).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { MAX_EXPORT_BYTES, MAX_EXPORT_FILES } from "../../lib/session-files/export-sessions";
import { isNormalizedPosixRelativePath } from "../../lib/session-files/archive-manifest";

/** Workspace sessions live at <volumeRoot>/.home/agent/sessions (frozen layout). */
export function workspaceSessionsDir(volumeRoot: string): string {
	return join(volumeRoot, ".home", "agent", "sessions");
}

/** Symlink/type/path guard: one session dir's regular files, bounded. */
export interface SessionFile {
	/** Session id (safe component). */
	sessionId: string;
	/** Manifest-normalized POSIX relpath inside the session dir. */
	relpath: string;
	size: number;
}

export interface SessionTreeResult {
	files: SessionFile[];
	/** True when the walk hit a hard bound (10k files or 16 GiB). */
	overBound: boolean;
}

/**
 * Walk one workspace volume's session tree (sessions dir enumeration) with
 * the export-gate safety rules: symlinks and non-regular files are rejected,
 * relpaths must be normalized POSIX and manifest-safe, and the walk is
 * bounded. Missing/unreadable roots yield an empty tree (the caller decides
 * what that means for completeness).
 */
export function walkWorkspaceSessionTree(sessionsDir: string): SessionTreeResult {
	const state = { files: 0, bytes: 0 };
	const files: SessionFile[] = [];
	let overBound = false;

	const walk = (dir: string, sessionId: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dent of entries) {
			if (dent.isSymbolicLink() || !dent.isFile()) continue; // Reject.
			const absolute = join(dir, dent.name);
			const relpath = absolute
				.slice(sessionsDir.length)
				.replace(/^[/\\]+/, "")
				.split("\\")
				.join("/");
			if (relpath.length === 0 || !isNormalizedPosixRelativePath(relpath)) continue;
			let size = 0;
			try {
				size = statSync(absolute).size;
			} catch {
				continue;
			}
			state.files += 1;
			state.bytes += size;
			if (state.files > MAX_EXPORT_FILES || state.bytes > MAX_EXPORT_BYTES) {
				overBound = true;
				return;
			}
			files.push({ sessionId, relpath, size });
		}
	};

	let rootEntries;
	try {
		rootEntries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return { files: [], overBound: false };
	}
	for (const dent of rootEntries) {
		if (!dent.isDirectory()) continue; // Only session dirs; files are ignored.
		const sessionId = dent.name;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) continue;
		walk(join(sessionsDir, sessionId), sessionId);
		if (overBound) break;
	}
	return { files, overBound };
}
