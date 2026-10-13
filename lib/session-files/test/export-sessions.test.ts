/**
 * Direct coverage for the session-tree planner + structural verifier
 * (lib/session-files/export-sessions.ts): the load-bearing
 * `verifyJsonlStructure` flush-evidence predicate every quiesce/delete gate
 * runs, plus the walk that declares what an export contains and classifies
 * each relpath by the frozen manifest rules.
 *
 * Assertions pin the observable contract only: which relpaths are declared
 * (and how they classify), which hazards are refused, and the frozen ledger
 * error code + path. Error wording and discovery order are never pinned
 * (consumers sort for determinism).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExportError } from "#lib/session-files/archive-manifest";
import {
	MAX_EXPORT_BYTES,
	MAX_EXPORT_FILES,
	classifyLineageEntry,
	owningMainRel,
	planSessionExport,
	type SessionLineageEntry,
	verifyJsonlStructure,
} from "#lib/session-files/export-sessions";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

/** Structurally plausible session JSONL lines (shape frozen in the SDK). */
const TITLE_SLOT = titleSlot();
const HEADER = '{"type":"session","id":"minted-session-uuid","cwd":"/srv/proj"}';
const ENTRY = '{"type":"message","id":"m1","message":{"role":"user","content":"hello"}}';
const BODY = `${TITLE_SLOT}\n${HEADER}\n`;

/**
 * Title slot line (frozen SDK shape) with individual fields overridden. An
 * `undefined` override drops the field (`JSON.stringify` semantics).
 */
function titleSlot(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "title",
		v: 1,
		title: "Lineage demo",
		updatedAt: "2026-09-06T00:00:00.000Z",
		pad: "",
		...overrides,
	});
}

