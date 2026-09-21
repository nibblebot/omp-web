/**
 * StoredTranscriptView: transcript paging controller for fleet-store files.
 *
 * The /ctl/stored transcript route answers the same TranscriptPage shape as
 * the /ctl/stats route, so the row renderers, pairing maps, collapse store
 * and day-separator machinery from transcript/ are reused verbatim; the one
 * difference is the fetch source (api.storedTranscript instead of
 * api.transcript) and that no stats-derived tool filter exists here (no
 * stats.db rows for store files; tool names are unknown until a page lands).
 *
 * Read-only by design: no resume, no download, no compute wake. A file
 * indexed but absent from the store answers 404 { error: { code:
 * "unavailable" } } and renders an explicit notice, never a broken link.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { RawEntry } from "../api";
import { api, ApiError } from "../api";
import { createCollapseStore, RowStateCtx } from "./transcript/collapse";
import { createPairingMaps } from "./transcript/pairing";
import { EntryRow } from "./transcript/rows/entry-row";
import { buildDayRows, type LastPageMeta, progressTotal } from "./transcript";
import { str } from "../util/entries";
import { basename } from "../util/format";

const PAGE_SIZE = 200;
/** Raw-bytes display cap (fetching + rendering). */
export const RAW_CAP_BYTES = 256 * 1024;

interface StoredTranscriptControllerProps {
	workspaceId: string;
	sessionId: string;
	relpath: string;
	onUnavailable: () => void;
}

