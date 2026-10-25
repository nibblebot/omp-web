/**
 * Tests for fleet selector resolution (fleet/selectors.ts).
 *
 * Pure and hermetic: entries are constructed inline against the RosterEntry
 * shape from lib/wire/protocol.ts (plus the RegistryEntry-only `registeredAt`
 * field) instead of importing ./registry, so this suite runs standalone
 * before the registry slice lands.
 */

import { describe, expect, test } from "bun:test";
import type { RosterEntry } from "#lib/wire/protocol";
import { matchSelector } from "../selectors";

type RegistryEntryShape = RosterEntry & { registeredAt: number };

let nextId = 0;

/** Build a RegistryEntry-shaped literal with sane defaults. */
function entry(overrides: Partial<RegistryEntryShape> = {}): RegistryEntryShape {
	const workspaceId = overrides.workspaceId ?? `d${++nextId}`;
	return {
		workspaceId,
		name: workspaceId,
		cwd: `/home/user/${workspaceId}`,
		project: "root",
		status: "asleep",
		registeredAt: 1,
		...overrides,
	};
}

describe("matchSelector", () => {
	describe('"all"', () => {
		test("returns every entry", () => {
			const entries = [entry({ name: "web" }), entry({ name: "api" }), entry({ name: "worker" })];
			expect(matchSelector(entries, "all")).toEqual(entries);
		});

		test("empty registry yields empty result", () => {
			expect(matchSelector([], "all")).toEqual([]);
		});
	});

	describe("bare workspaceId", () => {
		test("matches exactly", () => {
			const a = entry({ name: "web" });
			const b = entry({ name: "api" });
			expect(matchSelector([a, b], a.workspaceId)).toEqual([a]);
			expect(matchSelector([a, b], "d999")).toEqual([]);
		});

		test("exact workspaceId wins over glob interpretation of the name", () => {
			const byId = entry({ workspaceId: "d3", name: "web" });
			const byName = entry({ workspaceId: "d1", name: "d3" });
			expect(matchSelector([byId, byName], "d3")).toEqual([byId]);
		});
	});

	describe("project:name", () => {
		test("matches entry.project exactly", () => {
			const frontend = entry({ project: "frontend" });
			const backend = entry({ project: "backend" });
			expect(matchSelector([frontend, backend], "project:frontend")).toEqual([frontend]);
			expect(matchSelector([frontend, backend], "project:backend")).toEqual([backend]);
		});

		test("is exact, not a glob", () => {
			const frontend = entry({ project: "frontend" });
			expect(matchSelector([frontend], "project:fron*")).toEqual([]);
			expect(matchSelector([frontend], "project:frontend")).toEqual([frontend]);
		});
	});

	describe("name glob", () => {
		test('"*" alone matches every name', () => {
			const entries = [
				entry({ name: "web" }),
				entry({ name: "a.b" }),
				entry({ name: "x?y" }),
				entry({ name: "" }),
			];
			expect(matchSelector(entries, "*")).toEqual(entries);
		});

		test("* matches any run, including empty", () => {
			const entries = [
				entry({ name: "fo" }),
				entry({ name: "foo" }),
				entry({ name: "f123o" }),
				entry({ name: "bar" }),
			];
			expect(matchSelector(entries, "f*o")).toEqual([entries[0], entries[1], entries[2]]);
		});

		test("? matches exactly one character and is anchored at both ends", () => {
			const entries = [
				entry({ name: "foo1" }),
				entry({ name: "foo" }),
				entry({ name: "foo12" }),
				entry({ name: "xfoo1" }),
				entry({ name: "foox" }),
			];
			expect(matchSelector(entries, "foo?")).toEqual([entries[0], entries[4]]);
			expect(matchSelector(entries, "f??")).toEqual([entries[1]]);
			expect(matchSelector(entries, "?oo1")).toEqual([entries[0]]);
		});

		test("regex-special characters in names are treated literally", () => {
			const dot = entry({ name: "a.b" });
			const dash = entry({ name: "a-b" });
			expect(matchSelector([dot, dash], "a.b")).toEqual([dot]); // '.' literal, not wildcard
			expect(matchSelector([dot, dash], "a?b")).toEqual([dot, dash]);
			expect(matchSelector([dot, dash], "a*b")).toEqual([dot, dash]);
			expect(matchSelector([dash], "a.b")).toEqual([]);

			const plus = entry({ name: "c++" });
			expect(matchSelector([plus], "c++")).toEqual([plus]);
			expect(matchSelector([plus], "c+")).toEqual([]);
		});

		test("unknown selector forms fall through to a name glob", () => {
			const web = entry({ name: "web" });
			const api = entry({ name: "api" });
			expect(matchSelector([web, api], "web")).toEqual([web]); // no wildcards = exact name
			expect(matchSelector([web, api], "w*")).toEqual([web]);
			expect(matchSelector([web, api], "???")).toEqual([web, api]);
			expect(matchSelector([web, api], "some unknown form")).toEqual([]);
		});
	});

	describe("no match", () => {
		test("returns an empty array (not an error)", () => {
			const a = entry({ name: "web", project: "frontend" });
			expect(matchSelector([a], "d99")).toEqual([]);
			expect(matchSelector([a], "project:backend")).toEqual([]);
			expect(matchSelector([a], "nope*")).toEqual([]);
			expect(matchSelector([], "web")).toEqual([]);
		});
	});
});
