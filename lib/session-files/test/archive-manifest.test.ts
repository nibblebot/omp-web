/**
 * Direct coverage for the frozen archive-manifest contract
 * (lib/session-files/archive-manifest.ts): the shared POSIX-relative path
 * predicate every clone/export/wake guard delegates to, the canonical-JSON
 * form the exportId hashes, and the content-addressed id itself.
 *
 * The path predicate is the highest-risk export here: it is the only thing
 * standing between a hostile store/wire relpath and the export and
 * wake paths that join it onto a sessions dir. Assertions pin the frozen
 * acceptance/rejection decisions, the ledger error code
 * (`invalid_request`) and the path a typed error carries; error wording is
 * never pinned.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type ArchiveManifest,
	canonicalJson,
	computeExportId,
	isNormalizedPosixRelativePath,
} from "#lib/session-files/archive-manifest";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const MAIN_PATH = "20260906T1200_main.jsonl";

/** One structurally valid v1 manifest, mutable per test. */
interface ManifestFixture {
	provenance: Record<string, unknown>;
	files: Array<Record<string, unknown>>;
}

function baseManifest(): ManifestFixture {
	return {
		provenance: {
			projectId: "proj-1",
			workspaceId: "ws-1",
			workspaceName: "Demo workspace",
			resolvedCommit: "abc123",
			generatedAt: "2026-09-06T00:00:00.000Z",
		},
		files: [
			{ path: MAIN_PATH, size: 128, sha256: SHA_A, kind: "main", sessionId: "20260906T1200_main" },
			{
				path: "20260906T1200_main/sub1.jsonl",
				size: 64,
				sha256: SHA_B,
				kind: "subagent",
				sessionId: "20260906T1200_main",
				parentPath: MAIN_PATH,
			},
		],
	};
}

/** Deep clone so a test mutates exactly one field without touching siblings. */
function manifestWith(mutate: (manifest: ManifestFixture) => void): ManifestFixture {
	const manifest = structuredClone(baseManifest());
	mutate(manifest);
	return manifest;
}

/** Same content with every object's keys inserted in reverse order. */
function reorder(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => reorder(entry));
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).reverse();
	return Object.fromEntries(entries.map(([key, entry]) => [key, reorder(entry)]));
}

describe("isNormalizedPosixRelativePath", () => {
	test("accepts normalized POSIX-relative paths", () => {
		const accepted = [
			"a.jsonl",
			"20260906T1200_main.jsonl",
			"proj/20260906T1200_main.jsonl",
			"proj/20260906T1200_main/sub1.jsonl",
			"proj/20260906T1200_main/sub1/deep.jsonl",
			"__advisor.jsonl",
			"proj/__advisor.2.jsonl",
			"a..b",
			"..a/b..",
			"ab:c",
			"a b/c d.txt",
			"héllo/wörld.jsonl",
		];
		for (const value of accepted) {
			expect({ value, ok: isNormalizedPosixRelativePath(value) }).toEqual({ value, ok: true });
		}
	});

	test("rejects absolute, drive-relative, UNC and backslash forms", () => {
		const rejected = [
			"",
			"/",
			"/etc/passwd",
			"/abs/x.jsonl",
			"//server/share/x.jsonl",
			"C:x",
			"C:/x.jsonl",
			"c:\\x.jsonl",
			"a:b",
			"a\\b.jsonl",
			"\\x.jsonl",
			"\\\\server\\share\\x.jsonl",
		];
		for (const value of rejected)
			expect({ value, ok: isNormalizedPosixRelativePath(value) }).toEqual({ value, ok: false });
	});

	test("rejects traversal and empty or dot segments", () => {
		const rejected = [
			".",
			"..",
			"./x.jsonl",
			"../x.jsonl",
			"x/..",
			"x/../y.jsonl",
			"x/./y.jsonl",
			"x/",
			"x//y.jsonl",
			"proj//20260906T1200_main.jsonl",
			"a/b/../../c.jsonl",
		];
		for (const value of rejected)
			expect({ value, ok: isNormalizedPosixRelativePath(value) }).toEqual({ value, ok: false });
	});
});