/** Write every `relpath` → content pair under `root`, creating parents. */
function writeTree(root: string, files: Record<string, string>): void {
	for (const [relpath, content] of Object.entries(files)) {
		const absolute = join(root, relpath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}
}

/** Write `body` as a session JSONL in a fresh tracked dir; return its absolute path. */
function writeJsonl(body: string): string {
	const absolute = join(tempDir("jsonl-verify-"), "20260906T1200_session.jsonl");
	writeFileSync(absolute, body);
	return absolute;
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

/** `relToSessions` → declared lineage fields (order-independent comparison). */
function declaredEntries(files: SessionLineageEntry[]): Record<string, unknown> {
	return Object.fromEntries(
		files.map((file) => [
			file.relToSessions,
			{
				kind: file.kind,
				sessionId: file.sessionId,
				...(file.parentPath !== undefined ? { parentPath: file.parentPath } : {}),
			},
		]),
	);
}

describe("planSessionExport", () => {
	test("declares depth-1 and depth-2 mains with their artifact subtrees classified by kind", () => {
		const root = tempDir("session-export-plan-");
		writeTree(root, {
			"a.jsonl": BODY,
			"a/sub1.jsonl": BODY,
			"a/nested/deep.jsonl": BODY,
			"a/__advisor.jsonl": BODY,
			"a/__advisor.5.jsonl": BODY,
			"a/notes.md": "notes\n",
		});
		// A project dir carries `<proj>/<session>.jsonl` with its artifact dir
		// `<proj>/<session>/`; an active project holds several sessions, and
		// readdir order must never decide whether an artifact dir is walked.
		const projectSessions = ["psess", "qsses", "rsses", "ssses"];
		for (const stem of projectSessions) {
			writeTree(root, {
				[`proj/${stem}.jsonl`]: BODY,
				[`proj/${stem}/sub2.jsonl`]: BODY,
			});
		}

		const plan = planSessionExport(root);
		const expected: Array<[string, string, string, string | undefined]> = [
			["a.jsonl", "main", "a", undefined],
			["a/__advisor.5.jsonl", "advisor", "a", "a.jsonl"],
			["a/__advisor.jsonl", "advisor", "a", "a.jsonl"],
			["a/nested/deep.jsonl", "subagent", "a", "a.jsonl"],
			["a/notes.md", "metadata", "a", "a.jsonl"],
			["a/sub1.jsonl", "subagent", "a", "a.jsonl"],
		];
		for (const stem of projectSessions) {
			expected.push([`proj/${stem}.jsonl`, "main", stem, undefined]);
			expected.push([`proj/${stem}/sub2.jsonl`, "subagent", stem, `proj/${stem}.jsonl`]);
		}
		expect(declaredEntries(plan.files)).toEqual(
			Object.fromEntries(
				expected.map(([relToSessions, kind, sessionId, parentPath]) => [
					relToSessions,
					parentPath === undefined ? { kind, sessionId } : { kind, sessionId, parentPath },
				]),
			),
		);
		expect([...plan.mainSessions.entries()].sort()).toEqual([
			["a.jsonl", "a"],
			["proj/psess.jsonl", "psess"],
			["proj/qsses.jsonl", "qsses"],
			["proj/rsses.jsonl", "rsses"],
			["proj/ssses.jsonl", "ssses"],
		]);
	});

	test("excludes stray root files, unrelated dirs and unowned trees", () => {
		const root = tempDir("session-export-exclude-");
		writeTree(root, {
			"keep.jsonl": BODY,
			"keep/sub.jsonl": BODY,
			"notes.txt": "root stray\n",
			"__advisor.jsonl": BODY,
			"docs/readme.md": "unrelated\n",
			"proj/notes/deep.jsonl": BODY,
		});

		const plan = planSessionExport(root);
		expect(plan.files.map((file) => file.relToSessions).sort()).toEqual([
			"keep.jsonl",
			"keep/sub.jsonl",
		]);
		expect([...plan.mainSessions.entries()]).toEqual([["keep.jsonl", "keep"]]);
	});

	test("refuses a symlink anywhere in the tree, even one pointing outside", () => {
		const outside = join(tempDir("session-export-outside-"), "secret.jsonl");
		writeFileSync(outside, "secret\n");
		const cases: Array<[string, string, string]> = [
			["root symlink", "link.jsonl", join(outside, "..", "missing-target.jsonl")],
			["root symlink to a file outside the tree", "leak.jsonl", outside],
			["artifact-dir symlink to a file outside the tree", "a/leak.jsonl", outside],
			["project-dir symlink to a file outside the tree", "proj/leak.jsonl", outside],
		];
		for (const [label, relpath, target] of cases) {
			const root = tempDir("session-export-symlink-");
			writeTree(root, { "a.jsonl": BODY });
			mkdirSync(dirname(join(root, relpath)), { recursive: true });
			symlinkSync(target, join(root, relpath));

			const error = exportFailure(() => planSessionExport(root));
			expect({ label, code: error.code, reported: error.path }).toEqual({
				label,
				code: "invalid_request",
				reported: relpath,
			});
		}
	});

	test("refuses a tree over the 10k-file bound", () => {
		const root = tempDir("session-export-files-");
		writeTree(root, { "bulk.jsonl": BODY });
		const artifact = join(root, "bulk");
		mkdirSync(artifact, { recursive: true });
		for (let index = 0; index < MAX_EXPORT_FILES; index++)
			writeFileSync(join(artifact, `f${index}.bin`), "");

		expect(exportFailure(() => planSessionExport(root)).code).toBe("invalid_request");
	});

	test("refuses a tree over the byte bound", () => {
		const root = tempDir("session-export-bytes-");
		writeTree(root, { "huge.jsonl": "" });
		truncateSync(join(root, "huge.jsonl"), MAX_EXPORT_BYTES + 1);

		const error = exportFailure(() => planSessionExport(root));
		expect({ code: error.code, reported: error.path }).toEqual({
			code: "invalid_request",
			reported: "huge.jsonl",
		});
	});
});

describe("owningMainRel", () => {
	const mains: ReadonlySet<string> = new Set([
		"a.jsonl",
		"proj/psess.jsonl",
		"proj/psess/sub1.jsonl",
	]);

	test("returns the nearest (longest-stem) owning main", () => {
		expect(owningMainRel("proj/psess/sub1/deep.jsonl", mains)).toBe("proj/psess/sub1.jsonl");
		expect(owningMainRel("proj/psess/sub2.jsonl", mains)).toBe("proj/psess.jsonl");
		expect(owningMainRel("a/nested/deep.jsonl", mains)).toBe("a.jsonl");
	});

	test("returns undefined when no main stem prefixes the relpath", () => {
		expect(owningMainRel("other/x.jsonl", mains)).toBeUndefined();
		// A main is not its own artifact, and a stem only matches on the
		// directory boundary (never a partial name).
		expect(owningMainRel("a.jsonl", mains)).toBeUndefined();
		expect(owningMainRel("a.jsonl/x.jsonl", mains)).toBeUndefined();
		expect(owningMainRel("proj/psessish/x.jsonl", mains)).toBeUndefined();
	});

	test("accepts a declared main relpath without its .jsonl suffix", () => {
		expect(owningMainRel("a/x.jsonl", new Set(["a"]))).toBe("a");
	});
});

describe("classifyLineageEntry", () => {
	const mains: ReadonlySet<string> = new Set(["a.jsonl", "proj/psess.jsonl"]);

	test("classifies a declared main by its file stem and nests everything else under it", () => {
		expect(classifyLineageEntry("a.jsonl", mains)).toEqual({ kind: "main", sessionId: "a" });
		expect(classifyLineageEntry("proj/psess.jsonl", mains)).toEqual({
			kind: "main",
			sessionId: "psess",
		});
		expect(classifyLineageEntry("a/sub1.jsonl", mains)).toEqual({
			kind: "subagent",
			sessionId: "a",
			parentPath: "a.jsonl",
		});
		expect(classifyLineageEntry("a/nested/deep.jsonl", mains)).toEqual({
			kind: "subagent",
			sessionId: "a",
			parentPath: "a.jsonl",
		});
		expect(classifyLineageEntry("a/__advisor.jsonl", mains)).toEqual({
			kind: "advisor",
			sessionId: "a",
			parentPath: "a.jsonl",
		});
		expect(classifyLineageEntry("a/__advisor.5.jsonl", mains)).toEqual({
			kind: "advisor",
			sessionId: "a",
			parentPath: "a.jsonl",
		});
		expect(classifyLineageEntry("a/notes.md", mains)).toEqual({
			kind: "metadata",
			sessionId: "a",
			parentPath: "a.jsonl",
		});
		expect(classifyLineageEntry("proj/psess/sub2.jsonl", mains)).toEqual({
			kind: "subagent",
			sessionId: "psess",
			parentPath: "proj/psess.jsonl",
		});
	});

	test("rejects a path that belongs to no declared main", () => {
		expect(exportFailure(() => classifyLineageEntry("orphan/x.jsonl", mains)).code).toBe(
			"invalid_request",
		);
		const error = exportFailure(() => classifyLineageEntry("proj/orphan.jsonl", mains));
		expect({ code: error.code, reported: error.path }).toEqual({
			code: "invalid_request",
			reported: "proj/orphan.jsonl",
		});
	});
});

describe("verifyJsonlStructure", () => {
	test("accepts modern, legacy and fresh-session layouts with any minted header id", () => {
		const accepted: Array<[string, string]> = [
			["modern: title slot, header, one entry", `${TITLE_SLOT}\n${HEADER}\n${ENTRY}\n`],
			["fresh session: title slot plus header only", BODY],
			["legacy: header first, no title slot", `${HEADER}\n${ENTRY}\n`],
			["legacy: header only", `${HEADER}\n`],
			["title slot with source=user", `${titleSlot({ source: "user" })}\n${HEADER}\n`],
			[
				"title slot with source=auto and a non-empty pad",
				`${titleSlot({ pad: "pad", source: "auto" })}\n${HEADER}\n`,
			],
			[
				"header id unrelated to the file stem",
				`${TITLE_SLOT}\n{"type":"session","id":"some-other-uuid","cwd":"/srv/proj"}\n${ENTRY}\n`,
			],
		];
		for (const [label, body] of accepted) {
			const absolute = writeJsonl(body);
			let failure: string | undefined;
			try {
				verifyJsonlStructure(absolute, "20260906T1200_session");
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			expect({ label, failure }).toEqual({ label, failure: undefined });
		}
	});

	test("refuses truncated files as typed unavailable", () => {
		const cases: Array<[string, string]> = [
			["empty file", ""],
			["partial first line", TITLE_SLOT],
			["header line without its newline", `${TITLE_SLOT}\n${HEADER}`],
			["truncated entry tail", `${TITLE_SLOT}\n${HEADER}\n${ENTRY}`],
			["truncated tail that is still valid JSON", `${TITLE_SLOT}\n${HEADER}\n{"type":"message"}`],
			["entry tail truncated mid-record", `${TITLE_SLOT}\n${HEADER}\n${ENTRY.slice(0, 20)}`],
		];
		for (const [label, body] of cases) {
			const absolute = writeJsonl(body);
			const error = exportFailure(() => verifyJsonlStructure(absolute, "20260906T1200_session"));
			expect({ label, code: error.code, reported: error.path }).toEqual({
				label,
				code: "unavailable",
				reported: absolute,
			});
		}
	});

	test("refuses corrupt lines as typed unavailable", () => {
		const cases: Array<[string, string]> = [
			["invalid JSON entry", `${TITLE_SLOT}\n${HEADER}\n{not json}\n`],
			["bare word entry", `${TITLE_SLOT}\n${HEADER}\nnope\n`],
			["blank line between entries", `${TITLE_SLOT}\n${HEADER}\n\n${ENTRY}\n`],
			["title slot followed by an entry instead of a header", `${TITLE_SLOT}\n${ENTRY}\n`],
			["legacy file whose first line is an entry", `${ENTRY}\n`],
		];
		for (const [label, body] of cases) {
			const absolute = writeJsonl(body);
			const error = exportFailure(() => verifyJsonlStructure(absolute, "20260906T1200_session"));
			expect({ label, code: error.code, reported: error.path }).toEqual({
				label,
				code: "unavailable",
				reported: absolute,
			});
		}
	});

	test("refuses files without a usable session header", () => {
		const cases: Array<[string, string]> = [
			["legacy session line with no id", '{"type":"session","cwd":"/srv/proj"}\n'],
			["legacy session line with an empty id", '{"type":"session","id":"","cwd":"/srv/proj"}\n'],
			["title slot with an unknown version", `${titleSlot({ v: 2 })}\n${HEADER}\n`],
			["title slot with an unknown source", `${titleSlot({ source: "bogus" })}\n${HEADER}\n`],
			// pad: undefined drops the key, so the slot has no pad at all.
			["title slot missing pad", `${titleSlot({ pad: undefined })}\n${HEADER}\n`],
		];
		for (const [label, body] of cases) {
			const absolute = writeJsonl(body);
			const error = exportFailure(() => verifyJsonlStructure(absolute, "20260906T1200_session"));
			expect({ label, code: error.code, reported: error.path }).toEqual({
				label,
				code: "unavailable",
				reported: absolute,
			});
		}
	});

	test("treats the persistence-indeterminate fingerprint as a hard blocker", () => {
		// Valid JSON that would otherwise verify as a legacy session header.
		const body = `${JSON.stringify({
			type: "session",
			id: "minted-session-uuid",
			note: "session persistence is indeterminate",
		})}\n`;

		const absolute = writeJsonl(body);
		const error = exportFailure(() => verifyJsonlStructure(absolute, "20260906T1200_session"));
		expect(error.code).toBe("unavailable");
	});
});
