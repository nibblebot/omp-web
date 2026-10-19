/**
 * Foreign-upload staging (resume-import-adapter): staged uploads are capped at
 * two entries and 128 MiB, expire after 10 minutes unless confirmed or
 * cancelled, and are removed by discardAllStagedUploads() at daemon shutdown.
 * Staging dirs land under os.tmpdir(), which each test points at a private dir.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	createResumeImportHandlers,
	discardAllStagedUploads,
	type ResumeImportHandlers,
} from "../resume-import-adapter";

const STAGE_PREFIX = "omp-foreign-import-";
const MINUTE = 60 * 1000;
const MAX_UPLOAD_BASE64_LENGTH = Math.ceil((64 * 1024 * 1024) / 3) * 4;

const savedTmpdir = process.env.TMPDIR;
const savedClaudeConfig = process.env.CLAUDE_CONFIG_DIR;

let tmp: string;
let clock: number;
let h: ResumeImportHandlers;

beforeEach(() => {
	tmp = tempDir("omp-foreign-stage-");
	process.env.TMPDIR = tmp;
	process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-config");
	clock = Date.parse("2026-10-18T10:00:00.000Z");
	h = createResumeImportHandlers({
		cwd: tmp,
		sessionDir: join(tmp, "sessions"),
		now: () => clock,
	});
});

afterEach(() => {
	discardAllStagedUploads();
});

afterAll(() => {
	if (savedTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmpdir;
	if (savedClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfig;
	cleanupTempDirs();
});

function call(name: string, arg: Record<string, unknown>): Promise<unknown> {
	const handler = h[name];
	if (handler === undefined) throw new Error(`no handler ${name}`);
	return handler([arg]);
}

/** One valid Claude transcript record, base64-encoded for the wire. */
function claudeTranscript(): string {
	const record = {
		type: "user",
		uuid: crypto.randomUUID(),
		sessionId: crypto.randomUUID(),
		timestamp: "2026-10-18T10:00:00.000Z",
		cwd: tmp,
		message: { role: "user", content: "hello from an upload" },
	};
	return Buffer.from(`${JSON.stringify(record)}\n`).toString("base64");
}

async function stage(bytesBase64: string = claudeTranscript()): Promise<string> {
	const out = (await call("foreignUploadStage", {
		source: "claude",
		filename: "chat.jsonl",
		bytesBase64,
	})) as { stagedId: string };
	return out.stagedId;
}

describe("foreign upload staging", () => {
	test("cancel removes the staging dir and forgets the upload", async () => {
		const id = await stage();
		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(1);

		await call("foreignUploadCancel", { stagedId: id });

		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(0);
		await expect(call("foreignPreview", { source: "claude", id })).rejects.toThrow(
			"foreign session not found",
		);
	});

	test("import of a staged upload persists the session and clears the staging dir", async () => {
		const id = await stage();

		const imported = (await call("foreignImport", { source: "claude", id })) as {
			sessionFile: string;
		};

		expect(existsSync(imported.sessionFile)).toBe(true);
		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(0);
	});

	test("a third staged upload is refused and creates no extra staging dir", async () => {
		const first = await stage();
		await stage();

		await expect(stage()).rejects.toThrow("too many staged uploads");
		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(2);

		await call("foreignUploadCancel", { stagedId: first });
		await expect(stage()).resolves.toEqual(expect.any(String));
		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(2);
	});

	test("an upload past the 10-minute TTL is swept and frees its slot", async () => {
		const expired = await stage();
		clock += 5 * MINUTE;
		const kept = await stage();
		clock += 5 * MINUTE + 1;

		// Both slots were taken; this stage only succeeds if the expired one is swept.
		await stage();

		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(2);
		await expect(call("foreignPreview", { source: "claude", id: expired })).rejects.toThrow(
			"foreign session not found",
		);
		await expect(call("foreignPreview", { source: "claude", id: kept })).resolves.toMatchObject({
			staged: true,
		});
	});

	test("an upload younger than the TTL is kept", async () => {
		const id = await stage();
		clock += 9 * MINUTE;

		await expect(call("foreignPreview", { source: "claude", id })).resolves.toMatchObject({
			staged: true,
		});
		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(1);
	});

	test("discardAllStagedUploads removes every staging dir and forgets the uploads", async () => {
		const a = await stage();
		const b = await stage();
		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(2);

		discardAllStagedUploads();

		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(0);
		await expect(call("foreignImport", { source: "claude", id: a })).rejects.toThrow(
			"foreign session not found",
		);
		await expect(call("foreignImport", { source: "claude", id: b })).rejects.toThrow(
			"foreign session not found",
		);
	});

	test("an upload over the 64 MiB cap is refused before any staging dir is created", async () => {
		const oversize = "A".repeat(MAX_UPLOAD_BASE64_LENGTH + 1);

		await expect(stage(oversize)).rejects.toThrow("import cap");
		expect(readdirSync(tmp).filter((name) => name.startsWith(STAGE_PREFIX))).toHaveLength(0);
	});
});
