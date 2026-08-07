# Web UI ↔ TUI feature parity — SDK-era plan

**Supersedes the RPC-era plan (Phases 0–6, all complete).** The agent now runs
in-process via `createAgentSession` (`@oh-my-pi/pi-coding-agent@17.1.8`); the old
JSON-RPC child is gone. This document is the reformulated parity plan against the
TUI for **single-session capabilities**, plus web-affordance enhancements the TUI
cannot offer. Written 2026-08-05 from three ground inventories:

- TUI capabilities: `pi-coding-agent` interactive mode (slash registry, keybindings,
  status-line segments, tool renderers, controllers).
- SDK surface: `dist/types/session/agent-session.d.ts` (17.1.8) — every method named
  below was grep-verified against the pinned package.
- Web current state: `src/`, `server/index.ts`.

## Progress

- [x] Phases 0–6 (RPC era, complete 2026-07-30) — protocol relay, streaming input,
  slash/autocomplete/bang-shell, status bar, tool renderers, session management,
  login/subagents/settings. See git history for the archived plan.
- [x] SDK conversion (2026-08-05) — in-process sessions, ui_request dialogs,
  multi-session multiplexing, subagent steer/abort.
- [x] Phase 7 — Input & queue parity (complete 2026-08-06: queue chip bar with
  dequeue/clear, `->`/`=>` shorthand + `/queue`, double-Esc branch, Ctrl+R history search)
- [x] Phase 8 — Session command parity (complete 2026-08-06: retry/fork/fresh/
  handoff/rename/interrupt/dump relays, inline rename, copy buttons)
- [x] Phase 9 — Status, modes & usage parity (complete 2026-08-06: per-turn usage
  rows, retry countdown, goal popover, plan badge, usage panel, context breakdown,
  fast/computer/vision toggles; deviation: `/goal`+`/plan` are NOT ACP-intercepted
  on 17.1.8 — relayed via `setGoalModeState`/`setPlanModeState` + `goalRuntime` rows)
- [x] Phase 10 — Tool rendering completion + inline images (complete 2026-08-06:
  eval/lsp/hub/ask renderers, inline images in user messages + tool results,
  streaming bash/python via chunk frames, `$`/`$$` python mode; deviation:
  `!!` now sets `excludeFromContext` server-side, matching the TUI)
- [x] Phase 11 — Web-plus enhancements (complete 2026-08-06: desktop
  notifications, `/btw` side panel, message hover actions, export themes)
- [x] Phase 12 — Parity audit sweep & docs (complete 2026-08-06: side-by-side
  checklist run in browser; README updated; deviation: `/download` jail now
  also allows the server process cwd — bare-filename exports land there)
- [x] Phase 13 — `/settings` settings panel (complete 2026-08-06: full-screen
  settings UI driven by the same settings-schema metadata as the TUI,
  with TUI-identical semantics — in-process `settings.set` + debounced disk
  persist; deviations: no Plugins tab (web has no plugin management), TUI-only
  render side effects skipped; layout: left sidebar with the main sections and
  the active section's nested subsections on wide screens (horizontal tab bar
  fallback on narrow) — client-local "Web UI" tab (web-only toggles +
  web-relevant Images group), one tab per web-relevant schema tab (Model,
  Interaction, Context, Memory, Files, Shell, Tools, Tasks, Providers), and a
  "TUI" tab holding only terminal-specific appearance — Theme, Status Line,
  Display groups + `terminal.showImages`)

## Architecture (in place; every phase only adds rows/frames)

- `src/protocol.ts` — `WebMethodName` allowlist + frame unions. New capability =
  one union member + one server dispatch row (+ optional new frame type).
- `server/index.ts` — `METHODS` dispatch table; post-mutation state broadcast
  (skipped for `READ_ONLY` rows); `HISTORY_RELOAD` rows resync history+state before
  `call_result`; full `AgentSessionEvent` union forwarded verbatim; ExtensionUIContext
  dialogs relayed as `ui_request`/`ui_response`; builtin slash commands intercepted
  server-side via `executeAcpBuiltinSlashCommand` (output → `notice` events).
- `src/state.ts` — Solid store, `call()` promise map, `applyEvent`, `applyState`.
- `src/commands.ts` — input-prefix dispatch (`!!`/`!`/`/local`/passthrough/text).
- `src/components/tools/` — renderer registry, `GenericToolCard` fallback. Never
  crash the transcript on an unrecognized payload — fall back.

