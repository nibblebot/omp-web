import { randomBytes } from "node:crypto";
import {
	closeSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// File locks via O_EXCL pidfiles.
//
// WHY O_EXCL and not flock: Bun has no flock (no fs.flock, no FileHandle.lock),
// so a portable in-process advisory lock is impossible. Instead we create the
// lock file with O_CREAT|O_EXCL ("wx"): the atomic create wins the lock.
//
// Owner identity is the tuple {pid, procStartTime, token}, where
// procStartTime is /proc/<pid>/stat field 22 (clock ticks since boot) and
// token is 16 random bytes held only by the creating process. A pid alone is
// not identity: pids are reused, and a process that crashed holding the lock
// must not be confused with a live holder that reused its pid. Only provable
// staleness breaks a lock: a pid the kernel reports gone (kill ESRCH), or a
// readable start time that differs from the recorded one (pid reuse). An
// unreadable start time (masked procfs, a peer in another PID namespace)
// proves nothing, and neither do a recorded start time /proc cannot produce,
// or unreadable or garbage contents: those are all BUSY and never broken,
// because a file we cannot attribute might belong to a live holder mid-write.
// The acquiring process refuses to record ownership at all when its own start
// time cannot be read, so the old `?? 0` fallback is never written again.
//
// Stale recovery is a single atomic rename to `<lockPath>.stale.<token>`,
// then a re-read of the renamed artifact to confirm it still carries the
// stale identity that was judged, then an unlink of that artifact and a fresh
// O_EXCL create. The re-read matters: a competing recoverer can install a
// fresh live lock between our stale read and our rename, and a rename by path
// would hand that live lock to two owners. A mismatched artifact is instead
// restored (by link, which never clobbers a lock that appeared meanwhile) and
// reported as its live owner; the recoverer then creates nothing. Otherwise
// exactly one recoverer wins the rename; the loser sees ENOENT and retries
// the create, where it observes the winner's live record and reports BUSY.
// The state directory it lives in is removed only by the fleet, after the
// provider has released the lock and exited.
//
// release() re-reads the file and unlinks ONLY when the parsed token is our
// own, so an owner that lost the lock to a stale-breaker can never delete
// the replacement owner's file.
// ---------------------------------------------------------------------------

export class LockHeldError extends Error {
	readonly lockPath: string;
	readonly holderPid: number;
	readonly holderName: string;

	constructor(lockPath: string, holderPid: number, holderName: string) {
		super(`lock held by ${holderName} (pid ${holderPid}) at ${lockPath}`);
		this.name = "LockHeldError";
		this.lockPath = lockPath;
		this.holderPid = holderPid;
		this.holderName = holderName;
	}
}

export interface FileLock {
	readonly path: string;
	/** Unlink the lock file when this owner still holds it (idempotent). */
	release(): void;
}

/** On-disk owner record; every field is required. */
export interface LockFileContents {
	pid: number;
	procStartTime: number;
	name: string;
	token: string;
}

const MAX_ATTEMPTS = 3;
/** Owner-token width: 16 random bytes, lowercase hex. */
const LOCK_TOKEN_BYTES = 16;
const LOCK_FILE_MODE = 0o600;
/** Unknown owner (unreadable contents) has no pid to report. */
const UNKNOWN_PID = -1;

/**
 * Read `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot).
 * Returns null when the file is unreadable or carries no start time. Null
 * means UNKNOWN, never "gone": a masked procfs or a peer in another PID
 * namespace reads exactly like a dead pid, so liveness decides separately
 * (see {@link holderIsLive}). `comm` may contain spaces or `)`, so the tail
 * after the LAST `) ` is parsed, keeping the field indexes stable. This is a
 * deliberate local copy of the identical provider-protocol reader (see
 * shared/provider-protocol.ts): layering forbids file-lock from importing
 * the provider contract.
 */
function procStartTime(pid: number): number | null {
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const close = stat.lastIndexOf(") ");
	if (close < 0) return null;
	const tail = stat.slice(close + 2).split(" ");
	// Field 22 is starttime: 22 - 3 = 19th element of the tail (fields 3..n).
	const start = Number(tail[19]);
	return Number.isFinite(start) ? start : null;
}

/**
 * Parse the lock file's owner record. Returns null when the file is missing,
 * unreadable, or does not carry the full identity tuple. Callers treat that
 * as BUSY, never as a stale leftover.
 */
function readLockOwner(lockPath: string): LockFileContents | null {
	let raw: string;
	try {
		raw = readFileSync(lockPath, "utf8");
	} catch {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid < 1) {
		return null;
	}
	if (typeof record.procStartTime !== "number" || !Number.isFinite(record.procStartTime)) {
		return null;
	}
	if (typeof record.name !== "string") return null;
	if (typeof record.token !== "string" || record.token.length === 0) return null;
	return {
		pid: record.pid,
		procStartTime: record.procStartTime,
		name: record.name,
		token: record.token,
	};
}

/**
 * Whether `owner` may still hold the lock. Only provable staleness is dead: a
 * pid the kernel reports gone, or a readable start time that differs from the
 * recorded one (pid reuse). An unreadable start time proves nothing (masked
 * procfs, another PID namespace), and a recorded start time /proc cannot
 * produce is the legacy `?? 0` fallback or a corrupt record: neither can be
 * matched or compared, so the lock is reported busy rather than broken.
 */
function holderIsLive(owner: LockFileContents): boolean {
	const live = procStartTime(owner.pid);
	if (live === null) {
		try {
			process.kill(owner.pid, 0);
			return true; // Alive but unreadable: identity unproven, so fail closed.
		} catch (err) {
			// Only a kernel-proven ESRCH is staleness; anything else is unproven.
			return (err as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}
	if (!Number.isSafeInteger(owner.procStartTime) || owner.procStartTime < 1) return true;
	return live === owner.procStartTime;
}

/**
 * Put a renamed-away record back at `lockPath` without clobbering a lock that
 * appeared meanwhile: link(2) fails atomically with EEXIST where rename(2)
 * would silently overwrite. Best-effort; a failed restore leaves the record
 * inert at `broken`, which is still better than deleting a live owner's file.
 */
function restoreLock(broken: string, lockPath: string): void {
	try {
		linkSync(broken, lockPath);
	} catch {
		return;
	}
	try {
		unlinkSync(broken);
	} catch {
		// Best-effort: the same record stays reachable by both names.
	}
}

/** What breaking a stale lock concluded. */
type StaleBreak =
	/** The stale record was renamed aside, verified, and removed. */
	| { readonly outcome: "broken" }
	/** Another recoverer renamed the lock first: retry the create. */
	| { readonly outcome: "lost" }
	/** The renamed record was not the stale one: a live owner holds it. */
	| { readonly outcome: "foreign"; readonly owner: LockFileContents | null };

/**
 * Break a stale lock: atomically rename it aside, then VERIFY the renamed
 * artifact still carries the stale identity that was judged. Any recoverer
 * can install a fresh live lock between our stale read and this rename, and
 * renaming that live record away would leave two owners; a mismatch is
 * therefore restored and reported as the live owner, and the caller never
 * creates its own lock over it. Only a verified stale artifact is removed.
 */
function breakStaleLock(lockPath: string, observed: LockFileContents, token: string): StaleBreak {
	const broken = `${lockPath}.stale.${token}`;
	try {
		renameSync(lockPath, broken);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "lost" };
		throw err;
	}
	const renamed = readLockOwner(broken);
	if (
		renamed !== null &&
		renamed.pid === observed.pid &&
		renamed.procStartTime === observed.procStartTime &&
		renamed.token === observed.token
	) {
		try {
			unlinkSync(broken);
		} catch {
			// Best-effort: the renamed artifact is inert even if it lingers.
		}
		return { outcome: "broken" };
	}
	restoreLock(broken, lockPath);
	return { outcome: "foreign", owner: renamed };
}

/**
 * Try to take the lock at `lockPath`, throwing {@link LockHeldError} when a
 * live holder owns it. A provably stale holder is broken and retried, up to
 * MAX_ATTEMPTS; ownership that cannot be proven stale is reported as busy and
 * never broken. The acquiring process itself must be able to read its own
 * start time: writing the old `?? 0` fallback would record an identity that
 * no reader can ever verify, so that failure is loud instead.
 */
export function acquireFileLock(lockPath: string, holder: string): FileLock {
	const ownStartTime = procStartTime(process.pid);
	if (ownStartTime === null || ownStartTime < 1) {
		throw new Error(
			`cannot acquire ${lockPath}: /proc/${process.pid}/stat yields no start time to record`,
		);
	}
	mkdirSync(path.dirname(lockPath), { recursive: true });
	const token = randomBytes(LOCK_TOKEN_BYTES).toString("hex");
	const contents: LockFileContents = {
		pid: process.pid,
		procStartTime: ownStartTime,
		name: holder,
		token,
	};
	const payload = `${JSON.stringify(contents)}\n`;

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		let fd: number;
		try {
			fd = openSync(lockPath, "wx", LOCK_FILE_MODE);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const owner = readLockOwner(lockPath);
			if (owner === null) {
				// Unattributable ownership: busy, never breakable.
				throw new LockHeldError(lockPath, UNKNOWN_PID, "unknown");
			}
			if (holderIsLive(owner)) throw new LockHeldError(lockPath, owner.pid, owner.name);
			const broken = breakStaleLock(lockPath, owner, token);
			if (broken.outcome === "foreign") {
				// The artifact we renamed was not the record we judged stale:
				// a competing recoverer had already installed its live lock.
				// It was put back, and this acquire creates nothing.
				throw new LockHeldError(
					lockPath,
					broken.owner?.pid ?? UNKNOWN_PID,
					broken.owner?.name ?? "unknown",
				);
			}
			continue;
		}
		try {
			writeSync(fd, payload);
		} catch (writeErr) {
			closeSync(fd);
			try {
				unlinkSync(lockPath);
			} catch {
				// Best-effort cleanup of a partially written lock.
			}
			throw writeErr;
		}
		closeSync(fd);
		return {
			path: lockPath,
			release(): void {
				const owner = readLockOwner(lockPath);
				if (owner === null || owner.token !== token) return; // Gone or replaced: never the replacement's file.
				try {
					unlinkSync(lockPath);
				} catch {
					// Already gone; release is idempotent.
				}
			},
		};
	}
	// Every attempt spent its stale break without a verified win of the create.
	throw new LockHeldError(lockPath, UNKNOWN_PID, "unknown");
}
