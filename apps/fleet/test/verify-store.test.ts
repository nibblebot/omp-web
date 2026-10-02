/**
 * Verify-at-deletion gate regressions (clone-plan P6.6/P7.7 deterministic
 * failure coverage): the real FleetLogStore writer plus the real
 * verifyWorkspaceLogs gate, never mocks echoing inputs. Every unsafe store
 * shape must REFUSE deletion authorization and leave the stored bytes
 * retained; a complete main+subagent lineage must authorize with byte
 * identity in the returned manifest (sha256/size over the exact streamed
 * bytes).
 *
 * Assertions are observable contract only (authorized/refused + retention +
 * byte identity); error wording is never pinned, only the frozen ledger code
 * the gate maps each hazard onto.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FleetLogStore, type LogChunk } from "../log-store";
import { cleanupTempDirs, tempDir } from "../../../lib/testkit/temp-dir.testkit";
import { verifyWorkspaceLogs, type VerifyResult } from "../verify-store";

afterAll(cleanupTempDirs);

const WORKSPACE_ID = "ws-verify-1";
const SESSION_ID = "w1";
const MAIN_RELPATH = "w1.jsonl";
const SUBAGENT_RELPATH = "w1/sub1.jsonl";

const TITLE_SLOT =
	'{"type":"title","v":1,"title":"Lineage demo","updatedAt":"2026-09-06T00:00:00.000Z","pad":"pad"}\n';
const MESSAGE_LINE =
	'{"type":"message","id":"m1","role":"user","content":[{"type":"text","text":"hello"}]}\n';

/** Structurally complete main JSONL: title slot, header, one entry. */
const MAIN_CONTENT =
	TITLE_SLOT + '{"type":"session","id":"main-session-uuid","cwd":"/srv/proj"}\n' + MESSAGE_LINE;

/** Structurally complete subagent JSONL (own header id, one entry). */
const SUBAGENT_CONTENT =
	TITLE_SLOT + '{"type":"session","id":"subagent-session-uuid","cwd":"/srv/proj"}\n' + MESSAGE_LINE;

/** One-chunk stream of `content` at generation 1, stream closed (eof). */
function fullChunk(content: string): LogChunk {
	const bytes = Buffer.from(content, "utf8");
	return { offset: 0, generation: 1, data: bytes.toString("base64"), eof: true };
}

/** Fresh tracked logs root with a live (constructor-mode) store instance. */
function freshStore(): { rootDir: string; store: FleetLogStore } {
	const rootDir = tempDir("verify-store-");
	return { rootDir, store: new FleetLogStore({ rootDir }) };
}

/** One session dir path `logs/<workspaceId>/<sessionId>`. */
function sessionDir(rootDir: string): string {
	return join(rootDir, WORKSPACE_ID, SESSION_ID);
}

/** Complete main+subagent lineage written through the real store. */
function writeCompleteLineage(store: FleetLogStore): { mainBytes: Buffer; subBytes: Buffer } {
	const mainBytes = Buffer.from(MAIN_CONTENT, "utf8");
	const subBytes = Buffer.from(SUBAGENT_CONTENT, "utf8");
	store.ingest(WORKSPACE_ID, SESSION_ID, MAIN_RELPATH, fullChunk(MAIN_CONTENT));
	store.ingest(WORKSPACE_ID, SESSION_ID, SUBAGENT_RELPATH, fullChunk(SUBAGENT_CONTENT));
	return { mainBytes, subBytes };
}

/**
 * Asserts the gate refused the store and returns the typed failure so the
 * caller can pin the frozen ledger code. Refusal always retains the logs.
 */
function expectRefused(result: VerifyResult): Extract<VerifyResult, { ok: false }> {
	if (result.ok) {
		throw new Error("deletion verification unexpectedly authorized an unsafe store");
	}
	expect(["unavailable", "conflict"]).toContain(result.code);
	return result;
}