Ground facts used below (all verified in 17.1.8 `agent-session.d.ts`):
`getQueuedMessages()`, `popLastQueuedMessage()`, `clearQueue()`, `retry()`,
`fork()`, `freshSession()`, `handoff(customInstructions?, opts?)`,
`setSessionName(name, "user")`, `setInterruptMode("immediate"|"wait")`,
`setFastMode(bool)`, `setComputerToolEnabled(bool)`, `setInspectImageMode(mode)`,
`executePython(code, onChunk?, opts?)`, `executeBash(cmd, onChunk?, opts?)`,
`runEphemeralTurn({promptText, onTextDelta?})`, `getContextBreakdown(opts?)`,
`fetchUsageReports()`, `getPlanModeState()`, `getGoalModeState()`, `goalRuntime`,
`navigateTree(targetId, opts?)`, `shake(mode)`, `dropImages()`. `/plan`, `/goal`,
`/rename`, `/fresh`, `/clear`, `/retry`, `/shake` are universal builtins already
executed by the server's prompt interception — their *state display* is the gap,
not execution.

## Phase 7 — Input & queue parity

TUI reference: `modes/queue-input.ts` (`->`/`=>` shorthand, enumerated splits),
pending-messages bar with Alt+Up dequeue, double-Esc → tree, Ctrl+R history search.

1. Relay rows: `getQueuedMessages`, `popLastQueuedMessage`, `clearQueue`
   (all READ_ONLY except the mutating pops — post-mutation state broadcast covers
   `queuedMessageCount`).
2. **Queued-messages bar** above PromptBox (replaces bare count chip): one chip per
   queued message (text preview, kind steer/follow-up), Alt+Up or click-× pops the
   last (`popLastQueuedMessage`, restored text goes back into the textarea), a
   "clear" button drains (`clearQueue`). Web affordance: visible, clickable chips —
   the TUI only shows a one-line bar.
3. **Queue shorthand** in `commands.ts`: `-> msg` forces steer-queue, `=> msg`
   forces follow-up-queue regardless of streaming state; `/queue <msg>` local
   command = follow-up. Unit tests in `commands.test.ts`.
4. **Double-Esc on empty textarea** opens the BranchPicker (old Phase 5 step,
   never implemented; track Esc timing in PromptBox).
