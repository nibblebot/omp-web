import { dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Cross-process pidfile locks.
//
// Ownership is the tuple {pid, procStartTime, token}, where procStartTime is
// /proc/<pid>/stat field 22 (clock ticks since boot) and token is 16 random
// bytes held only by the creating process. A pid alone is not identity: pids
// are reused, and a process that crashed holding the lock must not be confused
// with a live holder that reused its pid. Only provable staleness breaks a
// lock: a pid the kernel reports gone (kill ESRCH), or a readable start time
// that differs from the recorded one (pid reuse). An unreadable start time
// (masked procfs, a peer in another PID namespace) proves nothing, and neither
// do a recorded start time /proc cannot produce, or unreadable or garbage
// contents: those are all BUSY and never broken, because a file we cannot
// attribute might belong to a live holder mid-write. The acquiring process
// refuses to record ownership at all when its own start time cannot be read,
// so the old `?? 0` fallback is never written again.
//
// Every pidfile mutation is serialized by an exclusive advisory lock on a
// stable sibling `<lockPath>.guard` inode (libc flock(2) through Bun FFI; Bun
// has no fs-level advisory-lock API). The guard is created once and NEVER
// unlinked: removing it would let the next opener lock a fresh inode while a
// peer still holds the old one, putting two processes back in the pidfile at
// once. The kernel drops the lock when its holder dies, so a crash mid-
// transaction cannot strand it the way a lock *file* sentinel would.
//
// An acquisition prewrites a complete, fsynced owner record to a unique
// sibling `<lockPath>.new.<token>` file. Then, under the guard, it reads the
// pidfile and either installs that fully written record with link(2) (which
// fails atomically with EEXIST where rename(2) would clobber a record that
// appeared meanwhile) or reports the live owner. No code path ever writes the
// pidfile in place, so a crash can never leave a partial record that parses as
// unreadable ownership and stays BUSY forever; a breaker that dies after
// removing a stale record simply leaves no pidfile, which the next acquire
// installs over.
//
// release() re-reads the pidfile under the guard and unlinks ONLY when the
// parsed token is its own, so an owner that lost the lock to a stale-breaker
// can never delete the replacement owner's file.
//
// A peer running a pre-guard build does not take this guard. It still refuses
// a live pidfile (the record parses and is busy), but two such peers can race
// a stale takeover exactly as before; restart old processes instead of running
// both builds against one state directory.
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

/** flock(2) LOCK_EX, and the EINTR errno a blocking call may return. */
const LOCK_EX = 2;
const EINTR = 4;

const FLOCK_DEF = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const ERRNO_DEF = { args: [], returns: FFIType.ptr } as const;

type Flock = (fd: number, operation: number) => number;

interface Libc {
	readonly flock: Flock;
	readonly errno: () => number;
}

let libc: Libc | null = null;

/**
 * Read libc's thread-local errno through its accessor. The FFI return type is
 * `Pointer | bigint | null`, but libc guarantees a non-NULL pointer: a NULL
 * here means libc broke that contract, so fail loudly rather than synthesize
 * an errno that could mask a real flock failure.
 */
function readErrno(pointer: Pointer | bigint | null): number {
	if (pointer === null) throw new Error("libc errno accessor returned a null pointer");
	return new Int32Array(toArrayBuffer(pointer, 0, 4))[0];
}

/**
 * Resolve libc's flock(2) and errno accessor. Loaded lazily so an unsupported
 * platform fails loudly at the first lock operation instead of silently
 * mutating the pidfile unserialized.
 */
function loadLibc(): Libc {
	if (libc !== null) return libc;
	if (process.platform === "darwin") {
		const { symbols } = dlopen("libSystem.B.dylib", { flock: FLOCK_DEF, __error: ERRNO_DEF });
		libc = {
			flock: symbols.flock,
			errno: () => readErrno(symbols.__error()),
		};
		return libc;
	}
	if (process.platform === "linux") {
		let last: unknown = null;
		// glibc ships libc.so.6; musl keeps the bare soname.
		for (const name of ["libc.so.6", "libc.so"]) {
			try {
				const { symbols } = dlopen(name, { flock: FLOCK_DEF, __errno_location: ERRNO_DEF });
				libc = {
					flock: symbols.flock,
					errno: () => readErrno(symbols.__errno_location()),
				};
				return libc;
			} catch (err) {
				last = err;
			}
		}
		throw new Error(
			`file locks need flock(2) from libc: ${last instanceof Error ? last.message : String(last)}`,
		);
	}
	throw new Error(`file locks need flock(2); unsupported platform ${process.platform}`);
}

/** Exclusive blocking flock, retried through signal interruption only. */
function flockExclusive(fd: number, guardPath: string): void {
	const { flock, errno } = loadLibc();
	for (;;) {
		if (flock(fd, LOCK_EX) === 0) return;
		const code = errno();
		if (code !== EINTR) throw new Error(`flock(${guardPath}, LOCK_EX) failed: errno ${code}`);
	}
}

/**
 * Run `body` while holding the exclusive guard for `lockPath`. The guard is a
 * stable sibling inode, so this serializes every pidfile mutation on this path
 * across processes; close(2) releases the advisory lock and the kernel does it
 * for a dead holder, so the guard is never left locked.
 */
function withGuard<T>(lockPath: string, body: () => T): T {
	const guardPath = `${lockPath}.guard`;
	let fd: number;
	try {
		fd = openSync(guardPath, "a", LOCK_FILE_MODE);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// Delete can remove the provider stateDir — guard and pidfile together —
		// while the lock is still held. With the directory gone no pidfile can
		// exist, so the release body has nothing to unlink; run it unguarded
		// rather than throwing. Any other open failure is real.
		if ((code === "ENOENT" || code === "ENOTDIR") && !existsSync(path.dirname(lockPath))) {
			return body();
		}
		throw err;
	}
	try {
		flockExclusive(fd, guardPath);
		return body();
	} finally {
		closeSync(fd);
	}
}

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
 * Parse an owner record. Returns null when the bytes are not a complete
 * identity tuple; callers treat that as BUSY, never as a stale leftover.
 */
function parseLockOwner(raw: string): LockFileContents | null {
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

/** What the lock file at a path currently says. */
type LockRead =
	| { readonly kind: "missing" }
	| { readonly kind: "unreadable" }
	| { readonly kind: "owner"; readonly owner: LockFileContents };

function readLock(lockPath: string): LockRead {
	let raw: string;
	try {
		raw = readFileSync(lockPath, "utf8");
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "missing" }
			: { kind: "unreadable" };
	}
	const owner = parseLockOwner(raw);
	return owner === null ? { kind: "unreadable" } : { kind: "owner", owner };
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

/** Write a complete owner record to a private candidate path (never the lock). */
function writeCandidate(candidate: string, payload: string): void {
	const fd = openSync(candidate, "wx", LOCK_FILE_MODE);
	try {
		// writeFileSync(2) writes the whole buffer before returning (no short
		// write can publish a partial pidfile); the follow-up fsync puts the
		// bytes on disk before the record can become visible at lockPath, so a
		// crash cannot leave a truncated record that parses as BUSY forever.
		writeFileSync(fd, payload);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Install the prewritten record at `lockPath` without clobbering: link(2)
 * fails atomically with EEXIST where rename(2) would silently overwrite a
 * record that appeared meanwhile. Returns false when the path is occupied.
 */
function installLock(candidate: string, lockPath: string): boolean {
	try {
		linkSync(candidate, lockPath);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

/**
 * Try to take the lock at `lockPath`, throwing {@link LockHeldError} when a
 * live holder owns it. A provably stale holder is replaced under the guard;
 * ownership that cannot be proven stale is reported as busy and never broken.
 * The acquiring process itself must be able to read its own start time:
 * writing the old `?? 0` fallback would record an identity that no reader can
 * ever verify, so that failure is loud instead.
 */
export function acquireFileLock(lockPath: string, holder: string): FileLock {
	const ownStartTime = procStartTime(process.pid);
	if (ownStartTime === null || ownStartTime < 1) {
		throw new Error(
			`cannot acquire ${lockPath}: /proc/${process.pid}/stat yields no start time to record`,
		);
	}
	mkdirSync(path.dirname(lockPath), { recursive: true });
	// Advisory peek: a lock that is already live (or unattributable) costs one
	// read and no candidate write, since callers poll it while a peer runs a
	// long operation. The guard re-reads and decides for real below.
	const peek = readLock(lockPath);
	if (peek.kind === "unreadable") {
		// Unattributable ownership: busy, never breakable.
		throw new LockHeldError(lockPath, UNKNOWN_PID, "unknown");
	}
	if (peek.kind === "owner" && holderIsLive(peek.owner)) {
		throw new LockHeldError(lockPath, peek.owner.pid, peek.owner.name);
	}
	const token = randomBytes(LOCK_TOKEN_BYTES).toString("hex");
	const contents: LockFileContents = {
		pid: process.pid,
		procStartTime: ownStartTime,
		name: holder,
		token,
	};
	const candidate = `${lockPath}.new.${token}`;
	try {
		writeCandidate(candidate, `${JSON.stringify(contents)}\n`);
		return withGuard(lockPath, () => {
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
				const read = readLock(lockPath);
				if (read.kind === "unreadable") {
					// Unattributable ownership: busy, never breakable.
					throw new LockHeldError(lockPath, UNKNOWN_PID, "unknown");
				}
				if (read.kind === "owner") {
					if (holderIsLive(read.owner)) {
						throw new LockHeldError(lockPath, read.owner.pid, read.owner.name);
					}
					// Provably stale, and the guard excludes every peer mutation:
					// removing it and installing ours is one transaction.
					try {
						unlinkSync(lockPath);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
					}
				}
				if (installLock(candidate, lockPath)) {
					return {
						path: lockPath,
						release(): void {
							withGuard(lockPath, () => {
								const current = readLock(lockPath);
								if (current.kind !== "owner" || current.owner.token !== token) {
									return; // Gone or replaced: never the replacement's file.
								}
								try {
									unlinkSync(lockPath);
								} catch {
									// Already gone; release is idempotent.
								}
							});
						},
					};
				}
			}
			// A non-cooperating writer kept recreating the path under our guard.
			throw new LockHeldError(lockPath, UNKNOWN_PID, "unknown");
		});
	} finally {
		try {
			unlinkSync(candidate);
		} catch {
			// Installed (link left the record at lockPath) or never created.
		}
	}
}
