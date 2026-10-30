/**
 * Destructive and renaming resume-picker operations. Every target goes through
 * the shared journal jail (`validateSessionJournal`), must appear in the session
 * listing, and must not be the attached session (the attached session is managed
 * through its own writer). Writers are fenced by the per-session lease.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	assertAbsent,
	type LifecycleMirror,
	syncDirectory,
	validateSessionJournal,
} from "./lifecycle-adapter";
import type { SessionEntry } from "./session-entry";

export class ResumeInputError extends Error {
	readonly code = "invalid_request" as const;
}

export interface ResumeManageDeps {
	sessionsRoot: string;
	/** The attached session, if any. It is never touched on disk by these operations. */
	attached?: SessionEntry;
	/** Fleet mirror; only consulted for delete. */
	mirror?: LifecycleMirror;
	/** Drops the id from the durable resume-list pins (no-op when unpinned). */
	unpin(sessionId: string): Promise<void>;
}

export interface ResumeRenameInput {
	sessionFile: string;
	title: string;
}

export interface ResumeDeleteInput {
	sessionFile: string;
	sessionId: string;
}

/** Trimmed, single-line, 1..200 characters, else `invalid_request`. */
export function normalizeResumeTitle(raw: string): string {
	const title = raw.trim();
	if (title.length === 0 || title.length > 200 || /\p{Cc}/u.test(title)) {
		throw new ResumeInputError("Session title must be a single line of 1 to 200 characters");
	}
	return title;
}

async function assertListed(sessionsRoot: string, canonicalFile: string): Promise<void> {
	// The listing is `<root>/<project>/<name>.jsonl` with no hidden entries. The jail already
	// proved containment, so checking that layout is enough and avoids scanning every session.
	const rel = path.relative(await realpath(sessionsRoot), canonicalFile);
	if (!/^[^./\\][^/\\]*[/\\][^./\\][^/\\]*\.jsonl$/.test(rel))
		throw new Error("Session file is not in the session listing");
}

export async function renameResumeSession(
	input: ResumeRenameInput,
	deps: ResumeManageDeps,
): Promise<{ renamed: true; sessionId: string; title: string }> {
	const title = normalizeResumeTitle(input.title);
	const target = await validateSessionJournal(deps.sessionsRoot, input.sessionFile);
	if (deps.attached?.session.sessionId === target.sessionId) {
		await deps.attached?.session.setSessionName(title, "user");
		return { renamed: true, sessionId: target.sessionId, title };
	}
	await assertListed(deps.sessionsRoot, target.sessionFile);
	// The SDK holds the session lease from before the load until the write, so a concurrent
	// appender cannot leave the title entry parented to a stale leaf. Null means no rename
	// happened: leased by another process, or the journal could not take the name.
	const stored = await SessionManager.renameSessionTitle(target.sessionFile, title);
	if (stored === null) throw new Error("Session is owned by another writer");
	return { renamed: true, sessionId: target.sessionId, title: stored };
}

export async function deleteResumeSession(
	input: ResumeDeleteInput,
	deps: ResumeManageDeps,
): Promise<{ deleted: true; sessionId: string }> {
	const target = await validateSessionJournal(
		deps.sessionsRoot,
		input.sessionFile,
		input.sessionId,
	);
	if (deps.attached?.session.sessionId === target.sessionId) {
		throw new Error("Use /delete to delete the attached session");
	}
	await assertListed(deps.sessionsRoot, target.sessionFile);
	await deps.mirror?.assertWritable(target.sessionId);
	const lease = tryAcquireSessionLease(target.sessionId);
	if (!lease) throw new Error("Session is owned by another writer");
	let localDeleted = false;
	try {
		// Re-check under the lease: the file may have changed since the first validation.
		await validateSessionJournal(deps.sessionsRoot, target.sessionFile, target.sessionId);
		await new FileSessionStorage().deleteSessionWithArtifacts(target.sessionFile);
		await assertAbsent(target.sessionFile);
		await assertAbsent(target.sessionFile.slice(0, -".jsonl".length));
		await syncDirectory(path.dirname(target.sessionFile));
		localDeleted = true;
		await deps.unpin(target.sessionId);
		await deps.mirror?.purge(target.sessionId);
	} catch (cause) {
		if (localDeleted) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`Session was deleted locally, but fleet cleanup failed: ${detail}`, {
				cause,
			});
		}
		throw cause;
	} finally {
		lease.release();
	}
	return { deleted: true, sessionId: target.sessionId };
}
