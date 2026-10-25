/**
 * Retention for fleet session logs, shared by the host runtime and the
 * bwrap provider. A log is `<name>.log` plus one rotated generation
 * `<name>.log.1`. Rotation renames an over-cap file to `.1`, replacing the
 * previous generation, so the disk footprint stays near two caps. Removal
 * deletes both files.
 */
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Cap per log generation (bytes). */
export const SESSION_LOG_MAX_BYTES = 1024 * 1024;
/** File name of a provider-managed clone session's combined stdout and stderr. */
export const PROVIDER_SESSION_LOG = "session.log";

/**
 * Pre-rename name of the clone log. A clone launched before the rename still has this file in
 * its stateDir (its supervisor may even still be appending to it), so readers fall back to it
 * when `session.log` is absent. Writers never use it.
 */
export const LEGACY_PROVIDER_LOG = "daemon.log";

/** Rename `path` to `path.1` when it exceeds the cap. A missing file is left alone. */
export function rotateSessionLog(path: string): void {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return;
	}
	if (size > SESSION_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
}

/** Delete a log and its rotated generation. Missing files are fine. */
export function removeSessionLog(path: string): void {
	rmSync(path, { force: true });
	rmSync(`${path}.1`, { force: true });
}

/** The last `bytes` bytes of `path` as UTF-8, or "" when the file is missing. */
export function readSessionLogTail(path: string, bytes: number): string {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return "";
	}
	const start = Math.max(0, size - bytes);
	const buffer = Buffer.alloc(size - start);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, start);
	} finally {
		closeSync(fd);
	}
	return buffer.toString("utf8");
}

/**
 * The last `bytes` bytes of a provider-managed clone's combined log in `stateDir`:
 * `session.log`, or the legacy `daemon.log` when `session.log` does not exist (a clone
 * whose stateDir predates the rename). "" when neither exists.
 */
export function readProviderLogTail(stateDir: string, bytes: number): string {
	const current = join(stateDir, PROVIDER_SESSION_LOG);
	return readSessionLogTail(
		existsSync(current) ? current : join(stateDir, LEGACY_PROVIDER_LOG),
		bytes,
	);
}

/**
 * Append-only writer for one session log. Rotates at the cap mid-run, so a
 * single long-lived child cannot grow the file without bound. One writer is
 * shared by every pump of the same child, so rotation never splits one
 * stream across two files.
 */
export class SessionLog {
	readonly #path: string;
	#fd: number;
	#size: number;
	/** Bytes this writer appended; the file's prior contents are not counted. */
	#written = 0;

	constructor(path: string) {
		this.#path = path;
		mkdirSync(dirname(path), { recursive: true });
		rotateSessionLog(path);
		this.#fd = openSync(path, "a");
		this.#size = fstatSync(this.#fd).size;
	}

	write(chunk: Uint8Array): void {
		if (this.#size > 0 && this.#size + chunk.byteLength > SESSION_LOG_MAX_BYTES) {
			closeSync(this.#fd);
			renameSync(this.#path, `${this.#path}.1`);
			this.#fd = openSync(this.#path, "a");
			this.#size = 0;
		}
		writeSync(this.#fd, chunk);
		this.#size += chunk.byteLength;
		this.#written += chunk.byteLength;
	}

	/** The last `bytes` of this run's output, trimmed; "" when this writer appended nothing. */
	tailOfRun(bytes: number): string {
		if (this.#written === 0) return "";
		return readSessionLogTail(this.#path, Math.min(bytes, this.#written)).trim();
	}

	close(): void {
		closeSync(this.#fd);
	}
}

/**
 * Copy a child's output pipe into `log` until EOF. A read error means the
 * child is gone and the exit path records why, so the pump just ends. A write
 * error (disk full) drops the chunk but keeps draining, so the child never
 * blocks on a full pipe.
 */
export async function pumpToSessionLog(
	stream: ReadableStream<Uint8Array>,
	log: SessionLog,
): Promise<void> {
	const reader = stream.getReader();
	for (;;) {
		const next = await reader.read().then(
			(result) => result,
			() => null,
		);
		if (next === null || next.done) return;
		try {
			log.write(next.value);
		} catch {
			// Dropped chunk; see above.
		}
	}
}
