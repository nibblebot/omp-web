/**
 * Per-card collapse + <details> toggle state for the transcript view.
 *
 * Card collapse is keyed by entry id; individual <details> elements are
 * keyed by `${entryId}:${purpose}`. Manual <details> toggles live in a
 * manual map that page-appends NEVER touch — only an explicit
 * expand/collapse-all click clears it — so loading the next page cannot
 * clobber a toggle the user set by hand (audit Phase 3 finding).
 */
import { createContext, createSignal, useContext } from "solid-js";
import type { RawEntry } from "../../api";
import { str } from "../../util/entries";

export interface DetailsState {
	/** Manual toggles by stable details key (`${entryId}:${purpose}`). */
	manual: Readonly<Record<string, boolean>>;
	/** null = untouched (per-details defaults); true/false = force every <details>. */
	expandAll: boolean | null;
}

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
	/** Signals, exposed for remeasure effects and unit tests. */
	collapsedIds: () => ReadonlySet<string>;
	details: () => DetailsState;
}

export function createCollapseStore(): CollapseStore {
	const [collapsedIds, setCollapsedIds] = createSignal<ReadonlySet<string>>(new Set<string>());
	const [details, setDetails] = createSignal<DetailsState>({ manual: {}, expandAll: null });

	const ctx: RowState = {
		collapsed: (id) => collapsedIds().has(id),
		toggle: (id) =>
			setCollapsedIds((prev) => {
				const next = new Set(prev);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				return next;
			}),
		detailsOpen: (key) => {
			const st = details();
			const manual = st.manual[key];
			if (manual !== undefined) return manual;
			return st.expandAll ?? false;
		},
		setDetailsOpen: (key, open) =>
			setDetails((prev) => ({
				expandAll: prev.expandAll,
				manual: { ...prev.manual, [key]: open },
			})),
	};

	const expandEverything = () => {
		setCollapsedIds(new Set<string>());
		setDetails({ manual: {}, expandAll: true });
	};
	const collapseEverything = (ids: string[]) => {
		setCollapsedIds(new Set(ids.filter((id) => id !== "")));
		setDetails({ manual: {}, expandAll: false });
	};
	const reset = () => {
		setCollapsedIds(new Set<string>());
		setDetails({ manual: {}, expandAll: null });
	};

	return { ctx, expandEverything, collapseEverything, reset, collapsedIds, details };
}