function StoredTranscriptController(props: StoredTranscriptControllerProps) {
	const [entries, setEntries] = createSignal<RawEntry[]>([]);
	const [nextOffset, setNextOffset] = createSignal<number | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [loadErr, setLoadErr] = createSignal<string | null>(null);
	const [lastPage, setLastPage] = createSignal<LastPageMeta | null>(null);
	const [hideSystem, setHideSystem] = createSignal(false);
	const [failedOffset, setFailedOffset] = createSignal<number | null>(null);

	const store = createCollapseStore();
	const pairing = createPairingMaps(entries);

	let seq = 0;
	let listRef: HTMLDivElement | undefined;

	const loadPage = async (offset: number | null) => {
		const my = ++seq;
		setLoading(true);
		setLoadErr(null);
		try {
			const page = await api.storedTranscript(props.workspaceId, props.sessionId, {
				file: props.relpath,
				offset: offset ?? undefined,
				limit: PAGE_SIZE,
			});
			if (my !== seq) return; // stale response after a file switch
			setEntries((prev) => (offset === null ? page.entries : [...prev, ...page.entries]));
			setNextOffset(page.nextOffset);
			setLastPage({ totalLines: page.totalLines });
		} catch (e) {
			if (my !== seq) return;
			// Server answers 404 { error: { code: "unavailable" } } for an
			// indexed-but-absent file: explicit notice, never a broken link.
			const isUnavailable = e instanceof ApiError && (e.code === "unavailable" || e.status === 404);
			if (isUnavailable) {
				props.onUnavailable();
				return;
			}
			setFailedOffset(offset);
			setLoadErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (my === seq) setLoading(false);
		}
	};

	const retry = () => {
		if (loadErr() !== null) void loadPage(failedOffset());
	};

	// Reset on file (relpath) switch.
	createEffect(() => {
		props.relpath; // reactive trigger
		seq += 1;
		setEntries([]);
		setNextOffset(null);
		setLoadErr(null);
		setLastPage(null);
		setFailedOffset(null);
		store.reset();
		void loadPage(null);
	});

	onCleanup(() => {
		seq += 1;
	});

	// "hide system entries" mirrors the main view: hide non-message entries.
	const visible = createMemo(() => {
		const loaded = entries();
		return hideSystem() ? loaded.filter((e) => e.type === "message") : loaded;
	});

	const rows = createMemo(() => buildDayRows(visible()));

	const virtualizer = createVirtualizer({
		get count() {
			return rows().length;
		},
		getScrollElement: () => listRef?.closest(".tx-main") ?? null,
		estimateSize: () => 220,
		overscan: 10,
		measureElement: (el) => el.getBoundingClientRect().height,
	});

	// Remeasure after collapse/expand toggles and filter changes; page
	// appends leave existing row sizes untouched and measure only newly
	// mounted rows via their refs.
	createEffect(() => {
		store.collapsedIds();
		store.details();
		void hideSystem();
		queueMicrotask(() => {
			virtualizer.measure();
			for (const vi of virtualizer.getVirtualItems()) {
				const el = virtualizer.elementsCache.get(vi.key);
				if (el) virtualizer.measureElement(el);
			}
		});
	});

	const transcriptVisible = () => {
		const el = listRef;
		return el !== undefined && el.getBoundingClientRect().height > 0;
	};

	const maybeLoadMore = () => {
		if (loading() || loadErr() !== null || !transcriptVisible()) return;
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
		const list = listRef;
		if (list && typeof ResizeObserver === "function") {
			const ro = new ResizeObserver(() => {
				if (list.getBoundingClientRect().height <= 0) return;
				queueMicrotask(() => {
					virtualizer.measure();
					for (const vi of virtualizer.getVirtualItems()) {
						const el2 = virtualizer.elementsCache.get(vi.key);
						if (el2) virtualizer.measureElement(el2);
					}
				});
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
					<span class="sub-tag stored-tag">stored · {basename(props.relpath)}</span>
				</div>

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
					<div
						class="transcript-space"
						style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
					>
						<For each={virtualizer.getVirtualItems()}>
							{(vi) => {
								const row = rows()[vi.index];
								if (!row) return null;
								return (
									<div
										class="transcript-vrow"
										data-index={vi.index}
										data-kind={row.kind}
										ref={(el) => {
											if (el) virtualizer.measureElement(el);
										}}
										style={{
											position: "absolute",
											top: 0,
											left: 0,
											width: "100%",
											transform: `translateY(${vi.start}px)`,
										}}
									>
										{row.kind === "day" ? (
											<div class="day-sep">
												<span>{row.label}</span>
											</div>
										) : (
											<EntryRow entry={row.entry} pairing={pairing()} />
										)}
									</div>
								);
							}}
						</For>
					</div>
					<Show when={loading() && entries().length === 0}>
						<div class="hint">Loading transcript…</div>
					</Show>
					<Show when={!loadErr() && entries().length === 0 && !loading()}>
						<div class="hint">No entries in this stored file.</div>
					</Show>
					<Show when={loading() && entries().length > 0}>
						<div class="hint">Loading…</div>
					</Show>
				</div>
			</div>
		</RowStateCtx.Provider>
	);
}

interface StoredTranscriptPaneProps {
	workspaceId: string;
	sessionId: string;
	relpath: string;
}

/**
 * Stored-transcript pane: the paging controller plus a raw-bytes toggle.
 * The raw affordance fetches format=raw (byte-identical application/x-ndjson)
 * and renders it read-only in a capped <pre>; embedded stored bytes stay
 * available even when derived assets are missing.
 */
export function StoredTranscriptPane(props: StoredTranscriptPaneProps) {
	const [showRaw, setShowRaw] = createSignal(false);
	const [raw, setRaw] = createSignal<string | null>(null);
	const [rawTruncated, setRawTruncated] = createSignal(false);
	const [rawErr, setRawErr] = createSignal<string | null>(null);
	const [rawLoading, setRawLoading] = createSignal(false);
	const [unavailable, setUnavailable] = createSignal(false);

	// A missing file (server 404 unavailable) is terminal for this relpath;
	// switching files resets both it and the raw toggle.
	createEffect(() => {
		props.relpath;
		setUnavailable(false);
		setShowRaw(false);
		setRaw(null);
		setRawErr(null);
		setRawTruncated(false);
	});

	const loadRaw = async () => {
		if (rawLoading()) return;
		setRawLoading(true);
		setRawErr(null);
		try {
			const text = await api.storedRaw(props.workspaceId, props.sessionId, props.relpath);
			if (text.length > RAW_CAP_BYTES) {
				setRaw(text.slice(0, RAW_CAP_BYTES));
				setRawTruncated(true);
			} else {
				setRaw(text);
				setRawTruncated(false);
			}
			setShowRaw(true);
		} catch (e) {
			setRawErr(e instanceof Error ? e.message : String(e));
			setShowRaw(true);
		} finally {
			setRawLoading(false);
		}
	};

	return (
		<section class="stored-transcript">
			<div class="stored-file-actions">
				<button
					type="button"
					class="btn btn-small"
					onClick={() => {
						if (showRaw()) {
							setShowRaw(false);
							return;
						}
						void loadRaw();
					}}
					disabled={rawLoading()}
					title="Fetch the byte-identical stored JSONL (application/x-ndjson)"
				>
					{showRaw() ? "Hide raw" : rawLoading() ? "Loading raw…" : "View raw"}
				</button>
			</div>

			<Show when={unavailable()}>
				<div class="tx-unavailable" role="alert">
					This file is missing from the fleet store: unavailable.
				</div>
			</Show>

			<Show when={!showRaw() && !unavailable()}>
				<StoredTranscriptController
					workspaceId={props.workspaceId}
					sessionId={props.sessionId}
					relpath={props.relpath}
					onUnavailable={() => setUnavailable(true)}
				/>
			</Show>

			<Show when={showRaw()}>
				<div class="stored-raw">
					<Show when={rawLoading()}>
						<div class="hint">Loading raw bytes…</div>
					</Show>
					<Show when={rawErr() && !rawLoading()}>
						<div class="tx-unavailable" role="alert">
							Raw bytes unavailable: {rawErr()}
						</div>
					</Show>
					<Show when={raw() !== null && !rawLoading() && raw() !== undefined}>
						<pre class="stored-raw-pre">
							{raw()}
							<Show when={rawTruncated()}>
								<div class="stored-raw-cap-note">
									Truncated: showing the first {(RAW_CAP_BYTES / 1024).toFixed(0)} KB of stored
									bytes.
								</div>
							</Show>
						</pre>
					</Show>
				</div>
			</Show>
		</section>
	);
}
