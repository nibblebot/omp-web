/**
 * Required-resume bootstrap (P5 wake): the daemon-side half that runs BEFORE
 * the boot session exists. It resolves the handed --resume target inside the
 * managed sessions root, clears the selected target's stale lock, and restores
 * that target's stored transcripts over the authenticated callback pair. Every
 * remote step is bounded so a dead fleet or a stalled transfer fails the resume
 * instead of hanging the Pod before readiness.
 *
 * Containment is proven twice: lexically on the normalized paths and on the
 * real (symlink-resolved) parents. Only a target proven inside the sessions
 * root may have its stale lock removed or its stored files restored, so a
 * traversing or symlinked target can never reach an outside transcript's lock.
 */
import { realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { WAKE_MATERIALIZE_TIMEOUT_MS } from "../shared/wake-materialize";
import {
	MaterializeSessionError,
	materializeSessionToDir,
	resolveSessionMainFile,
	type MaterializeTransport,
} from "./session-materialize";

/** How long the callback pair may take to become READY before a restore. */
const PAIR_READY_TIMEOUT_MS = 60_000;

/**
 * Bound one restore step: a dead fleet or a stalled bulk transfer must fail
 * the resume instead of leaving the Pod hanging before readiness. The deadline
 * timer is always cleared, and stopping the pair rejects the awaited work, so
 * an interrupted restore leaves no deadline behind.
 */
export async function withDeadline<T>(
	work: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: Timer | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new MaterializeSessionError("unavailable", message)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		clearTimeout(timer);
	}
}

/** A resume target proven to live inside the managed sessions root. */
export interface ManagedResumeTarget {
	/** Session id parsed from the target's `<id>.jsonl` basename. */
	sessionId: string;
	/** Absolute, normalized transcript path (`<sessionsDir>[/<project>]/<id>.jsonl`). */
	mainFile: string;
	/** The stale-lock path that may be removed for a required resume. */
	lockFile: string;
}

/** Deepest existing ancestor of `target`, with every symlink resolved. */
function realExistingAncestor(target: string): string | null {
	let current = path.resolve(target);
	for (;;) {
		try {
			return realpathSync(current);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

/**
 * Resolve an absolute --resume target to a managed session target, or null
 * when it is not one. A `..` traversal is rejected by the normalized relative
 * check; a symlinked ancestor that escapes the sessions root is rejected by the
 * real-parent check. Only a non-null result may be locked, restored, or have
 * its stale lock removed.
 */
export function resolveManagedResumeTarget(
	sessionsDir: string,
	resume: string,
): ManagedResumeTarget | null {
	if (!path.isAbsolute(resume)) return null;
	const root = path.resolve(sessionsDir);
	const mainFile = path.resolve(resume);
	// Normalized relative check: rejects `..` traversal out of the root.
	const relativePath = path.relative(root, mainFile);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
	const base = path.basename(mainFile);
	if (!base.endsWith(".jsonl")) return null;
	const sessionId = base.slice(0, -".jsonl".length);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return null;
	const realRoot = realExistingAncestor(root);
	const realParent = realExistingAncestor(path.dirname(mainFile));
	if (realRoot === null || realParent === null) return null;
	// Real-parent check: a symlinked ancestor must not escape the real root.
	const parentRel = path.relative(realRoot, realParent);
	if (parentRel !== "" && (parentRel.startsWith("..") || path.isAbsolute(parentRel))) return null;
	return { sessionId, mainFile, lockFile: `${mainFile}.lock` };
}

/**
 * Remove the selected target's stale lock. The caller passes a target that
 * already passed {@link resolveManagedResumeTarget}, so the unlink can never
 * land outside the sessions root. Best-effort: an absent or already-cleared
 * lock is not an error.
 */
export function clearStaleResumeLock(target: ManagedResumeTarget): void {
	try {
		unlinkSync(target.lockFile);
	} catch {
		// Absent or already cleared.
	}
}

/** Deps for pulling one resume target's stored subtree over the pair. */
export interface RestoreResumeTargetOptions {
	sessionsDir: string;
	target: ManagedResumeTarget;
	/** The authenticated callback pair; the bulk pull is daemon-initiated. */
	transport: MaterializeTransport;
	/** Resolves when the pair is READY; rejects when the pair stops. */
	pairReady: Promise<void>;
}

/**
 * Restore the target's stored subtree and require its main transcript, both
 * bounded by deadlines. Throws a typed MaterializeSessionError when the pair
 * never comes up, the transfer fails, or the store restored no main file.
 */
export async function restoreResumeTarget(opts: RestoreResumeTargetOptions): Promise<void> {
	await withDeadline(
		opts.pairReady,
		PAIR_READY_TIMEOUT_MS,
		"the callback pair did not become ready in time to restore the resume target",
	);
	await withDeadline(
		materializeSessionToDir(opts.sessionsDir, opts.target.sessionId, opts.transport),
		WAKE_MATERIALIZE_TIMEOUT_MS,
		`restoring session ${opts.target.sessionId} exceeded ${WAKE_MATERIALIZE_TIMEOUT_MS}ms`,
	);
	if (resolveSessionMainFile(opts.sessionsDir, opts.target.sessionId) === null) {
		throw new MaterializeSessionError(
			"unavailable",
			`the store restored no main transcript for session ${opts.target.sessionId}`,
		);
	}
}
