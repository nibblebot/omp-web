import { createMemo, type Accessor } from "solid-js";

const sameIds = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Rows for a `<For each={ids()}>` that survive their source being rebuilt. A poll, a forest rebuild or a
 * roster frame hands over new row objects every time; iterating the objects would remount every row, which
 * drops keyboard focus, flickers hover and resets per-row state. `ids` changes only when the id list does;
 * `row(id)` is that row's live accessor, holding its last value after the row leaves the source.
 */
export function createKeyedRows<T>(
	rows: Accessor<readonly T[]>,
	keyOf: (row: T) => string,
): { ids: Accessor<string[]>; row: (id: string) => Accessor<T> } {
	const ids = createMemo(() => rows().map(keyOf), [], { equals: sameIds });
	const byId = createMemo(() => new Map(rows().map((row) => [keyOf(row), row])));
	return {
		ids,
		row: (id) => {
			let last = byId().get(id) as T;
			return () => (last = byId().get(id) ?? last);
		},
	};
}
