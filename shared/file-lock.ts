import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// File locks via O_EXCL pidfiles.
//
// WHY O_EXCL and not flock: Bun has no flock (no fs.flock, no FileHandle.lock),
// so a portable in-process advisory lock is impossible. Instead we create the
// lock file with O_CREAT|O_EXCL ("wx"): the atomic create wins the lock, and
// the holder's pid inside the file lets waiters detect crash leftovers.
//
// Accepted tiny race: when the holder is dead, two waiters can both observe
// the stale file, both unlink it, and both create their own lock — the loser
// of the create sees EEXIST again and re-checks liveness. Both get a lock in
// the end, but the file may flip between them; callers must tolerate that the
// lock is only advisory against live holders, which is all this guarantees.
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
	/** Unlink the lock file (idempotent; ignores unlink errors). */
	release(): void;
}

const MAX_ATTEMPTS = 3;

interface LockFileContents {
	pid: number;
	name: string;
	startedAt: number;
}

/**
 * Try to take the lock at `lockPath`, throwing {@link LockHeldError} when a
 * live holder owns it. Stale files (unreadable, garbage, or a pid that is no
 * longer running) are broken and retried, up to MAX_ATTEMPTS.
 */
export function acquireFileLock(lockPath: string, holder: string): FileLock {
	mkdirSync(path.dirname(lockPath), { recursive: true });
	const contents: LockFileContents = { pid: process.pid, name: holder, startedAt: Date.now() };
	const payload = `${JSON.stringify(contents)}\n`;
	let lastHeld: LockHeldError | null = null;

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			// Someone holds (or left) the lock: stale if we cannot read a live
			// pid out of it, dead if the pid no longer exists, alive otherwise.
			let holderPid = -1;
			let holderName = "unknown";
			try {
				const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockFileContents>;
				if (typeof parsed.pid === "number") holderPid = parsed.pid;
				if (typeof parsed.name === "string") holderName = parsed.name;
			} catch {
				// Unreadable/garbage contents: crash leftovers, treat as stale.
			}
			if (holderPid >= 0) {
				let alive = true;
				try {
					process.kill(holderPid, 0);
				} catch (killErr) {
					const killCode = (killErr as NodeJS.ErrnoException).code;
					if (killCode === "ESRCH") {
						alive = false; // No such process: the holder is dead.
					} else if (killCode === "EPERM") {
						alive = true; // Exists but not ours — still a live holder.
					} else {
						throw killErr;
					}
				}
				if (alive) throw new LockHeldError(lockPath, holderPid, holderName);
				lastHeld = new LockHeldError(lockPath, holderPid, holderName);
			}
			// Stale: break it and retry the atomic create.
			try {
				unlinkSync(lockPath);
			} catch {
				// Someone else already unlinked it; retry regardless.
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
				try {
					unlinkSync(lockPath);
				} catch {
					// Already gone (or replaced by a stale-break): fine.
				}
			},
		};
	}
	// Every attempt raced a live-looking holder: report the last one seen.
	throw lastHeld ?? new LockHeldError(lockPath, -1, "unknown");
}
