/**
 * Daemon-side wake materialization regressions: fill-missing only (a newer
 * volume descendant is never rolled back), staged all-or-nothing commits
 * (assets-only or wrong-layout transfers leave nothing; a failed commit rolls
 * back its own links), symlinked path refusal, warm no-write, and the symlink
 * hardening of resolveSessionMainFile. Transfers are built from the real wire
 * records (`shared/wake-materialize`) and driven through the injectable
 * transport seam, so no callback pair or network is involved.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ManifestFileKind } from "../shared/archive-manifest";
import type {
	MaterializeCursor,
	MaterializeEndRecord,
	MaterializeRecord,
} from "../shared/wake-materialize";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import {
	MaterializeSessionError,
	materializeSessionToDir,
	resolveSessionMainFile,
	type MaterializeTransport,
} from "./session-materialize";

afterAll(cleanupTempDirs);

interface FixtureFile {
	relpath: string;
	bytes: Buffer;
	kind: ManifestFileKind;
}

/** One well-formed transfer for `files`, ending with `more`/`cursor`. */
function transferFor(
	sessionId: string,
	files: FixtureFile[],
	end: { more?: boolean; cursor?: MaterializeCursor } = {},
): MaterializeRecord[] {
	const records: MaterializeRecord[] = [{ type: "session", workspaceId: "ws", sessionId }];
	for (const file of files) {
		records.push({
			type: "file",
			relpath: file.relpath,
			size: file.bytes.length,
			sha256: createHash("sha256").update(file.bytes).digest("hex"),
			kind: file.kind,
			offset: 0,
		});
		records.push({
			type: "chunk",
			relpath: file.relpath,
			offset: 0,
			data: file.bytes.toString("base64"),
		});
	}
	const endRecord: MaterializeEndRecord =
		end.cursor === undefined
			? { type: "end", more: end.more ?? false }
			: { type: "end", more: end.more ?? false, cursor: end.cursor };
	records.push(endRecord);
	return records;
}

/** Serve each transfer exactly once, in order. */
function queueTransport(transfers: MaterializeRecord[][]): MaterializeTransport {
	let index = 0;
	return {
		async requestBulkMaterialize() {
			const records = transfers[index];
			index += 1;
			if (records === undefined) throw new Error("unexpected materialization transfer");
			return { correlationId: `corr-${index}`, records };
		},
	};
}

/** Capture the typed rejection so a failing test reports the real error. */
async function materializeError(
	sessionsDir: string,
	sessionId: string,
	transport: MaterializeTransport,
): Promise<unknown> {
	try {
		await materializeSessionToDir(sessionsDir, sessionId, transport);
	} catch (error) {
		return error;
	}
	throw new Error("expected materializeSessionToDir to reject");
}

/** Every leftover materialization temp under `root` (must stay empty). */
function tempLeftovers(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.name.startsWith(".omp-materialize-")) found.push(path);
			if (entry.isDirectory()) walk(path);
		}
	};
	walk(root);
	return found;
}

