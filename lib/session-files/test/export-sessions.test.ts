/**
 * Direct coverage for the lineage classifier shared by the verify-at-deletion
 * gate and the store mirror (lib/session-files/export-sessions.ts):
 * `owningMainRel` and `classifyLineageEntry`, which decide what each store
 * relpath is (main, subagent, advisor, metadata) and which main it nests under.
 *
 * Assertions pin the observable contract only: classification, owning main,
 * and the frozen ledger error code + path. Error wording is never pinned.
 */

import { describe, expect, test } from "bun:test";
import { ExportError } from "#lib/session-files/archive-manifest";
import { classifyLineageEntry, owningMainRel } from "#lib/session-files/export-sessions";

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
