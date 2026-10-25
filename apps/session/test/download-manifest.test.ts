/**
 * Path-jail and cap unit tests for apps/session/download-manifest.ts (G17): the
 * manifest builder's artifact inspection, `resolveDownloadPath`'s ledger-coded
 * refusals, the archive export's pre-read lstat recheck, and the
 * `download_bulk` read-time recheck + 64 MiB aggregate cap. Every refusal must
 * land as an ExportError code (or a typed DownloadBulkFailedControl) BEFORE any
 * bytes are handed to a transfer; the wire behavior is covered by the session
 * suite, these pin the jails with real filesystem fixtures.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import { ExportError } from "#lib/session-files/archive-manifest";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { BULK_MAX_BYTES, type DownloadBulkFailedControl } from "#lib/wire/callback-protocol";
import {
	btwScopeSegment,
	buildDownloadManifest,
	createDownloadMethods,
	discardAllStagedExports,
	type DownloadManifestArgs,
	type DownloadManifestDeps,
	resolveDownloadPath,
	serveDownloadBulk,
} from "../download-manifest";
import type { SessionEntry } from "../session-entry";

afterAll(cleanupTempDirs);

const NO_ARTIFACTS: DownloadManifestArgs = {
	includeAdvisor: false,
	includeBtw: false,
	includeWorkers: false,
};

/** Live inputs for the manifest builder over one real session journal. */
function liveInputs(
	sessionId: string,
	opts: { sessionsDir: string; sessionFile?: string; artifactsDir?: string },
): DownloadManifestDeps {
	return {
		sessionId,
		...(opts.sessionFile !== undefined ? { sessionFile: opts.sessionFile } : {}),
		...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
	};
}

/** The ExportError a synchronous call throws; fails the test when it returns. */
function exportError(run: () => unknown): ExportError {
	try {
		run();
	} catch (err) {
		expect(err).toBeInstanceOf(ExportError);
		return err as ExportError;
	}
	throw new Error("expected an ExportError, but the call returned");
}

/** One `download_bulk` serve leg recording what the transfer saw. */
function bulkServe(path: string, root: string, correlationId: string) {
	const failures: DownloadBulkFailedControl[] = [];
	let uploaded = 0;
	// Absent unless a test asks serveDownloadBulk to start the transfer.
	const uploadParts = async (): Promise<void> => {
		uploaded++;
	};
	return {
		failures,
		uploaded: () => uploaded,
		run: (roots: readonly string[] = [root]) =>
			serveDownloadBulk({
				correlationId,
				path,
				cwd: root,
				roots,
				uploadParts,
				failControl: (payload) => failures.push(payload),
			}),
	};
}

