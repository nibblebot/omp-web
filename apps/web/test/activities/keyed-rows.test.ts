/**
 * The popovers' rows survive their source being rebuilt: a poll or roster frame re-emits every row as a new
 * object, and the id list (what `<For>` iterates) must not change for it, or every row remounts and drops
 * keyboard focus and per-row state.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as solid from "solid-js";
import type * as KeyedRowsModule from "../../activities/keyed-rows";

// bun resolves "solid-js" to its SSR build (signals never notify); the client build gives the memos a live
// reactive scope. Same technique as motion/presence.test.ts: mock it for this suite, restore afterwards.
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const originalSolid = { ...solid };

let createKeyedRows: typeof KeyedRowsModule.createKeyedRows;
let createRoot: typeof solid.createRoot;
let createSignal: typeof solid.createSignal;

beforeAll(async () => {
	const clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	createRoot = clientSolid.createRoot;
	createSignal = clientSolid.createSignal;
	// Dynamic import: the module must load after the solid-js mock; the query bypasses the cached SSR copy.
	const path: string = "../../activities/keyed-rows.ts?fresh=keyed-rows-test";
	({ createKeyedRows } = await import(path));
});

afterAll(() => {
	mock.module("solid-js", () => originalSolid);
});

interface Row {
	id: string;
	label: string;
}

describe("createKeyedRows", () => {
	test("re-emitting the same ids as new objects keeps the id list and updates the row", () => {
		createRoot((dispose) => {
			const [rows, setRows] = createSignal<readonly Row[]>([
				{ id: "a", label: "one" },
				{ id: "b", label: "two" },
			]);
			const keyed = createKeyedRows(rows, (row: Row) => row.id);
			const ids = keyed.ids();
			const a = keyed.row("a");
			expect(a().label).toBe("one");

			setRows([
				{ id: "a", label: "one, later" },
				{ id: "b", label: "two" },
			]);
			expect(keyed.ids()).toBe(ids);
			expect(a().label).toBe("one, later");
			dispose();
		});
	});

	test("adding or reordering a row changes the id list", () => {
		createRoot((dispose) => {
			const [rows, setRows] = createSignal<readonly Row[]>([{ id: "a", label: "A" }]);
			const keyed = createKeyedRows(rows, (row: Row) => row.id);
			setRows([
				{ id: "b", label: "B" },
				{ id: "a", label: "A" },
			]);
			expect(keyed.ids()).toEqual(["b", "a"]);
			dispose();
		});
	});

	test("a row that left the source keeps its last value", () => {
		createRoot((dispose) => {
			const [rows, setRows] = createSignal<readonly Row[]>([
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			]);
			const keyed = createKeyedRows(rows, (row: Row) => row.id);
			const b = keyed.row("b");
			setRows([{ id: "a", label: "A" }]);
			expect(keyed.ids()).toEqual(["a"]);
			expect(b().label).toBe("B");
			dispose();
		});
	});
});