describe("verifyWorkspaceLogs deletion gate", () => {
	test("authorizes a complete main+subagent lineage with byte identity", async () => {
		const { rootDir, store } = freshStore();
		const { mainBytes, subBytes } = writeCompleteLineage(store);
		const dir = sessionDir(rootDir);
		expect(existsSync(join(dir, MAIN_RELPATH))).toBe(true);
		expect(existsSync(join(dir, SUBAGENT_RELPATH))).toBe(true);

		const result = await verifyWorkspaceLogs({
			logsRoot: rootDir,
			workspaceId: WORKSPACE_ID,
			registry: { projectId: "proj-1", workspaceName: "Demo workspace", resolvedCommit: "abc123" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.sessions).toEqual([
			{ sessionId: SESSION_ID, files: 2, bytes: mainBytes.length + subBytes.length },
		]);
		expect(result.manifest).toBeDefined();
		expect(result.exportId).toBeDefined();

		// Byte identity: manifest sha256/size must cover the exact streamed
		// bytes; a main file has no parentPath, the subagent names its main.
		const mainHash = createHash("sha256").update(mainBytes).digest("hex");
		const subHash = createHash("sha256").update(subBytes).digest("hex");
		const files = result.manifest?.files ?? [];
		const mainManifest = files.find((file) => file.path === MAIN_RELPATH);
		expect(mainManifest).toEqual({
			path: MAIN_RELPATH,
			size: mainBytes.length,
			sha256: mainHash,
			kind: "main",
			sessionId: SESSION_ID,
		});
		expect(files.find((file) => file.path === SUBAGENT_RELPATH)).toEqual({
			path: SUBAGENT_RELPATH,
			size: subBytes.length,
			sha256: subHash,
			kind: "subagent",
			sessionId: SESSION_ID,
			parentPath: MAIN_RELPATH,
		});
	});

	test("refuses an incomplete declared stream with a torn partial tail", async () => {
		const { rootDir, store } = freshStore();
		const partial = MAIN_CONTENT.slice(0, MAIN_CONTENT.length - 2);
		store.ingest(WORKSPACE_ID, SESSION_ID, MAIN_RELPATH, fullChunk(partial));
		const mainAbs = join(sessionDir(rootDir), MAIN_RELPATH);
		expect(existsSync(mainAbs)).toBe(true);

		const refused = expectRefused(
			await verifyWorkspaceLogs({ logsRoot: rootDir, workspaceId: WORKSPACE_ID }),
		);
		expect(refused.code).toBe("unavailable");
		expect(existsSync(mainAbs)).toBe(true);
	});

	test("refuses a declared stream truncated below its acked offset", async () => {
		const { rootDir, store } = freshStore();
		writeCompleteLineage(store);
		const mainAbs = join(sessionDir(rootDir), MAIN_RELPATH);
		truncateSync(mainAbs, Math.floor(MAIN_CONTENT.length / 2));

		const refused = expectRefused(
			await verifyWorkspaceLogs({ logsRoot: rootDir, workspaceId: WORKSPACE_ID }),
		);
		expect(refused.code).toBe("conflict");
		expect(existsSync(mainAbs)).toBe(true);
	});

	test("refuses a declared stream corrupted in place at identical length", async () => {
		const { rootDir, store } = freshStore();
		writeCompleteLineage(store);
		const mainAbs = join(sessionDir(rootDir), MAIN_RELPATH);
		// Bit-rot style corruption: same length and line boundaries, but the
		// session header's type is no longer "session".
		const corrupted = MAIN_CONTENT.replace('"session"', '"sessioX"');
		expect(corrupted.length).toBe(MAIN_CONTENT.length);
		writeFileSync(mainAbs, corrupted);

		const refused = expectRefused(
			await verifyWorkspaceLogs({ logsRoot: rootDir, workspaceId: WORKSPACE_ID }),
		);
		expect(refused.code).toBe("unavailable");
		expect(existsSync(mainAbs)).toBe(true);
	});

	test("refuses a symlink under the lineage tree pointing outside the session dir", async () => {
		const { rootDir, store } = freshStore();
		writeCompleteLineage(store);
		const mainAbs = join(sessionDir(rootDir), MAIN_RELPATH);
		const outside = join(rootDir, "payload-outside-session.bin");
		writeFileSync(outside, "payload outside the session tree\n");
		rmSync(mainAbs);
		symlinkSync(outside, mainAbs);

		const refused = expectRefused(
			await verifyWorkspaceLogs({ logsRoot: rootDir, workspaceId: WORKSPACE_ID }),
		);
		expect(refused.code).toBe("conflict");
		expect(existsSync(mainAbs)).toBe(true);
	});

	test("refuses an on-disk file the index does not declare", async () => {
		const { rootDir, store } = freshStore();
		writeCompleteLineage(store);
		const stray = join(sessionDir(rootDir), "stray.bin");
		writeFileSync(stray, "bytes never indexed\n");

		const refused = expectRefused(
			await verifyWorkspaceLogs({ logsRoot: rootDir, workspaceId: WORKSPACE_ID }),
		);
		expect(refused.code).toBe("conflict");
		expect(existsSync(stray)).toBe(true);
	});

	test("refuses an index-declared stream whose file is missing on disk", async () => {
		const { rootDir, store } = freshStore();
		const { subBytes } = writeCompleteLineage(store);
		const mainAbs = join(sessionDir(rootDir), MAIN_RELPATH);
		const subAbs = join(sessionDir(rootDir), SUBAGENT_RELPATH);
		unlinkSync(mainAbs);

		const refused = expectRefused(
			await verifyWorkspaceLogs({ logsRoot: rootDir, workspaceId: WORKSPACE_ID }),
		);
		expect(refused.code).toBe("conflict");
		// Retention: the declared-and-verified sibling remains byte-identical.
		expect(readFileSync(subAbs).equals(subBytes)).toBe(true);
	});
});