5. **Ctrl+R history search modal** (web affordance over TUI's overlay): fuzzy
   filter over `src/history.ts` entries, Enter/click inserts into the textarea.

Verification: typecheck + `bun test` (new commands.test cases); browser: queue two
follow-ups, see chips, Alt+Up restores one, clear drains; `-> hi` while idle sends
as follow-up; double-Esc opens branch picker; Ctrl+R finds an old prompt.

## Phase 8 — Session command parity

1. Relay rows: `retry` (`session.retry()`), `fork` (HISTORY_RELOAD),
   `freshSession` (state resync), `handoff` (customInstructions?; HISTORY_RELOAD —
   handoff starts a new session), `setSessionName` (name → `setSessionName(name,
   "user")`), `setInterruptMode`, `formatSessionAsText` (READ_ONLY),
   `dumpLlmRequestToTmpDir` (READ_ONLY; result path downloadable via `/download` —
   extend the jail to allow the dump tmpdir if not already covered).
2. Local commands (`commands.ts`): `/retry`, `/fork`, `/fresh`, `/handoff [focus]`,
   `/drop` (confirm + `newSession` discarding current), `/dump` (download
   transcript text + link to the LLM-request JSON). `/rename <title>` switches from
   prompt-passthrough to the `setSessionName` row (instant, no LLM round-trip).
3. **Inline session rename** (web affordance): status-bar session name becomes an
   inline editable field (Enter commits → `setSessionName`, Esc cancels) replacing
   `window.prompt`.
4. **Interrupt mode** select (`immediate`/`wait`) in SettingsPopover.
5. **Copy affordances** (web `/copy`): hover copy button on assistant messages
   (copies markdown source) and on fenced code blocks. No picker needed — direct
   per-block buttons are the web-native equivalent of `/copy`.

Verification: typecheck + tests; browser: `/rename` updates the bar instantly,
`/retry` after a failed turn reruns it, `/fork` resyncs a forked transcript,
`/handoff focus` lands in a new session with the handoff doc, `/dump` downloads two
files, interrupt-mode toggle reflects in state.

## Phase 9 — Status, modes & usage parity

1. **Per-turn usage rows** (TUI `usage-row.ts`): under each settled assistant
   message render a subtle footer — tokens in/out (+cache), TTFT, tok/s — from the
   assistant message's `usage`/`providerMetadata` already present in `message_end`
   history payloads. Pure client change.
2. **Auto-retry live badge**: `auto_retry_start` carries attempt/maxAttempts/
   delayMs — render a status-bar countdown badge ("retry 2/5 in 3.2s") replacing
   the static notice; keep `auto_retry_end` notices.
3. **Goal mode surface**: add `goalModeState` (from `getGoalModeState()`) to
   `WebSessionState`; goal badge becomes clickable → popover with objective, state,
   budget usage, and pause/resume/drop controls (`/goal pause|resume|drop` via
   prompt passthrough — universal builtin, already intercepted server-side).
4. **Plan mode badge**: add `planModeState` presence boolean to `WebSessionState`;
   status-bar `plan` badge; `/plan` toggle via passthrough (already works).
5. **Usage reports**: relay `fetchUsageReports` (READ_ONLY) → UsagePanel popover
   (`/usage` parity: per-provider tier, 5h/7d utilization, reset countdowns where
   the report provides them).
6. **Context breakdown**: relay `getContextBreakdown` (READ_ONLY) → breakdown
   section in StatsPopover (`/context` parity: per-category token bars — web
   affordance: stacked bar visualization instead of a text table).
7. **Tool-slate toggles** in SettingsPopover: fast mode (`setFastMode`; add
   `fastModeEnabled` to state), computer (`setComputerToolEnabled`; add
   `computerToolEnabled` via `getActiveToolNames().includes("computer")`), vision
   (`setInspectImageMode`; add `inspectImageState()`).

> **Deviation (17.1.8):** the goal/plan "prompt passthrough" assumption in
> items 3–4 above was WRONG on the pinned 17.1.8 — `executeAcpBuiltinSlashCommand`
> returns `false` for both `/goal` and `/plan` (verified by probe), so they fell
> through to the model as plain prompts and goal/plan mode never engaged. Goal
> and plan control now relay through the SDK directly: `setGoalModeState` /
> `setPlanModeState` plus the `goalCreate`/`goalPause`/`goalResume`/`goalDrop`
> goalRuntime rows (all MUTATING — the post-mutation state broadcast re-reads
> `getGoalModeState()`/`getPlanModeState()?.enabled`). The client routes `/goal …`
> and `/plan` through `LOCAL_COMMANDS` (never prompt passthrough); the goal
> popover's set/pause/resume/drop and the status-bar plan badge call the same
> relay rows. `createGoal` throws when a goal is already active (CLI parity), so
> "set" is only offered when no goal exists.

Verification: typecheck + tests; browser: run a turn → usage row appears with real
numbers; force a retry (bad key in a scratch env or offline model) → countdown
badge; `/goal set …` then badge → popover pauses/resumes; `/plan` toggles badge;
UsagePanel renders reports (skip providers without reporting); toggles flip state
fields.

## Phase 10 — Tool rendering completion + inline images

TUI renderer registry has dedicated renderers for tools the web currently sends to
`GenericToolCard`. Close the high-traffic gaps; unknown shapes still fall back.

1. **eval renderer** (`eval`/`python` tool): code header + streaming output pre,
   mirroring BashTool.
2. **lsp renderer**: op summary (action/file/symbol) + compact result body.
3. **hub renderer**: send/wait/poll states compact card (peer, message preview).
4. **ask renderer**: the ask tool's question + chosen answer as a Q&A card (the
   ui_request dialog is already implemented; this renders the settled tool item).
5. **Inline images** (web-plus, TUI only approximates with sixel/kitty): render
   `ImageContent` blocks in user messages as thumbnails (click → full-size
   overlay), and image payloads in tool results (`inspect_image`, `computer`,
   `browser` screenshots) inline in the tool card.
6. **Streaming bash** (web-plus): extend the `bash` relay row to pass `onChunk`;
   server broadcasts `bash_chunk` session-scoped frames; the in-flight bash chat
   item shows live output instead of appearing only on completion. Same for
   `executePython` if a `$ code` prefix is added — add `$`/`$$` python mode to
   `commands.ts` mirroring `!`/`!!`.