describe("download manifest artifact jails", () => {
	test("a lineage artifact symlinked outside the session root is refused", () => {
		const sessionsDir = tempDir("omp-download-sessions-");
		const outsideDir = tempDir("omp-download-outside-");
		const sessionId = "sess-jail";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const artifactDir = join(sessionsDir, sessionId);
		mkdirSync(artifactDir);
		const secret = join(outsideDir, "secret.jsonl");
		writeFileSync(secret, "{}\n");
		symlinkSync(secret, join(artifactDir, "__advisor.jsonl"));

		const error = exportError(() =>
			buildDownloadManifest(liveInputs(sessionId, { sessionsDir, sessionFile }), {
				...NO_ARTIFACTS,
				includeAdvisor: true,
			}),
		);
		expect(error.code).toBe("forbidden");
		expect(error.message).toContain("symlink");
	});

	test("a session journal that is a symlink is refused as non-regular", () => {
		const sessionsDir = tempDir("omp-download-journal-");
		const outsideDir = tempDir("omp-download-journal-out-");
		const outside = join(outsideDir, "real.jsonl");
		writeFileSync(outside, "{}\n");
		const linked = join(sessionsDir, "linked.jsonl");
		symlinkSync(outside, linked);

		const error = exportError(() =>
			buildDownloadManifest(
				liveInputs("sess-jail", { sessionsDir, sessionFile: linked }),
				NO_ARTIFACTS,
			),
		);
		expect(error.code).toBe("forbidden");
		expect(error.message).toContain("not a regular file");
	});

	test("a regular artifact inside the session root is inspected, not refused", () => {
		const sessionsDir = tempDir("omp-download-regular-");
		const sessionId = "sess-jail";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const artifactDir = join(sessionsDir, sessionId);
		mkdirSync(artifactDir);
		const advisor = join(artifactDir, "__advisor.jsonl");
		const advisorBytes = '{"type":"session"}\n';
		writeFileSync(advisor, advisorBytes);

		const manifest = buildDownloadManifest(liveInputs(sessionId, { sessionsDir, sessionFile }), {
			...NO_ARTIFACTS,
			includeAdvisor: true,
		});
		expect(manifest.advisorIncluded).toBe(true);
		expect(manifest.files.map((file) => file.name)).toEqual([
			`${sessionId}.jsonl`,
			"__advisor.jsonl",
		]);
		expect(manifest.files.find((file) => file.kind === "advisor")?.bytes).toBe(advisorBytes.length);
	});

	test("an artifact swapped after authorization is refused by the pre-read lstat", async () => {
		const sessionsDir = tempDir("omp-download-export-");
		const outsideDir = tempDir("omp-download-export-out-");
		const sessionId = "sess-jail";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const artifactDir = join(sessionsDir, sessionId);
		mkdirSync(artifactDir);
		const advisor = join(artifactDir, "__advisor.jsonl");
		writeFileSync(advisor, "{}\n");
		const secret = join(outsideDir, "secret.jsonl");
		writeFileSync(secret, "{}\n");

		// The SDK dump runs between manifest authorization and the artifact
		// re-read, so it is the swap point: the inspected advisor becomes a
		// symlink that resolves outside the session root.
		const dumped = join(tempDir("omp-download-dump-"), "archive.zip");
		let swapped = false;
		const entry = {
			session: {
				dumpSessionArchiveToTmpDir: async () => {
					await writeArchive(dumped, "zip", [["session.md", "dump"]]);
					unlinkSync(advisor);
					symlinkSync(secret, advisor);
					swapped = true;
					return { path: dumped, files: ["session.md"], subagentCount: 0 };
				},
			},
		} as unknown as SessionEntry;
		const methods = createDownloadMethods({
			manifestDeps: () => liveInputs(sessionId, { sessionsDir, sessionFile }),
			roots: () => [sessionsDir],
		});

		await expect(
			methods.exportDownload(entry, [
				{ kind: "archive", includeAdvisor: true, includeBtw: false, includeWorkers: false },
			]),
		).rejects.toThrow(/Artifact changed before export/);
		expect(swapped).toBe(true);
	});

	test("an HTML export is staged under tmpdir, served byte-for-byte, and refused outside the roots", async () => {
		const sessionsDir = tempDir("omp-download-html-sessions-");
		const sessionId = "sess-html";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const html = "<!DOCTYPE html><title>exact</title>\n";
		const staged: string[] = [];
		const entry = {
			session: {
				exportToHtml: async (outputPath: string) => {
					staged.push(outputPath);
					writeFileSync(outputPath, html);
					return outputPath;
				},
			},
		} as unknown as SessionEntry;
		const tmp = realpathSync(tmpdir());
		const args = { kind: "html", includeAdvisor: false, includeBtw: false, includeWorkers: false };
		const methods = createDownloadMethods({
			manifestDeps: () => liveInputs(sessionId, { sessionsDir, sessionFile }),
			roots: () => [sessionsDir, tmp],
		});

		const result = await methods.exportDownload(entry, [args]);
		expect(staged[0]?.startsWith(tmpdir() + sep)).toBe(true);
		expect(result.path.startsWith(tmp + sep)).toBe(true);
		expect(readFileSync(result.path, "utf8")).toBe(html);
		expect(result.clientFilename).toBe(`session-${sessionId}.html`);
		const served = bulkServe(result.path, sessionsDir, "corr-html");
		await served.run([sessionsDir, tmp]);
		expect(served.failures).toEqual([]);
		expect(served.uploaded()).toBe(1);
		expect(existsSync(result.path)).toBe(false);

		const refused = createDownloadMethods({
			manifestDeps: () => liveInputs(sessionId, { sessionsDir, sessionFile }),
			roots: () => [sessionsDir],
		});
		await expect(refused.exportDownload(entry, [args])).rejects.toMatchObject({
			code: "forbidden",
		});
		expect(existsSync(staged[1]!)).toBe(false);
	});

	test("a staged export whose transfer fails mid-upload is deleted and reports download_bulk_failed", async () => {
		const sessionsDir = tempDir("omp-download-abort-sessions-");
		const sessionId = "sess-abort";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const entry = {
			session: {
				formatSessionAsText: () => "transcript\n",
			},
		} as unknown as SessionEntry;
		const tmp = realpathSync(tmpdir());
		const args = { kind: "text", includeAdvisor: false, includeBtw: false, includeWorkers: false };
		const methods = createDownloadMethods({
			manifestDeps: () => liveInputs(sessionId, { sessionsDir, sessionFile }),
			roots: () => [sessionsDir, tmp],
		});
		const result = await methods.exportDownload(entry, [args]);
		const failures: DownloadBulkFailedControl[] = [];
		await serveDownloadBulk({
			correlationId: "corr-abort",
			path: result.path,
			cwd: sessionsDir,
			roots: [sessionsDir, tmp],
			// A late or dropped part: the fleet cancelled, so the upload throws.
			uploadParts: async () => {
				throw new Error("requester went away");
			},
			failControl: (payload) => failures.push(payload),
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			type: "download_bulk_failed",
			correlationId: "corr-abort",
		});
		expect(existsSync(result.path)).toBe(false);
	});

	test("an HTML export that fails after staging removes its partial file", async () => {
		const sessionsDir = tempDir("omp-download-export-fail-sessions-");
		const sessionId = "sess-export-fail";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const staged: string[] = [];
		const entry = {
			session: {
				exportToHtml: async (outputPath: string) => {
					staged.push(outputPath);
					writeFileSync(outputPath, "<!DOCTYPE html>");
					throw new Error("disk full");
				},
			},
		} as unknown as SessionEntry;
		const args = { kind: "html", includeAdvisor: false, includeBtw: false, includeWorkers: false };
		const methods = createDownloadMethods({
			manifestDeps: () => liveInputs(sessionId, { sessionsDir, sessionFile }),
			roots: () => [sessionsDir, realpathSync(tmpdir())],
		});
		await expect(methods.exportDownload(entry, [args])).rejects.toThrow("disk full");
		expect(staged).toHaveLength(1);
		expect(existsSync(staged[0]!)).toBe(false);
	});

	test("every staged export kind is deleted after its fetch, swept by the next export, and shutdown clears the rest", async () => {
		const sessionsDir = tempDir("omp-download-sweep-sessions-");
		const requestDir = tempDir("omp-download-sweep-request-");
		const sessionId = "sess-sweep";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const requestFile = join(requestDir, "llm-request.json");
		writeFileSync(requestFile, "{}");
		const entry = {
			session: {
				formatSessionAsText: () => "transcript\n",
				dumpLlmRequestToTmpDir: async () => requestFile,
			},
		} as unknown as SessionEntry;
		const methods = createDownloadMethods({
			manifestDeps: () => liveInputs(sessionId, { sessionsDir, sessionFile }),
			roots: () => [sessionsDir, realpathSync(tmpdir())],
		});
		const flags = { includeAdvisor: false, includeBtw: false, includeWorkers: false };

		const text = await methods.exportDownload(entry, [{ ...flags, kind: "text" }]);
		expect(existsSync(text.path)).toBe(true);
		// Nobody fetched the text: the request export's sweep removes it.
		const request = await methods.exportDownload(entry, [{ ...flags, kind: "request" }]);
		expect(existsSync(text.path)).toBe(false);
		expect(existsSync(request.path)).toBe(true);

		const served = bulkServe(request.path, sessionsDir, "corr-request");
		await served.run([sessionsDir, realpathSync(tmpdir())]);
		expect(served.failures).toEqual([]);
		expect(served.uploaded()).toBe(1);
		expect(existsSync(request.path)).toBe(false);

		const next = await methods.exportDownload(entry, [{ ...flags, kind: "text" }]);
		expect(existsSync(next.path)).toBe(true);
		discardAllStagedExports();
		expect(existsSync(next.path)).toBe(false);
	});

	test("a staged export refused by the roots is deleted instead of left in tmpdir", async () => {
		const sessionsDir = tempDir("omp-download-refused-sessions-");
		const requestDir = tempDir("omp-download-refused-request-");
		const sessionId = "sess-refused";
		const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		const requestFile = join(requestDir, "llm-request.json");
		writeFileSync(requestFile, "{}");
		const entry = {
			session: { dumpLlmRequestToTmpDir: async () => requestFile },
		} as unknown as SessionEntry;
		const methods = createDownloadMethods({
			manifestDeps: () => liveInputs(sessionId, { sessionsDir, sessionFile }),
			roots: () => [sessionsDir],
		});

		await expect(
			methods.exportDownload(entry, [
				{ kind: "request", includeAdvisor: false, includeBtw: false, includeWorkers: false },
			]),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(existsSync(requestFile)).toBe(false);
	});

	test("a symlinked btw scope directory is refused", () => {
		const sessionsDir = tempDir("omp-download-btw-sessions-");
		const artifactsDir = tempDir("omp-download-btw-artifacts-");
		const outsideDir = tempDir("omp-download-btw-out-");
		const sessionId = "sess-jail";
		const sessionsRoot = join(artifactsDir, "btw-history", "sessions");
		mkdirSync(sessionsRoot, { recursive: true });
		symlinkSync(outsideDir, join(sessionsRoot, btwScopeSegment(sessionId)));

		const error = exportError(() =>
			buildDownloadManifest(liveInputs(sessionId, { sessionsDir, artifactsDir }), {
				...NO_ARTIFACTS,
				includeBtw: true,
			}),
		);
		expect(error.code).toBe("forbidden");
		expect(error.message).toContain("BTW history escapes its authorized root");
	});
});

describe("resolveDownloadPath ledger refusals", () => {
	test("an empty produced path is invalid_request and a missing artifact unavailable", () => {
		const root = tempDir("omp-download-resolve-");
		const roots = [root];

		const empty = exportError(() =>
			resolveDownloadPath("archive", { sessionId: "sess-1", serverPath: "", roots }),
		);
		expect(empty.code).toBe("invalid_request");

		const missing = exportError(() =>
			resolveDownloadPath("archive", {
				sessionId: "sess-1",
				serverPath: join(root, "gone.zip"),
				roots,
			}),
		);
		expect(missing.code).toBe("unavailable");
		expect(missing.message).toContain("not found");
	});
});

describe("download_bulk read-time jails", () => {
	test("a file swapped for a symlink after authorization is refused at read time", async () => {
		const root = tempDir("omp-download-bulk-");
		const outsideDir = tempDir("omp-download-bulk-out-");
		const artifact = join(root, "artifact.zip");
		writeFileSync(artifact, "payload");
		const decoy = join(outsideDir, "decoy.zip");
		writeFileSync(decoy, "payload");

		// Authorization (realpath + stat) reads `roots` before the transfer; the
		// first read is therefore the swap point: replace the authorized
		// artifact with a symlink that resolves outside the jail.
		let swapped = false;
		const roots = new Proxy([root], {
			get(target, prop, receiver) {
				if (!swapped) {
					swapped = true;
					unlinkSync(artifact);
					symlinkSync(decoy, artifact);
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		const serve = bulkServe(artifact, root, "corr-swap");
		await serve.run(roots);

		expect(swapped).toBe(true);
		expect(serve.uploaded()).toBe(0);
		expect(serve.failures).toHaveLength(1);
		expect(serve.failures[0]?.error.code).toBe("forbidden");
		expect(serve.failures[0]?.error.message).toContain("changed during authorization");
	});

	test("an empty path is invalid_request and a missing artifact unavailable", async () => {
		const root = tempDir("omp-download-bulk-map-");
		const empty = bulkServe("", root, "corr-empty");
		await empty.run();
		expect(empty.failures).toHaveLength(1);
		expect(empty.failures[0]?.error.code).toBe("invalid_request");

		const missing = bulkServe(join(root, "gone.zip"), root, "corr-missing");
		await missing.run();
		expect(missing.failures).toHaveLength(1);
		expect(missing.failures[0]?.error.code).toBe("unavailable");
		expect(missing.failures[0]?.error.message).toContain("not found");

		expect(empty.uploaded()).toBe(0);
		expect(missing.uploaded()).toBe(0);
	});

	test("an artifact over the 64 MiB cap fails the correlation before any part", async () => {
		const root = tempDir("omp-download-cap-");
		const artifact = join(root, "huge.zip");
		writeFileSync(artifact, "");
		truncateSync(artifact, BULK_MAX_BYTES + 1);

		const serve = bulkServe(artifact, root, "corr-cap");
		await serve.run();

		expect(serve.uploaded()).toBe(0);
		expect(serve.failures).toHaveLength(1);
		expect(serve.failures[0]?.correlationId).toBe("corr-cap");
		expect(serve.failures[0]?.error.code).toBe("unavailable");
		expect(serve.failures[0]?.error.message).toContain("64 MiB bulk cap");
	});
});
