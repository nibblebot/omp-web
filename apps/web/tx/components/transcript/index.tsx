/**
 * TranscriptView: paging controller + tool-call pairing + row rendering for one
 * session transcript (main session or a subagent's).
 *
 * - Paging: pages of PAGE_SIZE are fetched automatically as the user scrolls
 *   near the end of the loaded window (no load-more button); the viewport is
 *   topped up after each successful load.
 * - Rendering: every loaded row is plain flow content (no virtualizer; rows
 *   have variable height). Long transcripts stay cheap because .transcript-list
 *   rows use content-visibility, and rows are keyed by entry identity so a page
 *   append, filter change or live reload never rebuilds a row that is still shown.
 * - Pairing: tool-call pairing maps are computed once per entries change over
 *   ALL loaded entries (pairing.ts); toolResults pair with their call's
 *   execution start across page boundaries; calls with a start but no result
 *   yet in the loaded range show a "pending…" badge.
 * - The ?tool= filter applies ONLY to the main-session view; subagent
 *   transcripts ignore it (and clear it).
 * - Load errors show "Failed to load transcript" + Retry, re-fetching the
 *   current window from inside this controller.
 */
import {
	For,
	Show,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	onMount,
} from "solid-js";
import type { RawEntry } from "../../../store/fleet-api";
import { api, type TranscriptPage } from "../../../store/fleet-api";
import { basename } from "../../util/format";
import {
	contentBlocks,
	isMessage,
	messageRole,
	reuseEqualEntries,
	searchTextOf,
	str,
	toolCallIdOf,
} from "../../util/entries";
import { createCollapseStore, RowStateCtx } from "./collapse";
import { buildDayRows, createRowCache } from "./day-rows";
import { createPairingMaps } from "./pairing";
import { TranscriptEntryRow } from "./rows/entry-row";
import { ArrowLeftIcon } from "../../../components/ui/icons";

const PAGE_SIZE = 200;

/** Pause after the last keystroke before the find box filters the transcript. */
const FIND_DEBOUNCE_MS = 150;

export interface TranscriptProps {
	file: string;
	/** true when showing a subagent's transcript instead of the main session's */
	isSub: boolean;
	onBackToMain: () => void;
	/** tool names available for the filter dropdown */
	tools: () => string[];
	toolFilter: string | null;
	onToolFilter: (name: string | null) => void;
	/** Live tick (session running in Chat): re-read the last loaded page. */
	liveTick?: () => number;
}

/** ?tool= + hide-system filtering; only the main-session view ever filters. */
export function filterTranscriptEntries(
	all: readonly RawEntry[],
	toolFilter: string | null,
	hideSystem: boolean,
): RawEntry[] {
	const base = hideSystem ? all.filter(isMessage) : all;
	if (!toolFilter) return [...base];
	const keptCalls = new Set<string>();
	const out: RawEntry[] = [];
	for (const e of base) {
		if (isMessage(e) && messageRole(e) === "assistant") {
			const blocks = contentBlocks(e);
			const match = blocks.some((b) => b.type === "toolCall" && b.name === toolFilter);
			if (!match) continue;
			for (const b of blocks)
				if (b.type === "toolCall" && typeof b.id === "string") keptCalls.add(b.id);
			out.push(e);
		} else if (isMessage(e) && messageRole(e) === "toolResult") {
			const id = toolCallIdOf(e);
			if (id && keptCalls.has(id)) out.push(e);
		}
	}
	return out;
}

export interface LastPageMeta {
	/** Raw line count reported by the transcript API (includes corrupt lines). */
	totalLines: number;
}

/** "M" in the "N of M entries" progress label. */
export function progressTotal(p: LastPageMeta | null, loaded: number): number {
	if (p === null) return loaded;
	return p.totalLines;
}

