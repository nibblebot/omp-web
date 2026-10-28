/** ReactiveMap: written in place, read per key or as a whole, each write waking only the readers it can affect. */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as solid from "solid-js";
import type * as ReactiveMapModule from "../subagents/reactive-map";

// bun resolves "solid-js" to its SSR build (signals never notify); mock the client build for this suite.
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const originalSolid = { ...solid };

let ReactiveMap: typeof ReactiveMapModule.ReactiveMap;
let createRoot: typeof solid.createRoot;
let createEffect: typeof solid.createEffect;

beforeAll(async () => {
	const clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	createRoot = clientSolid.createRoot;
	createEffect = clientSolid.createEffect;
	const path: string = "../subagents/reactive-map.ts?fresh=reactive-map-test";
	({ ReactiveMap } = await import(path));
});

afterAll(() => {
	mock.module("solid-js", () => originalSolid);
});

function track(read: () => unknown): { runs: () => number; stop: () => void } {
	let runs = 0;
	let stop!: () => void;
	createRoot((dispose) => {
		stop = dispose;
		createEffect(() => {
			runs += 1;
			read();
		});
	});
	return { runs: () => runs, stop };
}

describe("ReactiveMap", () => {
	test("behaves as a Map", () => {
		const map = ReactiveMap.from([
			["a", 1],
			["b", 2],
		]);
		map.set("c", 3);
		map.delete("a");
		expect(map.size).toBe(2);
		expect([...map]).toEqual([
			["b", 2],
			["c", 3],
		]);
		expect(new Map(map).get("c")).toBe(3);
		map.clear();
		expect(map.size).toBe(0);
	});

	test("a write wakes the readers of that key and of the whole map, not of other keys", () => {
		const map = ReactiveMap.from([
			["a", 1],
			["b", 1],
		]);
		const a = track(() => map.get("a"));
		const b = track(() => map.get("b"));
		const all = track(() => [...map.values()]);
		const size = track(() => map.size);
		map.set("a", 2);
		expect([a.runs(), b.runs(), all.runs(), size.runs()]).toEqual([2, 1, 2, 2]);
		map.set("a", 2);
		expect(a.runs()).toBe(2);
		a.stop();
		b.stop();
		all.stop();
		size.stop();
	});

	test("a key read before it exists wakes when it appears and when it goes", () => {
		const map = new ReactiveMap<string, number>();
		const seen: Array<number | undefined> = [];
		const reader = track(() => seen.push(map.get("late")));
		map.set("late", 1);
		map.delete("late");
		expect(seen).toEqual([undefined, 1, undefined]);
		reader.stop();
	});
});
