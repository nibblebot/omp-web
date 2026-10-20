/**
 * 40dg: a subagent transcript is read raw, so its images are `blob:sha256:<hash>` refs. `getSubagentImage`
 * resolves one hash at a time, only for a hash that subagent's own transcript references, and answers
 * `too_large` instead of an answer the callback envelope would refuse.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { ENVELOPE_MAX_BYTES } from "#lib/wire/callback-protocol";
import { SUBAGENT_IMAGE_MAX_ANSWER_BYTES, type SubagentImageResult } from "#lib/wire/protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { createWebMethods } from "../methods";
import type { SessionEntry } from "../session-entry";
import { readSubagentImage } from "../subagent-image";
import { messageRecord, resumedEntry, writeFixtureSession } from "./subagent-fixture.testkit";

afterAll(cleanupTempDirs);

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOT_IN_STORE = "b".repeat(64);

function pngOf(size: number): Buffer {
	return Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, 7)]);
}

interface Setup {
	entry: SessionEntry;
	blobs: BlobStore;
	/** `blob:sha256:` ref and hash of each blob put in the store, in order. */
	stored: Array<{ ref: string; hash: string }>;
	read: (args: unknown) => Promise<unknown>;
}

/**
 * A resumed session whose subagent `Shooter` references `referenced` blobs and every blob in `unreferenced`
 * (kept in the shared store but absent from the transcript), plus `ghostRefs` the store never held.
 */
async function setup(options: {
	referenced: readonly Buffer[];
	unreferenced?: readonly Buffer[];
	ghostRefs?: readonly string[];
}): Promise<Setup> {
	const blobs = new BlobStore(tempDir("omp-web-image-blobs-"));
	const stored: Setup["stored"] = [];
	for (const bytes of [...options.referenced, ...(options.unreferenced ?? [])]) {
		const { ref, hash } = await blobs.put(bytes);
		stored.push({ ref, hash });
	}
	const refs = [
		...stored.slice(0, options.referenced.length).map((blob) => blob.ref),
		...(options.ghostRefs ?? []),
	];
	const { root } = writeFixtureSession(tempDir("omp-web-image-session-"), [
		{
			id: "Shooter",
			agent: "task",
			task: "screenshot",
			extra: [
				messageRecord("t1", "a1", {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "browser",
					content: refs.map((ref) => ({ type: "image", data: ref, mimeType: "image/png" })),
				}),
			],
		},
	]);
	const entry = resumedEntry(root);
	const { methods } = createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: {} as never,
		broker: {} as never,
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
		blobStore: blobs,
	});
	return { entry, blobs, stored, read: (args) => methods.getSubagentImage!(entry, [args]) };
}

describe("getSubagentImage", () => {
	test("is classified read-only so it never triggers a mutation broadcast", () => {
		const { readOnly } = createWebMethods({
			settings: {} as never,
			authStorage: {} as never,
			collab: {} as never,
			broker: {} as never,
			materializeSession: async () => ({ alreadyPresent: true as const }),
			sessionsDir: "/tmp/fleet-test-sessions",
			cwd: "/tmp/fleet-test-cwd",
			hasCallbackPair: () => false,
		});
		expect(readOnly.getSubagentImage).toBe(true);
	});

	test("resolves a referenced hash for a parked agent after a resume", async () => {
		const png = pngOf(64);
		const { stored, read } = await setup({ referenced: [png] });
		expect(await read({ subagentId: "Shooter", hash: stored[0].hash })).toEqual({
			status: "ok",
			data: png.toString("base64"),
			mimeType: "image/png",
		});
	});

	test("reports a referenced hash the blob store no longer holds as missing", async () => {
		const { read } = await setup({ referenced: [], ghostRefs: [`blob:sha256:${NOT_IN_STORE}`] });
		expect(await read({ subagentId: "Shooter", hash: NOT_IN_STORE })).toEqual({
			status: "missing",
		});
	});

	test("refuses a hash the subagent transcript does not reference, even when the store holds it", async () => {
		const { stored, read } = await setup({ referenced: [pngOf(32)], unreferenced: [pngOf(48)] });
		await expect(read({ subagentId: "Shooter", hash: stored[1].hash })).rejects.toThrow(
			"not referenced by this subagent transcript",
		);
		await expect(read({ subagentId: "Shooter", hash: NOT_IN_STORE })).rejects.toThrow(
			"not referenced",
		);
	});

	test("rejects anything that is not a lowercase sha256 hex digest", async () => {
		const { stored, read } = await setup({ referenced: [pngOf(32)] });
		const bad = [
			undefined,
			42,
			"",
			"../../etc/passwd",
			stored[0].hash.toUpperCase(),
			stored[0].hash.slice(1),
			`${stored[0].hash}/..`,
			stored[0].ref,
		];
		for (const hash of bad) {
			await expect(read({ subagentId: "Shooter", hash })).rejects.toThrow("sha256 hex digest");
		}
	});

	test("rejects an unknown subagent and a missing subagentId", async () => {
		const { stored, read } = await setup({ referenced: [pngOf(32)] });
		await expect(read({ subagentId: "Nobody", hash: stored[0].hash })).rejects.toThrow(
			"Unknown subagent",
		);
		await expect(read({ hash: stored[0].hash })).rejects.toThrow("requires subagentId");
	});

	test("answers too_large instead of an answer the callback envelope would refuse", async () => {
		// base64 grows 4/3, so the largest blob that fits is under 3/4 of the budget.
		const fits = pngOf(Math.floor((SUBAGENT_IMAGE_MAX_ANSWER_BYTES * 3) / 4) - 2048);
		const tooBig = pngOf(Math.floor((SUBAGENT_IMAGE_MAX_ANSWER_BYTES * 3) / 4) + 1024);
		const { stored, read } = await setup({ referenced: [fits, tooBig] });
		const ok = (await read({ subagentId: "Shooter", hash: stored[0].hash })) as SubagentImageResult;
		expect(ok.status).toBe("ok");
		expect(JSON.stringify(ok).length).toBeLessThan(ENVELOPE_MAX_BYTES);
		expect(await read({ subagentId: "Shooter", hash: stored[1].hash })).toEqual({
			status: "too_large",
			bytes: tooBig.length,
		});
	});
});

describe("readSubagentImage reference scan", () => {
	test("finds a ref that straddles a read-chunk boundary and none that is truncated", async () => {
		const blobs = new BlobStore(tempDir("omp-web-image-scan-blobs-"));
		const { ref, hash } = await blobs.put(pngOf(32));
		const file = join(tempDir("omp-web-image-scan-"), "agent.jsonl");
		// The first chunk ends five bytes into the ref.
		await writeFile(file, `${"x".repeat(1024 * 1024 - 5)}${ref}\n`);
		expect(await readSubagentImage(file, hash, blobs)).toMatchObject({ status: "ok" });
		await writeFile(file, `${"x".repeat(1024 * 1024 - 5)}${ref.slice(0, -1)}\n`);
		await expect(readSubagentImage(file, hash, blobs)).rejects.toThrow("not referenced");
	});
});
