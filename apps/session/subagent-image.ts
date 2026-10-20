import { open } from "node:fs/promises";
import { BLOB_HASH_RE, type BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SUBAGENT_IMAGE_MAX_ANSWER_BYTES, type SubagentImageResult } from "#lib/wire/protocol";

// ---------------------------------------------------------------------------
// A subagent transcript is read raw from its JSONL, so its images are still
// `blob:sha256:<hash>` references into the session blob store. The browser
// resolves them lazily, one hash at a time. The blob store is shared by every
// session, so a hash is served only when the asking subagent's own transcript
// references it: the transcript is the capability, the hash alone is not.
// ---------------------------------------------------------------------------

const BLOB_REF_PREFIX = "blob:sha256:";
const SCAN_CHUNK_BYTES = 1024 * 1024;
/** JSON wrapper around the base64 payload: `{"status":"ok","data":"...","mimeType":"image/webp"}` plus call_result framing. */
const ANSWER_OVERHEAD_BYTES = 1024;

/** True when `needle` occurs in the file; reads in bounded chunks that overlap by the needle length. */
async function fileContains(path: string, needle: Buffer): Promise<boolean> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(SCAN_CHUNK_BYTES + needle.length - 1);
		let carried = 0;
		for (let position = 0; ;) {
			const { bytesRead } = await handle.read(buffer, carried, SCAN_CHUNK_BYTES, position);
			if (bytesRead === 0) return false;
			const filled = carried + bytesRead;
			if (buffer.subarray(0, filled).includes(needle)) return true;
			carried = Math.min(needle.length - 1, filled);
			buffer.copy(buffer, 0, filled - carried, filled);
			position += bytesRead;
		}
	} finally {
		await handle.close();
	}
}

/** MIME type from the image's magic bytes; the transcript block's own `mimeType` stays authoritative client-side. */
function sniffMimeType(bytes: Buffer): string {
	if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (bytes.length >= 6 && bytes.toString("latin1", 0, 4) === "GIF8") return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes.toString("latin1", 0, 4) === "RIFF" &&
		bytes.toString("latin1", 8, 12) === "WEBP"
	) {
		return "image/webp";
	}
	return "application/octet-stream";
}

/**
 * One transcript image by hash. Throws for a malformed hash or one the transcript does not reference;
 * `missing` when the store lacks the blob; `too_large` when the base64 answer would not fit a callback envelope.
 */
export async function readSubagentImage(
	sessionFile: string,
	hash: unknown,
	blobs: BlobStore,
): Promise<SubagentImageResult> {
	if (typeof hash !== "string" || !BLOB_HASH_RE.test(hash)) {
		throw new Error("Image hash must be a 64-character lowercase sha256 hex digest");
	}
	if (!(await fileContains(sessionFile, Buffer.from(`${BLOB_REF_PREFIX}${hash}`)))) {
		throw new Error("Image is not referenced by this subagent transcript");
	}
	const size = blobs.sizeSync(hash);
	if (size === null) return { status: "missing" };
	if (Math.ceil(size / 3) * 4 + ANSWER_OVERHEAD_BYTES > SUBAGENT_IMAGE_MAX_ANSWER_BYTES) {
		return { status: "too_large", bytes: size };
	}
	const bytes = await blobs.get(hash);
	if (bytes === null) return { status: "missing" };
	return { status: "ok", data: bytes.toString("base64"), mimeType: sniffMimeType(bytes) };
}
