/**
 * Unit tests for the deep-link missing-file fallback decision
 * (src/tx/util/missing-file.ts): fall back when the selected file is present
 * but deleted (onDisk false) or absent under a settled, untruncated,
 * unfiltered response; never while loading/errored/searching, never when an
 * absent file could be hiding past a truncated response.
 */
import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../api";
import { shouldFallbackMissingFile, type MissingFileSnapshot } from "./missing-file";

function session(file: string, onDisk = true): SessionSummary {
	return {
		file,
		folder: "proj-a",
		cwd: "/w/proj-a",
		title: null,
		id: null,
		firstTs: null,
		lastTs: null,
		turns: 0,
		toolCalls: 0,
		totalTokens: 0,
		totalCost: 0,
		errorTurns: 0,
		modelCount: 0,
		userMessages: 0,
		userChars: 0,
		synced: false,
		onDisk,
		size: 0,
		mtimeMs: 0,
	};
}

function snapshot(overrides: Partial<MissingFileSnapshot> = {}): MissingFileSnapshot {
	return {
		selectedFile: "deleted/session.jsonl",
		sessions: [],
		loading: false,
		errored: false,
		truncated: false,
		hasQuery: false,
		...overrides,
	};
}

describe("shouldFallbackMissingFile", () => {
	test("falls back when the selected file is present but onDisk is false", () => {
		expect(
			shouldFallbackMissingFile(snapshot({ sessions: [session("deleted/session.jsonl", false)] })),
		).toBe(true);
	});

	test("falls back when the file is absent and the response was not truncated", () => {
		expect(
			shouldFallbackMissingFile(snapshot({ sessions: [session("other/session.jsonl")] })),
		).toBe(true);
		expect(shouldFallbackMissingFile(snapshot({ sessions: [] }))).toBe(true);
	});

	test("does not fall back when the file is absent under a truncated response", () => {
		expect(
			shouldFallbackMissingFile(
				snapshot({ sessions: [session("other/session.jsonl")], truncated: true }),
			),
		).toBe(false);
	});

	test("does not fall back while the sessions resource is loading", () => {
		expect(shouldFallbackMissingFile(snapshot({ loading: true, sessions: [] }))).toBe(false);
	});

	test("does not fall back while the sessions resource has errored", () => {
		expect(shouldFallbackMissingFile(snapshot({ errored: true, sessions: [] }))).toBe(false);
	});

	test("does not fall back while a search query is active", () => {
		expect(shouldFallbackMissingFile(snapshot({ sessions: [], hasQuery: true }))).toBe(false);
	});

	test("does not fire when nothing is selected (list view)", () => {
		expect(shouldFallbackMissingFile(snapshot({ selectedFile: null }))).toBe(false);
	});

	test("does not fall back when the file is present and on disk", () => {
		expect(
			shouldFallbackMissingFile(
				snapshot({
					selectedFile: "alive/session.jsonl",
					sessions: [session("alive/session.jsonl")],
				}),
			),
		).toBe(false);
	});
});
