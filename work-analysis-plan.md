# Work / Analysis mode switcher: implementation plan

Status: implemented 2026-09-04 (waves 1-3 landed; verified wide/narrow in browser).
Scope: roster mode only. Standalone (bare omp-session) is unchanged, no buttons rendered.

## Summary

Two icon buttons at the top of each sidebar swap the entire two-pane layout between
**Work** (roster sidebar + conversation pane, the existing chat surface) and **Analysis**
(transcript sidebar + transcript detail pane, the promoted `src/tx/` transcripts view).
Switching is lossless: both modes preserve last-viewed state.

## Modes and nomenclature

`state.view: 'work' | 'analysis'` (renamed from `'chat' | 'transcripts'`; client-only state,
not wire protocol). Persisted in localStorage `omp.view`, default `work`. Silent migration on
read: `chat` -> `work`, `transcripts` -> `analysis`, unrecognized -> `work`.

| Mode | Sidebar | Main pane | Icon | Tooltip / aria-label |
|---|---|---|---|---|
| Work | Roster (DaemonSidebar) | Conversation | `Terminal` | "Work" |
| Analysis | Transcript Sidebar (was SessionList) | Transcript Detail Pane (was SessionDetail) | `BarChart3` | "Analysis" |

String and identifier consolidation:

- "Session Viewer" (tx sidebar header + empty state) becomes **"Transcripts"**.
- SidebarFooter "Transcripts" view toggle is **deleted** (mode buttons replace it).
- Detail pane tabs: **Overview** (was "Analytics") | Transcript | Subagents.
- Components: `SessionList` -> `TranscriptList`, `SessionDetail` -> `TranscriptDetail`
  (files renamed accordingly). Code naming prefers "transcript"/tx over "session".
- Boundary: wire/API layer keeps existing names. `SessionSummary`/`SessionStats`,
  `/ctl/stats/*`, `shared/stats-types.ts` are untouched (they describe session files).

## Chrome

- New top row inside each sidebar, identical position and order in both modes:
  segmented pair [Work] [Analysis] flush left, `x` close flush right.
  Reuses `.sidebar-icon-btn` + `.active` convention; active mode gets accent, inactive muted.
- Work mode: existing "Projects + add" row stays below the mode row.
- Analysis mode: "Transcripts" title below the mode row, above the search box.
- Sidebar closed: only the existing sidebar-toggle floating button renders (top-left).
  Consequence accepted in review: switching modes requires an open sidebar.
- Add `Terminal` and `BarChart3` to the vendored Lucide set in
  `src/components/shared/icons.tsx` (`PanelLeftIcon` etc. already there).

## Behavior

- Full two-pane swap. Both modes preserve last-viewed state: Work keeps attached session,
  scroll, in-flight stream rendering; Analysis keeps last selected transcript. Switching
  never detaches the session or drops stream state.
- Hash mirrors the screen: selecting a transcript sets `#/s/<file>`; switching to Work
  clears the hash; booting with a `#/s/<file>` hash deep-links into Analysis at that
  transcript; a deleted/missing file falls back to Analysis with nothing selected and the
  hash cleared. Analysis restores its last selection from store state, not the hash.
- Sidebar collapse is per-mode: `omp.sidebarVisible` (roster) and `omp.txSidebarVisible`
  (transcripts). Same toggle button and `.sidebar open` class pattern. Collapsed Analysis
  gives a full-width detail pane.
- Work-button activity dot: light-blue dot on the [Work] button when a turn ends while in
  Analysis (driven by the existing `daemon_activity` / unread machinery in
  `src/fleet-ui/unread.ts`); cleared on entering Work. No streaming dot.
- Analysis data: global all-sessions list (existing `/ctl/stats/sessions` aggregation).
  Sticky section headers grouped by project (sorted by most-recent activity within group),
  a project filter dropdown above search, and the existing debounced search. Worktrees
  disambiguated by the folder string inside rows.
- Empty states: one shared empty detail pane for zero-projects and zero-sessions cases
  ("No sessions yet" sidebar body, short explainer in the detail pane). No FirstRunPanel
  duplication in Analysis.
- StatusBar stays shared; its right-side debug/settings segments render when
  `view !== 'work'` (gate updated from `view !== 'chat'`). SessionHeader stays Work-only.
- No keyboard shortcuts in v1.

## File-level change map

- `src/state.ts`: `view` values renamed, `omp.view` persistence + migration, boot-time
  hash handling, Work-dot state field.
- `src/App.tsx`: view gates (`:172-203`) and modal mounts updated for renamed values.
- `src/components/roster/DaemonSidebar.tsx`: mode row added at top.
- `src/components/roster/SidebarFooter.tsx`: tx toggle removed (debug/settings stay).
- `src/components/chat/StatusBar.tsx`: segment gate `view !== 'work'`.
- `src/components/shared/icons.tsx`: add `TerminalIcon`, `BarChart3Icon`.
- `src/tx/Browser.tsx`: mode row in tx sidebar head, "Transcripts" title, hash-at-boot
  sets `view = 'analysis'`, missing-file fallback.
- `src/tx/components/SessionList.tsx` -> `TranscriptList.tsx`: rename, project group
  headers, project filter dropdown, empty-state copy.
