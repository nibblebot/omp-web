import { describe, expect, test } from "bun:test";
import {
	finishRowExit,
	initialRowSlots,
	reconcileRowSlots,
	type RowSlot,
} from "../../fleet-ui/row-presence";

interface Row {
	daemonId: string;
	n?: number;
}
const idOf = (r: Row) => r.daemonId;
const rows = (...ids: string[]): Row[] => ids.map((daemonId) => ({ daemonId }));
const summary = (slots: RowSlot<Row>[]) => slots.map((s) => `${s.id}:${s.mode}`);

describe("row presence", () => {
	test("the first render seeds every row as open: nothing enters", () => {
		expect(summary(initialRowSlots(rows("a", "b", "c"), idOf))).toEqual([
			"a:open",
			"b:open",
			"c:open",
		]);
	});

	test("a roster refresh with the same ids animates nothing", () => {
		const first = initialRowSlots(rows("a", "b"), idOf);
		const next = reconcileRowSlots(first, [{ daemonId: "a", n: 1 }, ...rows("b")], idOf, true);
		expect(summary(next)).toEqual(["a:open", "b:open"]);
	});

	test("only an id not rendered before enters, in the live order", () => {
		const first = initialRowSlots(rows("a", "c"), idOf);
		const next = reconcileRowSlots(first, rows("a", "b", "c"), idOf, true);
		expect(summary(next)).toEqual(["a:open", "b:enter", "c:open"]);
	});

	test("an entering row stays entering across a status refresh", () => {
		const entered = reconcileRowSlots(initialRowSlots(rows("a"), idOf), rows("a", "b"), idOf, true);
		const refreshed = reconcileRowSlots(entered, rows("a", "b"), idOf, true);
		expect(summary(refreshed)).toEqual(["a:open", "b:enter"]);
	});

	test("a removed row exits in place, keeping its last item, until the exit finishes", () => {
		const first = initialRowSlots([{ daemonId: "a" }, { daemonId: "b", n: 7 }, ...rows("c")], idOf);
		const exiting = reconcileRowSlots(first, rows("a", "c"), idOf, true);
		expect(summary(exiting)).toEqual(["a:open", "b:exit", "c:open"]);
		expect(exiting[1]!.item.n).toBe(7);
		// Another roster frame mid-exit keeps it where it is.
		const again = reconcileRowSlots(exiting, rows("a", "c", "d"), idOf, true);
		expect(summary(again)).toEqual(["a:open", "b:exit", "c:open", "d:enter"]);
		expect(summary(finishRowExit(again, "b"))).toEqual(["a:open", "c:open", "d:enter"]);
	});

	test("an exiting first row stays first; several exiting rows keep their order", () => {
		const first = initialRowSlots(rows("a", "b", "c", "d"), idOf);
		const exiting = reconcileRowSlots(first, rows("d"), idOf, true);
		expect(summary(exiting)).toEqual(["a:exit", "b:exit", "c:exit", "d:open"]);
	});

	test("a row re-added during its exit returns to open without remounting", () => {
		const first = initialRowSlots(rows("a", "b"), idOf);
		const exiting = reconcileRowSlots(first, rows("a"), idOf, true);
		const back = reconcileRowSlots(exiting, rows("a", "b"), idOf, true);
		expect(summary(back)).toEqual(["a:open", "b:open"]);
		// A late exit-finished report for the reopened row must not drop it.
		expect(summary(finishRowExit(back, "b"))).toEqual(["a:open", "b:open"]);
	});

	test("an id re-added after its exit finished enters again", () => {
		const exiting = reconcileRowSlots(initialRowSlots(rows("a", "b"), idOf), rows("a"), idOf, true);
		const gone = finishRowExit(exiting, "b");
		expect(summary(reconcileRowSlots(gone, rows("a", "b"), idOf, true))).toEqual([
			"a:open",
			"b:enter",
		]);
	});

	test("a collapsed group animates nothing: rows settle and exits are dropped", () => {
		const first = initialRowSlots(rows("a", "b"), idOf);
		expect(summary(reconcileRowSlots(first, rows("a", "b", "c"), idOf, false))).toEqual([
			"a:open",
			"b:open",
			"c:open",
		]);
		const exiting = reconcileRowSlots(first, rows("a"), idOf, true);
		expect(summary(reconcileRowSlots(exiting, rows("a"), idOf, false))).toEqual(["a:open"]);
	});
});