Verification: typecheck + tests; browser: agent runs eval/lsp/hub/ask tools →
dedicated cards; paste an image and send → thumbnail in the transcript; `!ls`
streams output live; `$print(2+2)` runs python.

## Phase 11 — Web-plus enhancements

> **Status: complete (2026-08-06).** All four items landed; see the Progress
> checkbox. Deviations from the sketch, recorded inline:

1. **Desktop notifications**: on `agent_end` (and error notices) when
   `document.hidden`, fire a `Notification` (opt-in toggle in SettingsPopover,
   permission requested on enable). TUI parity: OSC notification on turn complete.
   - Implemented in `src/state.ts` (`maybeNotify`/`setNotifyEnabled`); the
     toggle persists under `omp.notifyEnabled`; body = first ~80 code points of
     the last assistant text (`truncateHead`, unit-tested in
     `src/notify.test.ts`). Non-secure contexts and denied/revoked permission
     are silent no-ops.
2. **`/btw` side-question**: relay `runEphemeralTurn`; `/btw <question>` opens a
   side panel that streams the ephemeral answer (onTextDelta → unicast frames)
   without touching the transcript. TUI has a btw panel; web gets a dismissible
   side sheet (affordance: readable markdown, not an alt-screen).
   - Relay: `runEphemeralTurn` METHOD row broadcasts `ephemeral_delta`
     session-scoped frames (streamId = client btw panel id) and resolves the
     call with `{replyText}` — the Phase 10 `bash_chunk` pattern, which was
     already generic (every METHOD row takes a third `streamId` arg).
   - Abort: wired for real — the row backs each in-flight side turn with a
     per-(session, streamId) `AbortController`; `abortEphemeral` cancels it via
     the SDK `signal`. `closeBtw`/panel stop send that row.
   - `AgentMessage` user payloads carry no `entryId`, so branch resolution is
     match-by-text against `getUserMessagesForBranching()` (see item 3).
3. **Message hover actions**: per-message toolbar — copy, branch-from-here
   (`branch(entryId)` directly, skipping the picker when the target is obvious).
   - User messages: hover toolbar with branch + copy; assistant keeps its copy
     button (now styled via the shared `.msg-copy-btn`). Because pi-ai's
     `UserMessage` has no id field, the entryId is resolved by exact-text match
     against the `getBranchMessages` list; unmatched messages warn and no-op.
4. **Export themes**: extend `exportHtml` row with the `useUserThemes` flag.
   - `/export --themes` → `exportHtml [undefined, true]`; bare `/export`
     unchanged. The row normalizes a null path back to `undefined`.

Verification: typecheck + tests; browser: enable notifications, background the tab,
run a prompt → notification fires; `/btw what does x do` streams in the side sheet;
hover a user message → branch-from-here forks.

## Phase 13 — Settings panel (`/settings` parity)

TUI reference: `modes/components/settings-selector.ts` + `settings-defs.ts`,
backed by `config/settings-schema.ts` and the `Settings` singleton
(`settings.set` = in-process merge + debounced disk persist).