- `src/tx/components/SessionDetail.tsx` -> `TranscriptDetail.tsx`: rename, "Overview" tab.
- `src/fleet-ui/unread.ts` + store: Work-dot signal (turn ends while `view === 'analysis'`).
- `src/styles/fleet.css`, `src/tx/tx.css`: mode-row styles; respect stylesheet import
  order (load-bearing cascade).
- Tests: `src/state.test.ts` (renamed values, persistence, migration, boot hash),
  tx-component tests, unread-dot test.

## Execution plan (parallelized)

### Why this shape

Two chokepoints cap useful parallelism:

- `src/state.ts` is single-writer: the view rename, `omp.view` persistence, boot-hash init,
  and the Work-dot state all live there. Splitting them across agents makes merge
  conflicts, not speed. Same for `src/fleet-ui/unread.ts` dot wiring, which hangs off the
  turn-end path in state code. Old Phases 1 and 5 therefore merge into one foundation slice.
- `TranscriptList.tsx` (renamed from `SessionList.tsx`): the rename and the project
  grouping/filter UI touch the same file, so old Phases 3 and 4 merge into one slice.

Everything downstream references the renamed view values and the shared `ModeSwitch`
component, so the foundation wave lands alone first. After that, Work chrome and the
Analysis surface own disjoint files and only mount finished foundation pieces, so they
fan out in parallel. Verification integrates last.

### Cross-slice contracts (fixed before fan-out)

- `state.view: 'work' | 'analysis'`; action `setView(v)` persists `omp.view` and clears
  `location.hash` when entering Work.
- `state.workUnviewed: boolean`; set at turn end while `view === 'analysis'`, cleared by
  `setView('work')`.
- `src/components/shared/ModeSwitch.tsx`, named export `ModeSwitch`, no props: renders the
  [Work] [Analysis] pair with `.sidebar-icon-btn` + `.active`, tooltips/aria-labels, and
  the Work-dot binding from `state.workUnviewed`. Sidebars compose it next to their own
  `x` close button (each sidebar keeps its own visibility key).
- Icons: `TerminalIcon`, `BarChart3Icon` exported from `src/components/shared/icons.tsx`.
- Renames: `src/tx/components/SessionList.tsx` -> `TranscriptList.tsx` (component
  `TranscriptList`), `SessionDetail.tsx` -> `TranscriptDetail.tsx` (`TranscriptDetail`),
  header string "Session Viewer" -> "Transcripts", tab "Analytics" -> "Overview".
- New localStorage keys: `omp.view`, `omp.txSidebarVisible`. Migration on read:
  `chat` -> `work`, `transcripts` -> `analysis`, unknown -> `work`.
- Exclusive file ownership per slice (listed below). No slice edits another slice's files;
  cross-slice needs go through these contracts. Concurrent slices skip validation
  mid-flight; the integration wave runs all checks after both land.

### Wave 1: foundation (serial, 1 agent)

Owns: `src/state.ts`, `src/store/*`, `src/App.tsx`, `src/components/chat/StatusBar.tsx`,
`src/components/shared/icons.tsx`, new `src/components/shared/ModeSwitch.tsx`,
`src/state.test.ts`.

- [ ] Rename state.view values to work/analysis (sweep App.tsx and StatusBar.tsx gates)
- [ ] Add omp.view persistence with silent migration
- [ ] Boot with #/s/<file> hash initializes view to analysis
- [ ] setView clears the hash when entering Work
- [ ] Add workUnviewed: set on turn end while in Analysis, cleared on entering Work
- [ ] Add TerminalIcon and BarChart3Icon
- [ ] Build shared ModeSwitch component (pair, active state, Work dot)
- [ ] Update state.test.ts: renamed values, persistence, migration, boot hash, dot

### Wave 2: parallel fan-out (2 agents)

Slice B: Work chrome. Owns: `src/components/roster/DaemonSidebar.tsx`,
`src/components/roster/SidebarFooter.tsx`, `src/styles/fleet.css`.

- [ ] Mount ModeSwitch as top row of DaemonSidebar, x close stays on that row
- [ ] Delete SidebarFooter transcripts toggle (debug and settings stay)
- [ ] Style the mode row in fleet.css

Slice C: Analysis surface. Owns: `src/tx/**` (Browser.tsx, both component renames,
tx.css, tx tests).

- [ ] Rename SessionList/SessionDetail files and components to TranscriptList/TranscriptDetail
- [ ] Retitle sidebar header to Transcripts, update empty-state copy
- [ ] Rename Analytics tab to Overview
- [ ] Mount ModeSwitch as top row of tx sidebar, x closes via new omp.txSidebarVisible
- [ ] Add tx sidebar collapse (.sidebar open pattern, full-width detail when closed)
- [ ] Missing-hash-file fallback: nothing selected, hash cleared
- [ ] Add sticky project group headers (recent-first within group)
- [ ] Add project filter dropdown above search
- [ ] Update tx tests for renames and new behaviors

### Wave 3: integration verification (serial)

- [ ] Run bun run check:types, fix cross-slice type collisions
- [ ] Run full bun run test suite
- [ ] Browser-drive both modes via bun run dev: swap, reload persistence, deep link,
  collapse, Work dot, grouping and filter