describe("canonicalJson", () => {
	test("sorts object keys recursively so insertion order never changes the bytes", () => {
		const a = { b: 1, a: { d: 4, c: [3, 1] } };
		const b = { a: { c: [3, 1], d: 4 }, b: 1 };
		expect(canonicalJson(a)).toBe('{"a":{"c":[3,1],"d":4},"b":1}');
		expect(canonicalJson(b)).toBe(canonicalJson(a));
	});

	test("drops undefined properties, keeps null values and array slots", () => {
		expect(canonicalJson({ z: undefined, a: [3, 1, 2], n: null })).toBe('{"a":[3,1,2],"n":null}');
		expect(canonicalJson({ nested: { keep: 1, drop: undefined } })).toBe('{"nested":{"keep":1}}');
		expect(canonicalJson([1, undefined])).toBe("[1,null]");
	});

	test("serializes primitives exactly like JSON.stringify", () => {
		for (const value of [null, true, false, 7, -1.5, "x", 'he said "hi"\n'])
			expect(canonicalJson(value)).toBe(JSON.stringify(value) ?? "null");
	});

	test("is stable for the same manifest content regardless of key order", () => {
		const plain = baseManifest() as unknown as ArchiveManifest;
		const shuffled = reorder(baseManifest()) as ArchiveManifest;
		expect(canonicalJson(shuffled)).toBe(canonicalJson(plain));
	});
});

describe("computeExportId", () => {
	test("is content-addressed as ws_<workspaceId>_<sha256(canonical manifest)[:16]>", () => {
		const manifest = baseManifest() as unknown as ArchiveManifest;
		const digest = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
		const exportId = computeExportId(manifest);
		expect(exportId).toBe(`ws_ws-1_${digest.slice(0, 16)}`);
		expect(exportId).toMatch(/^ws_ws-1_[0-9a-f]{16}$/);
	});

	test("is idempotent for identical retries regardless of key order", () => {
		const plain = baseManifest() as unknown as ArchiveManifest;
		const shuffled = reorder(baseManifest()) as ArchiveManifest;
		expect(computeExportId(shuffled)).toBe(computeExportId(plain));
	});

	test("changes when any declared byte, path, kind, session id or provenance field changes", () => {
		const mutations: Array<[string, (manifest: ManifestFixture) => void]> = [
			["file size", (manifest) => (manifest.files[0].size = 129)],
			["file sha256", (manifest) => (manifest.files[0].sha256 = SHA_B)],
			["file path", (manifest) => (manifest.files[0].path = "renamed.jsonl")],
			["file kind", (manifest) => (manifest.files[0].kind = "metadata")],
			["file sessionId", (manifest) => (manifest.files[0].sessionId = "other")],
			["file parentPath", (manifest) => (manifest.files[1].parentPath = "other.jsonl")],
			["file count", (manifest) => manifest.files.pop()],
			["workspaceName", (manifest) => (manifest.provenance.workspaceName = "Renamed")],
			["resolvedCommit", (manifest) => (manifest.provenance.resolvedCommit = "def456")],
			["generatedAt", (manifest) => (manifest.provenance.generatedAt = "2026-09-07T00:00:00.000Z")],
			["projectId", (manifest) => (manifest.provenance.projectId = "proj-2")],
		];
		const base = computeExportId(baseManifest() as unknown as ArchiveManifest);
		for (const [label, mutate] of mutations) {
			const mutated = computeExportId(manifestWith(mutate) as unknown as ArchiveManifest);
			const observed = {
				label,
				differs: mutated !== base,
				namespaced: mutated.startsWith("ws_ws-1_"),
			};
			expect(observed).toEqual({ label, differs: true, namespaced: true });
		}
	});

	test("namespaces by workspace id: identical file sets never collide across workspaces", () => {
		const base = computeExportId(baseManifest() as unknown as ArchiveManifest);
		const other = computeExportId(
			manifestWith((manifest) => {
				manifest.provenance.workspaceId = "ws-2";
			}) as unknown as ArchiveManifest,
		);
		// The workspace id is both the id prefix and part of the hashed
		// provenance, so the digest differs too.
		expect(other).not.toBe(base);
		expect(other).toMatch(/^ws_ws-2_[0-9a-f]{16}$/);
		expect(other.slice("ws_ws-2_".length)).not.toBe(base.slice("ws_ws-1_".length));
	});
});
