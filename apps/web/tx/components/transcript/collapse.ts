/**
 * Per-card collapse + <details> toggle state for the transcript view.
 *
 * Card collapse is keyed by entry id; individual <details> elements are
 * keyed by `${entryId}:${purpose}`. Manual <details> toggles live apart from
 * the expand/collapse-all default and page-appends NEVER touch them; only an
 * explicit expand/collapse-all click clears them, so loading the next page
 * cannot clobber a toggle the user set by hand (audit Phase 3 finding).
 *
 * Every id/key owns its own signal, created on first read: toggling one card or
 * one <details> wakes only that row, not every row loaded.
 */
import { batch, createContext, createSignal, useContext, type Signal } from "solid-js";
import type { RawEntry } from "../../../store/fleet-api";
import { str } from "../../util/entries";

/** What rows need from the collapse store (provided via context by TranscriptView). */
export interface RowState {
	collapsed: (id: string) => boolean;
	toggle: (id: string) => void;
	detailsOpen: (key: string) => boolean;
	setDetailsOpen: (key: string, open: boolean) => void;
}

export const RowStateCtx = createContext<RowState>();

/** Card-level collapse wiring for one row: id from entry, reactive getter + header toggle. */
export function useRowCollapse(entry: RawEntry) {
	const ctx = useContext(RowStateCtx);
	const id = str(entry.id);
	return {
		collapsed: () => (id !== "" ? (ctx?.collapsed(id) ?? false) : false),
		toggle: () => {
			if (id !== "") ctx?.toggle(id);
		},
	};
}

export interface CollapseStore {
	/** Context value rows read through. */
	ctx: RowState;
	expandEverything: () => void;
	collapseEverything: (ids: string[]) => void;
	/** Full state reset (file switch). */
	reset: () => void;
}

/** A value with a lazily created signal per key; `set` wakes only that key's readers. */
function createKeyedSignals<V>(initial: V) {
	const values = new Map<string, V>();
	const signals = new Map<string, Signal<V>>();
	return {
		get(key: string): V {
			let sig = signals.get(key);
			if (sig === undefined) {
				sig = createSignal<V>(values.get(key) ?? initial, { equals: false });
				signals.set(key, sig);
			}
			return sig[0]();
		},
		set(key: string, value: V): void {
			if (value === initial) values.delete(key);
			else values.set(key, value);
			const sig = signals.get(key);
			if (sig !== undefined) sig[1](() => value);
		},
		/** Back to `initial` everywhere; wakes only keys that held something else. */
		clear(except?: ReadonlySet<string>): void {
			batch(() => {
				for (const key of [...values.keys()]) if (!except?.has(key)) this.set(key, initial);
			});
		},
		has: (key: string) => values.has(key),
	};
}

export function createCollapseStore(): CollapseStore {
	const collapsedIds = createKeyedSignals<boolean>(false);
	/** Manual <details> toggles; undefined = follow expandAll. */
	const manual = createKeyedSignals<boolean | undefined>(undefined);
	/** null = untouched (per-details defaults); true/false = force every <details> not toggled by hand. */
	const [expandAll, setExpandAll] = createSignal<boolean | null>(null);

	const ctx: RowState = {
		collapsed: (id) => collapsedIds.get(id),
		toggle: (id) => collapsedIds.set(id, !collapsedIds.has(id)),
		detailsOpen: (key) => {
			const m = manual.get(key);
			if (m !== undefined) return m;
			// RAW JSON is opt-in per entry; expand-all opens the formatted content only.
			if (key.endsWith(":raw")) return false;
			return expandAll() ?? false;
		},
		setDetailsOpen: (key, open) => manual.set(key, open),
	};

	const expandEverything = () => {
		batch(() => {
			collapsedIds.clear();
			manual.clear();
			setExpandAll(true);
		});
	};
	const collapseEverything = (ids: string[]) => {
		batch(() => {
			const keep = new Set(ids.filter((id) => id !== ""));
			collapsedIds.clear(keep);
			for (const id of keep) if (!collapsedIds.has(id)) collapsedIds.set(id, true);
			manual.clear();
			setExpandAll(false);
		});
	};
	const reset = () => {
		batch(() => {
			collapsedIds.clear();
			manual.clear();
			setExpandAll(null);
		});
	};

	return { ctx, expandEverything, collapseEverything, reset };
}