export function TranscriptView(props: TranscriptProps) {
	const [entries, setEntries] = createSignal<RawEntry[]>([]);
	const [nextOffset, setNextOffset] = createSignal<number | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [loadErr, setLoadErr] = createSignal<string | null>(null);
	const [hideSystem, setHideSystem] = createSignal(true);
	/** The find text the transcript is filtered by; follows the input after FIND_DEBOUNCE_MS. */
	const [find, setFind] = createSignal("");
	let findTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(findTimer));
	const onFindInput = (value: string) => {
		clearTimeout(findTimer);
		findTimer = setTimeout(() => setFind(value), FIND_DEBOUNCE_MS);
	};
	const [lastPage, setLastPage] = createSignal<LastPageMeta | null>(null);
	const [failedOffset, setFailedOffset] = createSignal<number | null>(null);

	const store = createCollapseStore();
	const pairing = createPairingMaps(entries);

	let seq = 0;
	let listRef: HTMLDivElement | undefined;
	/** The last page fetched (its offset and entry count): the only lines a live tail can still change. */
	let tail: { offset: number; count: number } | null = null;
	/** A tail refresh is in flight. */
	let refreshing = false;

	const loadPage = async (offset: number | null) => {
		const my = ++seq;
		setLoading(true);
		setLoadErr(null);
		try {
			const page = await api.transcript(props.file, offset, PAGE_SIZE);
			if (my !== seq) return; // stale response after a file switch
			tail = { offset: page.offset, count: page.entries.length };
			setEntries((prev) => (offset === null ? page.entries : [...prev, ...page.entries]));
			setNextOffset(page.nextOffset);
			setLastPage({ totalLines: page.totalLines });
		} catch (e) {
			if (my !== seq) return;
			setFailedOffset(offset);
			setLoadErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (my === seq) setLoading(false);
		}
	};

	const retry = () => {
		if (loadErr() !== null) void loadPage(failedOffset());
	};

	// Reload whenever the target file changes (session or subagent switch).
	createEffect(() => {
		props.file; // reactive trigger
		seq += 1;
		tail = null;
		setEntries([]);
		setNextOffset(null);
		setLoadErr(null);
		setLastPage(null);
		setFailedOffset(null);
		store.reset();
		queueMicrotask(() => {
			const el = listRef?.closest(".tx-main");
			if (el) el.scrollTop = 0;
		});
		void loadPage(null);
	});

	/**
	 * Live tail: re-read the last loaded page and splice it in. Lines before it are
	 * immutable, so nothing earlier is fetched; when the loaded window does not reach
	 * EOF the new lines arrive through normal paging.
	 */
	const reloadTail = async () => {
		const at = tail;
		if (at === null || nextOffset() !== null || refreshing) return;
		const gen = seq;
		refreshing = true;
		try {
			const page = await api.transcript(props.file, at.offset, PAGE_SIZE);
			if (gen !== seq) return;
			const prev = entries();
			const keep = prev.length - at.count;
			const old = prev.slice(keep);
			const fresh = reuseEqualEntries(old, page.entries);
			tail = { offset: page.offset, count: fresh.length };
			setNextOffset(page.nextOffset);
			setLastPage({ totalLines: page.totalLines });
			if (fresh.length !== old.length || fresh.some((e, i) => e !== old[i])) {
				setEntries([...prev.slice(0, keep), ...fresh]);
			} else if (page.nextOffset !== null) queueMicrotask(maybeLoadMore);
		} catch {
			// Keep the last good render; the next tick retries.
		} finally {
			refreshing = false;
		}
	};
	createEffect(
		on(
			() => props.liveTick?.() ?? 0,
			() => {
				if (!props.isSub && !loading()) void reloadTail();
			},
			{ defer: true },
		),
	);

	onCleanup(() => {
		seq += 1;
	});

	// Tool filter never leaks into subagent transcripts: clear it, and don't apply it.
	createEffect(() => {
		if (props.isSub && props.toolFilter !== null) props.onToolFilter(null);
	});

	/** Main-view ?tool= and hide-system filters. */
	const filtered = createMemo(() =>
		filterTranscriptEntries(entries(), props.isSub ? null : props.toolFilter, hideSystem()),
	);
	/** The find box narrows the filtered entries (both views); each entry's search text is built once. */
	const visible = createMemo(() => {
		const base = filtered();
		const needle = find().trim().toLowerCase();
		if (needle === "") return base;
		return base.filter((e) => searchTextOf(e).includes(needle));
	});
	/** System entries the hide-system default conceals in the main view. */
	const hiddenCount = createMemo(() =>
		hideSystem() && !props.isSub ? entries().filter((e) => !isMessage(e)).length : 0,
	);

	/** Rows: filtered entries plus day-group separators. */
	const rowCache = createRowCache();
	const rows = createMemo(() => buildDayRows(visible(), rowCache));

	/** The transcript may sit in a CSS-hidden tab (TranscriptDetail keeps tabs mounted). */
	const transcriptVisible = () => {
		const el = listRef;
		return el !== undefined && el.getBoundingClientRect().height > 0;
	};

	const maybeLoadMore = () => {
		if (loading() || refreshing || loadErr() !== null || !transcriptVisible()) return;
		const n = nextOffset();
		if (n === null) return;
		const el = listRef?.closest(".tx-main");
		if (!el) return;
		if (el.scrollHeight - el.scrollTop <= el.clientHeight + 400) void loadPage(n);
	};

	onMount(() => {
		const el = listRef?.closest(".tx-main");
		el?.addEventListener("scroll", maybeLoadMore);
		onCleanup(() => el?.removeEventListener("scroll", maybeLoadMore));
		// Tab reveal (hidden → visible) re-arms paging.
		const list = listRef;
		if (list && typeof ResizeObserver === "function") {
			const ro = new ResizeObserver(() => {
				if (list.getBoundingClientRect().height <= 0) return;
				maybeLoadMore();
			});
			ro.observe(list);
			onCleanup(() => ro.disconnect());
		}
	});

	// Top up the viewport after each successful load (or filter change).
	createEffect(() => {
		void entries().length;
		void visible().length;
		if (entries().length > 0) queueMicrotask(maybeLoadMore);
	});

	const progressM = () => progressTotal(lastPage(), entries().length);

	return (
		<RowStateCtx.Provider value={store.ctx}>
			<div class="transcript">
				<div class="transcript-toolbar">
					<Show when={props.isSub}>
						<button class="btn" onClick={props.onBackToMain}>
							<ArrowLeftIcon /> back to main
						</button>
						<span class="sub-tag">subagent transcript · {basename(props.file)}</span>
					</Show>
					<Show when={!props.isSub}>
						<label class="tool-filter">
							<span>Tool filter</span>
							<select
								value={props.toolFilter ?? ""}
								onChange={(e) => props.onToolFilter(e.currentTarget.value || null)}
							>
								<option value="">All tools</option>
								<For each={props.tools()}>{(t) => <option value={t}>{t}</option>}</For>
							</select>
						</label>
						<Show when={props.toolFilter !== null}>
							<button class="btn btn-small" onClick={() => props.onToolFilter(null)}>
								clear filter
							</button>
						</Show>
					</Show>
					<input
						type="search"
						class="tx-find"
						aria-label="Find in transcript"
						placeholder="Find in transcript"
						onInput={(e) => onFindInput(e.currentTarget.value)}
					/>
					<button class="btn btn-small" onClick={store.expandEverything}>
						expand all
					</button>
					<button
						class="btn btn-small"
						onClick={() => store.collapseEverything(visible().map((e) => str(e.id)))}
					>
						collapse all
					</button>
					<label class="tool-filter">
						<input
							type="checkbox"
							checked={hideSystem()}
							onChange={(e) => setHideSystem(e.currentTarget.checked)}
						/>
						<span>hide system entries</span>
					</label>
					<span class="entry-count">
						{visible().length} of {progressM()} {progressM() === 1 ? "entry" : "entries"}
					</span>
				</div>
				<Show when={hiddenCount() > 0}>
					<div class="tx-hidden-row">
						<span>
							{hiddenCount()} system {hiddenCount() === 1 ? "entry" : "entries"} hidden
						</span>
						<button class="btn btn-small" onClick={() => setHideSystem(false)}>
							show
						</button>
					</div>
				</Show>
				<Show when={loadErr()}>
					{(err) => (
						<div class="tx-error-banner">
							<span>Failed to load transcript{err() !== "" ? `: ${err()}` : ""}</span>
							<button class="btn btn-small" onClick={retry} disabled={loading()}>
								Retry
							</button>
						</div>
					)}
				</Show>
				<div class="transcript-list" ref={listRef}>
					<For each={rows()}>
						{(row) => (
							<div class="transcript-vrow" data-kind={row.kind}>
								{row.kind === "day" ? (
									<div class="day-sep">
										<span>{row.label}</span>
									</div>
								) : (
									<TranscriptEntryRow entry={row.entry} pairing={pairing()} />
								)}
							</div>
						)}
					</For>
					<Show when={loading() && entries().length === 0}>
						<div class="hint">Loading transcript…</div>
					</Show>
					<Show when={!loadErr() && entries().length === 0 && !loading()}>
						<div class="hint">No entries in this session.</div>
					</Show>
					<Show when={entries().length > 0 && visible().length === 0}>
						<div class="hint">No entries match the current filters.</div>
					</Show>
					<Show when={loading() && entries().length > 0}>
						<div class="hint">Loading…</div>
					</Show>
				</div>
			</div>
		</RowStateCtx.Provider>
	);
}
