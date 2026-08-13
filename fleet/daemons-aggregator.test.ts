/**
 * Aggregated daemons panel (Phase 4/5): pure merge/cache semantics of
 * fleet/daemons-aggregator.ts — cross-daemon merging keyed by
 * `${projectDir}\u0000${name}`, same-projectDir preference, latest-wins
 * tie-breaks, full-replace ingest, and removal eviction. The browser-facing
 * integration (broadcast on update/open, pipe stripping, registry-removal
 * eviction broadcast) lives in edge.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { DaemonInfo } from "../shared/protocol";
import { daemonsKey, DaemonsAggregator, mergeDaemonRosters, type DaemonRosterSource } from "./daemons-aggregator";

function info(name: string, projectDir: string, overrides: Partial<DaemonInfo> = {}): DaemonInfo {
	return {
		name,
		id: `${projectDir}/${name}`,
		projectDir,
		state: "running",
		createdAt: 1,
		startedAt: 1,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...overrides,
	};
}

function source(cwd: string | undefined, at: number, ...entries: DaemonInfo[]): DaemonRosterSource {
	return { cwd, at, entries };
}

describe("daemonsKey", () => {
	test("joins projectDir and name with the client's NUL separator", () => {
		expect(daemonsKey(info("hub", "/a/b"))).toBe("/a/b\u0000hub");
	});
});

describe("mergeDaemonRosters", () => {
	test("empty sources merge to an empty list", () => {
		expect(mergeDaemonRosters(new Map())).toEqual([]);
	});

	test("disjoint rosters are unioned across daemons", () => {
		const merged = mergeDaemonRosters(
			new Map([
				["d1", source("/a", 10, info("hub-a", "/a", { pid: 1 }), info("x", "/a", { pid: 2 }))],
				["d2", source("/b", 20, info("hub-b", "/b", { pid: 3 }))],
			]),
		);
		expect(merged.map((d) => d.name).sort()).toEqual(["hub-a", "hub-b", "x"]);
	});

	test("same key prefers the daemon whose cwd equals the projectDir over a newer arrival", () => {
		const merged = mergeDaemonRosters(
			new Map([
				// d1 owns /a: its "shared" is older but authoritative.
				["d1", source("/a", 10, info("shared", "/a", { pid: 111 }))],
				// d2 (cwd /b) reports the same key later — recency loses.
				["d2", source("/b", 20, info("shared", "/a", { pid: 222 }))],
			]),
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].pid).toBe(111);
	});

	test("two daemons sharing a projectDir: latest arrival among owners wins", () => {
		const merged = mergeDaemonRosters(
			new Map([
				["d1", source("/a", 10, info("shared", "/a", { pid: 111 }))],
				["d2", source("/a", 30, info("shared", "/a", { pid: 333 }))],
			]),
		);
		expect(merged[0].pid).toBe(333);
	});

	test("no daemon owns the projectDir: latest arrival wins", () => {
		const merged = mergeDaemonRosters(
			new Map([
				["d1", source("/a", 10, info("shared", "/z", { pid: 111 }))],
				["d2", source("/b", 20, info("shared", "/z", { pid: 222 }))],
			]),
		);
		expect(merged[0].pid).toBe(222);
	});

	test("duplicate keys within one daemon's roster: the later entry wins", () => {
		const merged = mergeDaemonRosters(
			new Map([["d1", source("/a", 10, info("shared", "/a", { pid: 111 }), info("shared", "/a", { pid: 222 }))]]),
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].pid).toBe(222);
	});

	test("an owner beats a non-owner even when the non-owner arrived after the owner left", () => {
		const merged = mergeDaemonRosters(
			new Map([
				["d1", source("/a", 5, info("shared", "/a", { pid: 111 }))],
				["d2", source("/b", 9, info("shared", "/a", { pid: 222 }))],
				["d3", source("/a", 3, info("shared", "/a", { pid: 333 }))],
			]),
		);
		// Two owners (/a): d1 arrived latest among them.
		expect(merged[0].pid).toBe(111);
	});
});

describe("DaemonsAggregator", () => {
	test("ingest is full-replace per daemon: dropped entries disappear from the merge", () => {
		const agg = new DaemonsAggregator();
		agg.ingest("d1", [info("a", "/a"), info("b", "/a")], "/a", 10);
		agg.ingest("d2", [info("c", "/b")], "/b", 20);
		expect(agg.merge().map((d) => d.name).sort()).toEqual(["a", "b", "c"]);
		// d1's next frame drops "b".
		agg.ingest("d1", [info("a", "/a")], "/a", 30);
		expect(agg.merge().map((d) => d.name).sort()).toEqual(["a", "c"]);
	});

	test("remove evicts a daemon's cached roster", () => {
		const agg = new DaemonsAggregator();
		agg.ingest("d1", [info("a", "/a")], "/a", 10);
		agg.ingest("d2", [info("c", "/b")], "/b", 20);
		agg.remove("d1");
		expect(agg.merge().map((d) => d.name)).toEqual(["c"]);
		agg.remove("d2");
		expect(agg.merge()).toEqual([]);
	});
});
