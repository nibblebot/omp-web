/**
 * Direct coverage for the frozen archive-manifest contract
 * (lib/session-files/archive-manifest.ts): the shared POSIX-relative path
 * predicate every clone/export/wake guard delegates to, the v1 manifest
 * validator, the canonical-JSON form the exportId hashes, and the
 * content-addressed id itself.
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
	ExportError,
	canonicalJson,
	computeExportId,
	isNormalizedPosixRelativePath,
	validateManifest,
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

/** Run `fn`, require an {@link ExportError}, and return it for code/path assertions. */
function exportFailure(fn: () => unknown): ExportError {
	try {
		fn();
	} catch (error) {
		if (error instanceof ExportError) return error;
		throw error;
	}
	throw new Error("expected an ExportError, but the call succeeded");
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

describe("validateManifest", () => {
	test("accepts a fully populated manifest and preserves every declared field", () => {
		const fixture = manifestWith((manifest) => {
			manifest.provenance.source = {
				local: "/srv/repos/demo",
				remote: "git@example.com:acme/demo.git",
			};
		});
		const validated: unknown = validateManifest(fixture);
		expect(validated).toEqual(fixture);
	});

	test("omits provenance.source when the manifest declares none, and parentPath on mains", () => {
		const result = validateManifest(baseManifest());
		expect("source" in result.provenance).toBe(false);
		expect(result.provenance.workspaceId).toBe("ws-1");
		expect(result.files).toHaveLength(2);
		expect("parentPath" in result.files[0]).toBe(false);
		expect(result.files[1].parentPath).toBe(MAIN_PATH);
		expect(result.files.map((file) => file.kind)).toEqual(["main", "subagent"]);
	});

	test("rejects non-object manifests without a path", () => {
		for (const value of [null, undefined, [], "manifest", 7, true]) {
			const error = exportFailure(() => validateManifest(value));
			expect(error.code).toBe("invalid_request");
			expect(error.path).toBeUndefined();
		}
	});

	test("rejects a missing or non-array files list", () => {
		for (const files of [undefined, null, {}, "files", 2]) {
			const fixture = manifestWith((manifest) => {
				manifest.files = files as unknown as Array<Record<string, unknown>>;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
	});

	test("rejects required provenance fields that are missing or empty", () => {
		const fields = ["projectId", "workspaceId", "workspaceName", "resolvedCommit", "generatedAt"];
		for (const field of fields) {
			const missing = manifestWith((manifest) => {
				delete manifest.provenance[field];
			});
			expect(exportFailure(() => validateManifest(missing)).code).toBe("invalid_request");
			const empty = manifestWith((manifest) => {
				manifest.provenance[field] = "";
			});
			expect(exportFailure(() => validateManifest(empty)).code).toBe("invalid_request");
		}
	});

	test("rejects a malformed provenance.source", () => {
		for (const source of ["git", 7, [], { local: "" }, { remote: 42 }, { local: 1 }]) {
			const fixture = manifestWith((manifest) => {
				manifest.provenance.source = source;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
	});

	test("rejects entries whose path is not a normalized POSIX-relative path", () => {
		const unsafe = [
			"/abs.jsonl",
			"../escape.jsonl",
			"a//b.jsonl",
			"a/./b.jsonl",
			"a/",
			"a\\b.jsonl",
		];
		for (const path of unsafe) {
			const fixture = manifestWith((manifest) => {
				manifest.files[0].path = path;
			});
			const error = exportFailure(() => validateManifest(fixture));
			expect({ path, code: error.code, reported: error.path }).toEqual({
				path,
				code: "invalid_request",
				reported: path,
			});
		}
		// An empty path fails the non-empty-string rule, so it carries no path.
		const empty = manifestWith((manifest) => {
			manifest.files[0].path = "";
		});
		expect(exportFailure(() => validateManifest(empty)).code).toBe("invalid_request");
	});

	test("rejects duplicate declared paths", () => {
		const fixture = manifestWith((manifest) => {
			manifest.files[1].path = MAIN_PATH;
		});
		const error = exportFailure(() => validateManifest(fixture));
		expect({ code: error.code, path: error.path }).toEqual({
			code: "invalid_request",
			path: MAIN_PATH,
		});
	});

	test("rejects a size that is not a non-negative safe integer", () => {
		const sizes = [
			-1,
			-0.5,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			2 ** 53,
			"12",
			null,
			undefined,
		];
		for (const size of sizes) {
			const fixture = manifestWith((manifest) => {
				manifest.files[0].size = size;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
	});

	test("rejects a sha256 that is not 64 lowercase hex chars", () => {
		const hashes = ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), 42, undefined];
		for (const sha256 of hashes) {
			const fixture = manifestWith((manifest) => {
				manifest.files[0].sha256 = sha256;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
	});

	test("rejects an unknown or missing file kind", () => {
		for (const kind of ["transcript", "MAIN", "", 1, null, undefined]) {
			const fixture = manifestWith((manifest) => {
				manifest.files[0].kind = kind;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
	});

	test("rejects a missing or empty sessionId", () => {
		for (const sessionId of ["", 7, null, undefined]) {
			const fixture = manifestWith((manifest) => {
				manifest.files[0].sessionId = sessionId;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
	});

	test("rejects non-object file entries", () => {
		for (const entry of [null, 42, "file", []]) {
			const fixture = manifestWith((manifest) => {
				manifest.files[0] = entry as unknown as Record<string, unknown>;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
	});

	test("rejects a parentPath that is not a normalized POSIX-relative path", () => {
		for (const parentPath of ["/abs.jsonl", "../x.jsonl", "a//b.jsonl", "a/", "a\\b.jsonl", ""]) {
			const fixture = manifestWith((manifest) => {
				manifest.files[1].parentPath = parentPath;
			});
			expect(exportFailure(() => validateManifest(fixture)).code).toBe("invalid_request");
		}
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
		const plain = validateManifest(baseManifest());
		const shuffled = validateManifest(reorder(baseManifest()));
		expect(canonicalJson(shuffled)).toBe(canonicalJson(plain));
	});
});

describe("computeExportId", () => {
	test("is content-addressed as ws_<workspaceId>_<sha256(canonical manifest)[:16]>", () => {
		const manifest = validateManifest(baseManifest());
		const digest = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
		const exportId = computeExportId(manifest);
		expect(exportId).toBe(`ws_ws-1_${digest.slice(0, 16)}`);
		expect(exportId).toMatch(/^ws_ws-1_[0-9a-f]{16}$/);
	});

	test("is idempotent for identical retries regardless of key order", () => {
		const plain = validateManifest(baseManifest());
		const shuffled = validateManifest(reorder(baseManifest()));
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
		const base = computeExportId(validateManifest(baseManifest()));
		for (const [label, mutate] of mutations) {
			const mutated = computeExportId(validateManifest(manifestWith(mutate)));
			const observed = {
				label,
				differs: mutated !== base,
				namespaced: mutated.startsWith("ws_ws-1_"),
			};
			expect(observed).toEqual({ label, differs: true, namespaced: true });
		}
	});

	test("namespaces by workspace id: identical file sets never collide across workspaces", () => {
		const base = computeExportId(validateManifest(baseManifest()));
		const other = computeExportId(
			validateManifest(
				manifestWith((manifest) => {
					manifest.provenance.workspaceId = "ws-2";
				}),
			),
		);
		// The workspace id is both the id prefix and part of the hashed
		// provenance, so the digest differs too.
		expect(other).not.toBe(base);
		expect(other).toMatch(/^ws_ws-2_[0-9a-f]{16}$/);
		expect(other.slice("ws_ws-2_".length)).not.toBe(base.slice("ws_ws-1_".length));
	});
});
