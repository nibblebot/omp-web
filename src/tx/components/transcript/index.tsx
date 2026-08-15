/**
 * TranscriptView: paging controller + tool-call pairing + virtualized row
 * rendering for one session transcript (main session or a subagent's).
 *
 * - Paging: pages of PAGE_SIZE are fetched automatically as the user scrolls
 *   near the end of the loaded window (no load-more button); the viewport is
 *   topped up after each successful load.
 * - Virtualization: only viewport-bound rows exist in the DOM
 *   (@tanstack/solid-virtual, overscan 10, measured variable heights).
 * - Pairing: tool-call pairing maps are computed once per entries change over
 *   ALL loaded entries (pairing.ts) — toolResults pair with their call's
 *   execution start across page boundaries; calls with a start but no result
 *   yet in the loaded range show a "pending…" badge.
 * - The ?tool= filter applies ONLY to the main-session view; subagent
 *   transcripts ignore it (and clear it).
 * - Load errors show "Failed to load transcript" + Retry, re-fetching the
 *   current window from inside this controller.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { RawEntry } from "../../api";
import { api, type TranscriptPage } from "../../api";
import { basename } from "../../util/format";
import { contentBlocks, entryTs, isMessage, messageRole, str, toolCallIdOf } from "../../util/entries";
import { createCollapseStore, RowStateCtx } from "./collapse";
import { createPairingMaps } from "./pairing";
import { EntryRow } from "./rows/entry-row";

const PAGE_SIZE = 200;

export interface TranscriptProps {
  file: string;
  /** true when showing a subagent's transcript instead of the main session's */
  isSub: boolean;
  onBackToMain: () => void;
  /** tool names available for the filter dropdown */
  tools: () => string[];
  toolFilter: string | null;
  onToolFilter: (name: string | null) => void;
}

/** ?tool= + hide-system filtering; only the main-session view ever filters. */
export function filterTranscriptEntries(all: readonly RawEntry[], toolFilter: string | null, hideSystem: boolean): RawEntry[] {
  const base = hideSystem ? all.filter(isMessage) : all;
  if (!toolFilter) return [...base];
  const keptCalls = new Set<string>();
  const out: RawEntry[] = [];
  for (const e of base) {
    if (isMessage(e) && messageRole(e) === "assistant") {
      const blocks = contentBlocks(e);
      const match = blocks.some((b) => b.type === "toolCall" && b.name === toolFilter);
      if (!match) continue;
      for (const b of blocks) if (b.type === "toolCall" && typeof b.id === "string") keptCalls.add(b.id);
      out.push(e);
    } else if (isMessage(e) && messageRole(e) === "toolResult") {
      const id = toolCallIdOf(e);
      if (id && keptCalls.has(id)) out.push(e);
    } else {
      out.push(e);
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

export type TranscriptRow = { kind: "day"; ts: number; label: string } | { kind: "entry"; entry: RawEntry };

/**
 * Maps filtered entries to the virtualized row list, inserting a day
 * separator whenever the local calendar day changes between consecutive
 * entries. Separators are ROWS, not entries: they participate in the
 * virtualizer's count/index/measurement (overscan included), but the
 * "N of M entries" progress line keeps counting entries only
 * (visible().length). Entries without a usable timestamp never emit a
 * separator and never advance the running day.
 */
export function buildDayRows(entries: readonly RawEntry[]): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  let prevDay: string | null = null;
  for (const e of entries) {
    const ts = entryTs(e);
    if (ts !== null) {
      const day = new Date(ts).toDateString();
      // Separate only when a previous DATED row exists — undated leading rows
      // (e.g. the title slot) never produce a spurious separator.
      if (prevDay !== null && day !== prevDay) {
        out.push({ kind: "day", ts, label: new Date(ts).toLocaleDateString() });
      }
      prevDay = day;
    }
    out.push({ kind: "entry", entry: e });
  }
  return out;
}

export function TranscriptView(props: TranscriptProps) {
  const [entries, setEntries] = createSignal<RawEntry[]>([]);
  const [nextOffset, setNextOffset] = createSignal<number | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);
  const [hideSystem, setHideSystem] = createSignal(false);
  const [lastPage, setLastPage] = createSignal<LastPageMeta | null>(null);
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
      const page = await api.transcript(props.file, offset, PAGE_SIZE);
      if (my !== seq) return; // stale response after a file switch
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

  onCleanup(() => {
    seq += 1;
  });

  // Tool filter never leaks into subagent transcripts: clear it, and don't apply it.
  createEffect(() => {
    if (props.isSub && props.toolFilter !== null) props.onToolFilter(null);
  });

  /** Filtered rows: ?tool= + hide-system apply to the main view only. */
  const visible = createMemo(() =>
    filterTranscriptEntries(entries(), props.isSub ? null : props.toolFilter, hideSystem()),
  );

  /** Virtual rows: filtered entries + day-group separators. */
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

  // Remeasure after collapse/expand toggles and filter changes (row heights
  // vary); page appends leave existing row sizes untouched and measure only
  // the newly mounted rows via their refs.
  createEffect(() => {
    store.collapsedIds();
    store.details();
    void props.isSub;
    void props.toolFilter;
    void hideSystem();
    queueMicrotask(() => {
      virtualizer.measure();
      for (const vi of virtualizer.getVirtualItems()) {
        const el = virtualizer.elementsCache.get(vi.key);
        if (el) virtualizer.measureElement(el);
      }
    });
  });

  /** The transcript may sit in a CSS-hidden tab (SessionDetail keeps tabs mounted). */
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
    // Tab reveal (hidden → visible) re-arms paging + remeasures 0-height rows.
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
          <Show when={props.isSub}>
            <button class="btn" onClick={props.onBackToMain}>
              ← back to main
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
                <For each={props.tools()}>
                  {(t) => (
                    <option value={t}>{t}</option>
                  )}
                </For>
              </select>
            </label>
            <Show when={props.toolFilter !== null}>
              <button class="btn btn-small" onClick={() => props.onToolFilter(null)}>
                clear filter
              </button>
            </Show>
          </Show>
          <button class="btn btn-small" onClick={store.expandEverything}>
            expand all
          </button>
          <button class="btn btn-small" onClick={() => store.collapseEverything(visible().map((e) => str(e.id)))}>
            collapse all
          </button>
          <label class="tool-filter">
            <input type="checkbox" checked={hideSystem()} onChange={(e) => setHideSystem(e.currentTarget.checked)} />
            <span>hide system entries</span>
          </label>
          <span class="entry-count">
            {visible().length} of {progressM()} {progressM() === 1 ? "entry" : "entries"}
          </span>
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
          <div class="transcript-space" style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
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
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
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
            <div class="hint">No entries in this session.</div>
          </Show>
          <Show when={loading() && entries().length > 0}>
            <div class="hint">Loading…</div>
          </Show>
        </div>
      </div>
    </RowStateCtx.Provider>
  );
}