1. **Relay rows**: `getSettings` (READ_ONLY; fresh `SettingsModel` built from
   the shared schema — tabs/groups/items, per-item type, value, changed-vs-
   default flag, condition gates evaluated live, runtime option injection for
   `defaultThinkingLevel` (auto + session levels) and `theme.dark`/`theme.light`
   (installed themes), providerLimits provider list from session models) and
   `setSetting(path, value)` (schema-driven coercion mirroring the TUI's
   `#setSettingValue` — "default"→-1 thresholds, record JSON parse +
   `validateProviderMaxInFlightRequests`, number/boolean/string/array by
   current value, session-managed `autoCompact`/`thinkingLevel` pass-through;
   then `settings.set` for schema paths, then the web-relevant subset of the
   TUI's `handleSettingChange` side effects — session setters, prompt/memory/
   vision refreshers, sampling params, search/image provider orders; returns
   the fresh model and broadcasts it as a `settings_changed` frame so every
   tab's panel stays in sync).
2. **SettingsPanel** (web affordance over the TUI's fullscreen selector):
   full-screen modal, left sidebar with the main sections and the active
   section's nested subsections on wide screens (horizontal tab bar fallback
   on narrow) — a client-local "Web UI" tab
   (theme preference, font size, desktop notifications, reveal queue, soft
   fade, fast mode, auto-retry, login providers, plus an "Images" group with
   the web-relevant image handling `images.autoResize`/`images.blockImages`),
   one tab per web-relevant schema tab (Model, Interaction, Context, Memory,
   Files, Shell, Tools, Tasks, Providers) rendering the schema content
   directly, and a "TUI" tab limited to the terminal-only appearance groups
   (Theme, Status Line, Display: `theme.*`, `statusLine.*`, `display.*`,
   `tui.*`, `terminal.*`, symbol preset, color-blind mode, hardware cursor,
   resolved-model badge) plus the terminal image renderer
   (`terminal.showImages`); group headings (ungrouped items first, mirroring
   the TUI's section layout), per-type widgets (boolean toggle, enum/submenu
   select, text input with secret masking + show/hide, multiselect chips
   with reorder for ordered lists, providerLimits per-provider number
   inputs), changed dot, global type-to-search across every tab.

> **Deviations (web host):** no Plugins tab (plugin management is a TUI
> file-dashboard, excluded app-config); TUI-only render side effects
> (`display.*`, `tui.*`, `terminal.*`, `statusLine.*`, theme preview) are
> skipped — the values still persist, only the re-render is absent; the tab
> split is client-side presentation — the "Web UI" tab holds the client-local
> toggles plus web-relevant image handling (`images.autoResize`,
> `images.blockImages`), the 9 web-relevant schema tabs render their schema
> content directly, and the "TUI" tab hosts only terminal-specific appearance
> (Theme, Status Line, Display) plus `terminal.showImages`; the wire model
> still mirrors the TUI's 10-tab `/settings` schema 1:1.

Verification: typecheck + `bun test`; browser: open ⚙ → tabs render with
real values; flip a boolean → `config.yml`/`settings.json` updated on disk and
the in-process session reflects it (steering-mode change also lands in the
status bar via the state broadcast); `memory.backend` → Hindsight cluster
appears/disappears; search finds settings across tabs; a second browser tab
stays in sync via `settings_changed`.

## Phase 12 — Parity audit sweep & docs

1. Side-by-side checklist: same 15-minute workflow in TUI (`omp`) and web UI on a
   scratch repo — prompt, steer, queue (chips + shorthand), dequeue, bash
   (`!`/`!!`), python (`$`), edit diff, todos, subagent spawn/steer/abort, model
   switch, thinking switch, plan/goal badges, compact, retry, handoff, fork/branch,
   rename, export, dump, resume, notifications — confirm each has a web equivalent.
2. Update README feature list to match final state.
3. Tick every phase checkbox above; record deviations inline (same convention as
   the RPC-era plan).

## Exclusions (recorded decisions, not gaps)

- ~~Multi-session/collab surfaces (collab/QR/join/leave) — out of single-session scope.~~
  SHIPPED (tui-mux): the daemon runs an omp collab relay (`/r/<roomId>`) and a
  per-session host adapter, so real TUI clients can `omp join` a session link
  (write or read-only view link) and multiplex with the web UI. See README
  "TUI collab join".
- Voice/STT/TTS (`/live`, push-to-talk) — excluded.
- Terminal-only protocols: sixel/kitty graphics, OSC hyperlinks/appearance, SGR
  mouse, external `$EDITOR` (Ctrl+G) — the browser textarea and modals are the
  equivalent affordances.
- App-config management UIs: marketplace/plugins (incl. the /settings Plugins
  tab), MCP server wizard, setup wizard, memory backend ops, SSH hosts, debug
  tools, agent hub dashboard, security scan UI — these manage the installation,
  not a session. Their per-session effects (available commands, tool slates,
  MCP prompt commands) already flow through existing frames. (The schema-backed
  /settings tabs themselves are NOT excluded — Phase 13 ships them.)
- `/share` (needs a share server/gist credentials), snapcompact bitmap preview,
  tiny-title download progress, codex reset fireworks — cosmetic or infra-bound.
- Session-DAG tree view — BranchPicker stays a linear list (prior decision stands).
- `ui_context.custom()` — no web component registry; rejection stands.

## Verification (every phase)

`bun install` first (this worktree has no local `node_modules`; imports currently
resolve via the sibling `../omp-web` install). Then per phase: `bun run
check:types` + `bun test` green; browser smoke against `bun run dev:server` +
`bun run dev:web` (`OMP_WEB_CWD=<scratch>`) exercising the phase's checklist;
commit per phase. Unit tests only for new pure logic (queue-shorthand parsing,
usage-row formatting, breakdown math) in the existing `*.test.ts` style.
