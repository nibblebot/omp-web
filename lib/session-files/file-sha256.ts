import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";

/** Read chunk size shared by the streaming file-hash helpers. */
const HASH_BUFFER_BYTES = 256 * 1024;

/** Streaming sync sha256 hex over a file (bounded memory). Throws on fs failure. */
export function sha256FileSync(absolutePath: string): string {
	const hash = createHash("sha256");
	const fd = openSync(absolutePath, "r");
	const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
	try {
		let offset = 0;
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, offset);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
			offset += read;
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** Streaming async sha256 hex over a file (bounded memory). Rejects on fs failure. */
export async function sha256OfFile(absolutePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(absolutePath, { highWaterMark: HASH_BUFFER_BYTES })) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}
