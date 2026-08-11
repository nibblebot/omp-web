/**
 * Tests for fleet selector resolution (fleet/selectors.ts).
 *
 * Pure and hermetic: entries are constructed inline against the DaemonEntry
 * shape from src/protocol.ts (plus the RegistryEntry-only `registeredAt`
 * field) instead of importing ./registry, so this suite runs standalone
 * before the registry slice lands.
 */

import { describe, expect, test } from "bun:test";
import type { DaemonEntry } from "../src/protocol";
import { matchSelector } from "./selectors";

type RegistryEntryShape = DaemonEntry & { registeredAt: number };

let nextId = 0;

/** Build a RegistryEntry-shaped literal with sane defaults. */
function entry(overrides: Partial<RegistryEntryShape> = {}): RegistryEntryShape {
	const daemonId = overrides.daemonId ?? `d${++nextId}`;
	return {
		daemonId,
		name: daemonId,
		cwd: `/home/user/${daemonId}`,
		project: "root",
		labels: [],
		mode: "attached",
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

		test("returns a fresh array (caller may mutate)", () => {
			const entries = [entry({ name: "web" })];
			const result = matchSelector(entries, "all");
			expect(result).not.toBe(entries);
		});

		test("empty registry yields empty result", () => {
			expect(matchSelector([], "all")).toEqual([]);
		});
	});

	describe("bare daemonId", () => {
		test("matches exactly", () => {
			const a = entry({ name: "web" });
			const b = entry({ name: "api" });
			expect(matchSelector([a, b], a.daemonId)).toEqual([a]);
			expect(matchSelector([a, b], "d999")).toEqual([]);
		});

		test("exact daemonId wins over glob interpretation of the name", () => {
			const byId = entry({ daemonId: "d3", name: "web" });
			const byName = entry({ daemonId: "d1", name: "d3" });
			expect(matchSelector([byId, byName], "d3")).toEqual([byId]);
		});
	});

	describe("label:k=v / tag:k=v", () => {
		test("matches entries carrying that exact label", () => {
			const prod = entry({ labels: ["env=prod", "team=core"] });
			const dev = entry({ labels: ["env=dev"] });
			expect(matchSelector([prod, dev], "label:env=prod")).toEqual([prod]);
			expect(matchSelector([prod, dev], "label:env=dev")).toEqual([dev]);
			expect(matchSelector([prod, dev], "label:team=core")).toEqual([prod]);
		});

		test("tag is an alias for label", () => {
			const prod = entry({ labels: ["env=prod"] });
			const bare = entry({ labels: [] });
			expect(matchSelector([prod, bare], "tag:env=prod")).toEqual([prod]);
		});

		test("label values are matched literally, not as globs", () => {
			const star = entry({ labels: ["env=pr*"] });
			const prod = entry({ labels: ["env=prod"] });
			expect(matchSelector([star, prod], "label:env=pr*")).toEqual([star]);
			expect(matchSelector([star, prod], "label:env=pr?")).toEqual([]);
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
			const entries = [entry({ name: "web" }), entry({ name: "a.b" }), entry({ name: "x?y" }), entry({ name: "" })];
			expect(matchSelector(entries, "*")).toEqual(entries);
		});

		test("* matches any run, including empty", () => {
			const entries = [entry({ name: "fo" }), entry({ name: "foo" }), entry({ name: "f123o" }), entry({ name: "bar" })];
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
			const a = entry({ name: "web", labels: ["env=prod"], project: "frontend" });
			expect(matchSelector([a], "d99")).toEqual([]);
			expect(matchSelector([a], "label:env=dev")).toEqual([]);
			expect(matchSelector([a], "tag:env=dev")).toEqual([]);
			expect(matchSelector([a], "project:backend")).toEqual([]);
			expect(matchSelector([a], "nope*")).toEqual([]);
			expect(matchSelector([], "web")).toEqual([]);
		});
	});
});