describe("materializeSessionToDir", () => {
	test("fills a missing main without touching a newer existing descendant", async () => {
		const root = tempDir("omp-materialize-");
		const sessionId = "sessMain";
		mkdirSync(join(root, sessionId), { recursive: true });
		const subPath = join(root, sessionId, "sub.jsonl");
		const newerSub = Buffer.from('{"tail":"live volume"}\n');
		writeFileSync(subPath, newerSub);

		const mainBytes = Buffer.from(`{"id":"${sessionId}"}\n`);
		const transport = queueTransport([
			transferFor(sessionId, [
				{
					relpath: `${sessionId}/sub.jsonl`,
					bytes: Buffer.from('{"tail":"stale store"}\n'),
					kind: "subagent",
				},
				{ relpath: `${sessionId}.jsonl`, bytes: mainBytes, kind: "main" },
			]),
		]);

		const result = await materializeSessionToDir(root, sessionId, transport);

		expect(result).toEqual({ files: 1, bytes: mainBytes.length });
		expect(readFileSync(subPath).equals(newerSub)).toBe(true);
		expect(readFileSync(join(root, `${sessionId}.jsonl`)).equals(mainBytes)).toBe(true);
	});

	test("refuses a relpath whose parent under the sessions root is a symlink", async () => {
		const root = tempDir("omp-materialize-");
		const outside = tempDir("omp-materialize-outside-");
		const sessionId = "sessLink";
		symlinkSync(outside, join(root, sessionId));

		const transport = queueTransport([
			transferFor(sessionId, [
				{ relpath: `${sessionId}/child.jsonl`, bytes: Buffer.from("escape\n"), kind: "subagent" },
				{ relpath: `${sessionId}.jsonl`, bytes: Buffer.from("main\n"), kind: "main" },
			]),
		]);

		const failure = await materializeError(root, sessionId, transport);

		expect(failure).toBeInstanceOf(MaterializeSessionError);
		expect(failure).toMatchObject({ code: "invalid_request" });
		expect(existsSync(join(outside, "child.jsonl"))).toBe(false);
		expect(existsSync(join(outside, `${sessionId}.jsonl`))).toBe(false);
	});

	test("an assets-only transfer commits nothing and leaves no temps", async () => {
		const root = tempDir("omp-materialize-");
		const sessionId = "sessAssets";

		const transport = queueTransport([
			transferFor(sessionId, [
				{
					relpath: `${sessionId}/asset.jsonl`,
					bytes: Buffer.from('{"asset":1}\n'),
					kind: "metadata",
				},
			]),
		]);

		const failure = await materializeError(root, sessionId, transport);

		expect(failure).toBeInstanceOf(MaterializeSessionError);
		expect(failure).toMatchObject({ code: "unavailable" });
		expect(existsSync(join(root, sessionId, "asset.jsonl"))).toBe(false);
		expect(tempLeftovers(root)).toEqual([]);
	});

	test("a target created during the transfer is preserved, not replaced", async () => {
		const root = tempDir("omp-materialize-");
		const sessionId = "sessRace";
		const assetRel = `${sessionId}/asset.jsonl`;
		const assetPath = join(root, assetRel);
		const raced = Buffer.from('{"from":"volume"}\n');
		const mainBytes = Buffer.from('{"id":"sessRace"}\n');
		let calls = 0;
		const transport: MaterializeTransport = {
			async requestBulkMaterialize() {
				calls += 1;
				if (calls === 1) {
					const asset = Buffer.from('{"from":"fleet"}\n');
					return {
						correlationId: "corr-1",
						records: transferFor(
							sessionId,
							[{ relpath: assetRel, bytes: asset, kind: "subagent" }],
							{
								more: true,
								cursor: { path: assetRel, offset: asset.length },
							},
						),
					};
				}
				mkdirSync(join(root, sessionId), { recursive: true });
				writeFileSync(assetPath, raced);
				return {
					correlationId: "corr-2",
					records: transferFor(sessionId, [
						{ relpath: `${sessionId}.jsonl`, bytes: mainBytes, kind: "main" },
					]),
				};
			},
		};

		const result = await materializeSessionToDir(root, sessionId, transport);

		expect(result).toEqual({ files: 1, bytes: mainBytes.length });
		expect(readFileSync(assetPath).equals(raced)).toBe(true);
		expect(readFileSync(join(root, `${sessionId}.jsonl`)).equals(mainBytes)).toBe(true);
	});

	test("a warm session is a no-op that writes nothing", async () => {
		const root = tempDir("omp-materialize-");
		const sessionId = "sessWarm";
		const mainPath = join(root, `${sessionId}.jsonl`);
		const mainBytes = Buffer.from(`{"id":"${sessionId}"}\n`);
		writeFileSync(mainPath, mainBytes);
		const mtimeBefore = statSync(mainPath).mtimeMs;

		const transport = queueTransport([
			transferFor(sessionId, [{ relpath: `${sessionId}.jsonl`, bytes: mainBytes, kind: "main" }]),
		]);

		const result = await materializeSessionToDir(root, sessionId, transport);

		expect(result).toEqual({ files: 0, bytes: 0 });
		expect(readFileSync(mainPath).equals(mainBytes)).toBe(true);
		expect(statSync(mainPath).mtimeMs).toBe(mtimeBefore);
		expect(tempLeftovers(root)).toEqual([]);
	});

	test("a failed commit rolls back the files it already linked", async () => {
		const root = tempDir("omp-materialize-");
		const sessionId = "sessRollback";
		const firstRel = `${sessionId}/first.jsonl`;
		const secondRel = `${sessionId}/second.jsonl`;
		const secondPath = join(root, secondRel);
		const mainBytes = Buffer.from(`{"id":"${sessionId}"}\n`);
		let calls = 0;
		const transport: MaterializeTransport = {
			async requestBulkMaterialize() {
				calls += 1;
				if (calls === 1) {
					const second = Buffer.from('{"second":2}\n');
					return {
						correlationId: "corr-1",
						records: transferFor(
							sessionId,
							[
								{ relpath: firstRel, bytes: Buffer.from('{"first":1}\n'), kind: "subagent" },
								{ relpath: secondRel, bytes: second, kind: "subagent" },
							],
							{ more: true, cursor: { path: secondRel, offset: second.length } },
						),
					};
				}
				// An unsafe non-regular entry appears at the second target.
				mkdirSync(secondPath, { recursive: true });
				return {
					correlationId: "corr-2",
					records: transferFor(sessionId, [
						{ relpath: `${sessionId}.jsonl`, bytes: mainBytes, kind: "main" },
					]),
				};
			},
		};

		const failure = await materializeError(root, sessionId, transport);

		expect(failure).toBeInstanceOf(MaterializeSessionError);
		expect(failure).toMatchObject({ code: "invalid_request" });
		expect(existsSync(join(root, firstRel))).toBe(false); // rolled back
		expect(existsSync(secondPath)).toBe(true); // the directory is preserved
		expect(tempLeftovers(root)).toEqual([]);
	});

	test("a commit with no layout main fails and rolls back every linked file", async () => {
		const root = tempDir("omp-materialize-");
		const sessionId = "sessDeep";
		const deepRel = `proj/deep/${sessionId}.jsonl`;
		const transport = queueTransport([
			transferFor(sessionId, [
				{ relpath: deepRel, bytes: Buffer.from(`{"id":"${sessionId}"}\n`), kind: "main" },
			]),
		]);

		const failure = await materializeError(root, sessionId, transport);

		expect(failure).toBeInstanceOf(MaterializeSessionError);
		expect(failure).toMatchObject({ code: "unavailable" });
		expect(existsSync(join(root, deepRel))).toBe(false);
		expect(tempLeftovers(root)).toEqual([]);
	});

	test("resolveSessionMainFile rejects symlinked mains and project dirs", () => {
		const root = tempDir("omp-materialize-");
		const outside = tempDir("omp-materialize-outside-");
		const sessionId = "sessSym";
		writeFileSync(join(outside, `${sessionId}.jsonl`), '{"x":1}\n');
		symlinkSync(join(outside, `${sessionId}.jsonl`), join(root, `${sessionId}.jsonl`));

		const other = "sessSym2";
		writeFileSync(join(outside, `${other}.jsonl`), '{"x":1}\n');
		symlinkSync(outside, join(root, "linkproj"));

		expect(resolveSessionMainFile(root, sessionId)).toBeNull();
		expect(resolveSessionMainFile(root, other)).toBeNull();
	});
});
