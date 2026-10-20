/**
 * Retention for fleet daemon logs, shared by the host runtime and the
 * bwrap provider. A log is `<name>.log` plus one rotated generation
 * `<name>.log.1`. Rotation renames an over-cap file to `.1`, replacing the
 * previous generation, so the disk footprint stays near two caps. Removal
 * deletes both files.
 */
import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Cap per log generation (bytes). */
export const SESSION_LOG_MAX_BYTES = 1024 * 1024;
/** File name of a provider-managed clone daemon's combined stdout and stderr. */
export const PROVIDER_DAEMON_LOG = "daemon.log";

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
 * Append-only writer for one daemon log. Rotates at the cap mid-run, so a
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
