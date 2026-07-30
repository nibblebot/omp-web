# Web UI ↔ TUI feature parity — iterative plan

## Progress
- [x] Phase 0 — Protocol generalization & state mirror (2026-07-30)
  - Deviation: `setSubagentSubscription("progress")` is issued in `connect()` on every (re)open (idempotent, per RpcClient) — moved here from Phase 4 step 8 so the server's subagent forwards actually fire; Phase 4 only consumes the frames.
- [x] Phase 1 — Streaming input parity (2026-07-30)
- [ ] Phase 2 — Slash commands, autocomplete, bang-shell
- [ ] Phase 3 — Status bar parity
- [ ] Phase 4 — Rich tool renderers + subagent plumbing
- [ ] Phase 5 — Session management & compaction display
- [ ] Phase 6 — Secondary surfaces

## Context

`omp-web` is a Solid.js web UI over `@oh-my-pi/pi-coding-agent`'s JSON-RPC mode (`RpcClient` over stdio, bridged to the browser by a Bun WebSocket server). Today it supports only: prompt/abort/new-session, text+thinking streaming with a reveal queue, a generic `<details>` tool card, and a minimal status bar. The TUI (same package, interactive mode) offers ~70 slash commands, steer/follow-up/queue while streaming, model & thinking pickers, a rich status line (context %, cost, tokens, session name), per-tool renderers (bash, diff, read, todo, task), image paste, `!` bang-shell, session resume/branch/tree, compaction summaries, and an agent hub.

Goal: bring the web UI to "more or less" feature parity in shippable phases — core interactive parity first (Phases 0–5), with a path toward the maximal surface (Phase 6+). Constraint: **no upstream changes to `@oh-my-pi/pi-coding-agent`**; everything works against the published 17.1.8 package. Each phase leaves the tree type-checking and the app usable.

Key ground facts (all verified against `node_modules/@oh-my-pi/*` 17.1.8 this session):

- `RpcClient` (`node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-client.ts`) exposes: `prompt(message, images?)`, `steer(message, images?)`, `followUp(message, images?)`, `abort()`, `abortAndPrompt(message, images?)`, `newSession(parentSession?)`, `getState()`, `getAvailableCommands()`, `onAvailableCommandsUpdate(listener)`, `setModel(provider, modelId)`, `cycleModel()`, `getAvailableModels()`, `setThinkingLevel(level)`, `cycleThinkingLevel()`, `setSteeringMode(mode)`, `setFollowUpMode(mode)`, `compact(customInstructions?)`, `setAutoCompaction(enabled)`, `setAutoRetry(enabled)`, `abortRetry()`, `bash(command)`, `abortBash()`, `getSessionStats()`, `handoff(customInstructions?)`, `exportHtml(outputPath?)`, `switchSession(sessionPath)`, `branch(entryId)`, `getBranchMessages()`, `getLoginProviders()`, `login(providerId, callbacks)`, `setSubagentSubscription(level)`, `getSubagents()`, `getSubagentMessages(selector)`, `getLastAssistantText()`.
- Prompt text starting with `/` IS intercepted server-side: `rpc-mode.ts:988-1020` runs `executeAcpBuiltinSlashCommand` for every builtin with a universal `handle` (e.g. `/compact`, `/export`, `/rename`, `/fresh`, `/shake`, `/usage`, `/tools`, `/context`, `/mcp`, `/dirs`, `/add-dir`, `/remove-dir`, `/move`, `/marketplace`, `/plugins`, `/reload-plugins`, `/force`, `/fast`, `/computer`, `/vision`, `/memory`, `/stats`, `/changelog`, `/dump`, `/share`, `/ssh`) plus skill/extension/file commands. Their text output goes to `command_output` frames that `RpcClient` silently drops — so the web UI reimplements the *display* of important ones natively and treats the rest as fire-and-forget (state changes still observed via re-fetched `getState()`).
- `RpcSessionState` fields (`rpc-types.ts:100-123`): `model?`, `thinkingLevel`, `isStreaming`, `isCompacting`, `steeringMode`, `followUpMode`, `interruptMode`, `sessionFile?`, `sessionId`, `sessionName?`, `autoCompactionEnabled`, `messageCount`, `queuedMessageCount`, `todoPhases`, `contextUsage?` (`{tokens, contextWindow, percent}`).
- `SessionStats` (`session/agent-session-types.ts:311-330`): message counts, `tokens.{input,output,reasoning,cacheRead,cacheWrite,total}`, `premiumRequests`, `cost`, `contextUsage?`.
- `ThinkingLevel` (`pi-agent-core/src/thinking.ts:8-19`): `"inherit"|"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"`.
- `ImageContent` (`pi-ai/src/types.ts:697-707`): `{type:"image", data: base64, mimeType, detail?}` — `prompt/steer/followUp` all accept `images?`.
- `BashResult` (`exec/bash-executor.ts:45-57`): `{output, exitCode, cancelled, timedOut?, truncated, totalLines, outputLines, ...}`.
- `listSessions(sessionDir, storage)` / `listAllSessions(storage?)` are exported from `pi-coding-agent/src/session/session-listing.ts` and importable server-side.
- NOT reachable web-only: extension UI dialogs (`extension_ui_request` frames are dispatched only to a private listener set; no public subscribe/respond on `RpcClient`), `set_session_name` RPC command (no client wrapper — but `/rename <title>` works via prompt interception), session list RPC (none — server reads the session dir directly). These are handled as documented gaps/workarounds below.

## Architecture decisions (apply to every phase)

These three refactors are Phase 0; every later phase only *adds rows* to the tables they introduce.

### A. Generic call-relay protocol (`src/protocol.ts`, `server/index.ts`, `src/state.ts`)

Replace the three-case `ClientCommand` with a typed relay so new RPC capabilities never need new protocol plumbing:

```ts
// Client → server
export type ClientCommand =
  | { type: "call"; id: string; method: RpcMethodName; args?: unknown[] }
  | { type: "list_sessions" }
  | { type: "list_files"; query: string; limit?: number };

// RpcMethodName is a string-literal union allowlist, e.g.:
// "prompt" | "steer" | "followUp" | "abort" | "newSession" | "compact"
// | "setModel" | "cycleModel" | "getAvailableModels" | "setThinkingLevel"
// | "cycleThinkingLevel" | "setSteeringMode" | "setFollowUpMode"
// | "setAutoCompaction" | "setAutoRetry" | "abortRetry" | "bash" | "abortBash"
// | "getSessionStats" | "exportHtml" | "switchSession" | "branch"
// | "getBranchMessages" | "getLoginProviders" | "setSubagentSubscription" | "getSubagents"

// Server → browser (broadcast unless noted)
export type ServerFrame =
  | { type: "history"; messages: AgentMessage[] }
  | { type: "state"; state: RpcSessionState }
  | { type: "event"; event: AgentSessionEvent }
  | { type: "call_result"; id: string; ok: boolean; data?: unknown; error?: string } // unicast to caller
  | { type: "available_commands"; commands: RpcAvailableSlashCommand[] }
  | { type: "subagent_lifecycle" | "subagent_progress" | "subagent_event"; payload: unknown }
  | { type: "sessions"; sessions: SessionListEntry[] }   // unicast answer to list_sessions
  | { type: "files"; files: string[] }                    // unicast answer to list_files
  | { type: "error"; error: string };

export type SessionListEntry = { path: string; id: string; name?: string; cwd: string; modifiedAt: number; messageCount: number };
```

Server rules:
- `call` → look up `method` in a `const RPC_METHODS: Record<RpcMethodName, (args: unknown[]) => Promise<unknown>>` table that delegates to the matching `RpcClient` method; send `call_result` to the requesting socket only.
- After any successful mutating call (everything except `getSessionStats`, `getAvailableModels`, `getBranchMessages`, `getLoginProviders`, `getSubagents`), broadcast a fresh `{type:"state", state: await client.getState()}`. This subsumes the dropped `config_update`/`session_info_update` frames.
- Additionally broadcast fresh state + stats on every `agent_end` event (tokens/cost/context/queue counts all change at turn end).
- `switchSession` and `branch` additionally broadcast `{type:"history"}` after the state resync (same as today's `new_session` handler).
- Subscribe once: `client.onAvailableCommandsUpdate(cmds => broadcast({type:"available_commands", commands: cmds}))`; same for the three subagent listeners (payloads are JSON-safe snapshots).
- `list_sessions`: call `listAllSessions()` from `pi-coding-agent/src/session/session-listing.ts` (import path `@oh-my-pi/pi-coding-agent/session/session-listing`), map `SessionInfo` → `SessionListEntry`, sorted by `modifiedAt` desc, cap 200. Unicast.
- `list_files`: walk `OMP_WEB_CWD` recursively (skip `.git`, `node_modules`, respect a 10k-entry ceiling), return paths containing `query` case-insensitively, capped at `limit ?? 50`. A tiny recursive readdir is fine — no dependency.

Client rules (`src/state.ts`):
- `call(method, args?)` helper: generates `id`, sends, returns a `Promise` resolved by the matching `call_result` (rejects on `ok:false`, 30 s timeout).
- On `state` frame: mirror ALL `RpcSessionState` fields into the store verbatim (replace today's pick-three). Store shape becomes `{ items, live, streaming, compacting, model, thinkingLevel, sessionName, sessionId, contextUsage, queuedMessageCount, todoPhases, steeringMode, followUpMode, autoCompactionEnabled, availableCommands, availableModels, stats, subagents, reveal, soften, error }`.
- Reconnect: `connect()` retries with 1 s → 8 s exponential backoff; on `open` the server already re-sends history+state, so resync is free. Show a "disconnected" pill in the status bar while down.

### B. Client-side slash/prefix dispatch (`src/commands.ts`, new)

One module owns input-prefix semantics. `dispatchInput(text, images)`:

1. `!!cmd` → `call("bash", [cmd])` with `excludeFromContext` semantics approximated client-side (render dimmed); result appended as a `kind:"bash"` chat item.
2. `!cmd` → same, normal styling.
3. `/name args…` → look up `name` in the web-local table below; if found, run the local handler; else send the full text via `call("prompt", [text])` (agent-side builtins/skills/extensions handle it).
4. Anything else → `call("prompt"/"steer"/"followUp", ...)` per input mode (Phase 1).

Web-local command table (name → implementation); these are the TUI-only `[T]` commands that have RPC equivalents:
`/model` → open ModelPicker · `/new` `/clear` → `call("newSession")` · `/resume` → open SessionPicker · `/tree` `/branch` → open BranchPicker (`getBranchMessages` → `branch`) · `/export` → `call("exportHtml")` then link to `/download?path=…` (server adds a static route that streams the exported file, path-validated to be under the system temp/session dir) · `/rename <title>` → pass through to `prompt` (agent-side `[A]` handler) · `/compact [focus]` → `call("compact", [focus])` · `/usage` `/context` `/tools` → open the StatsPopover (native rendering from `stats`/`contextUsage`/`state.dumpTools`) · `/hotkeys` `/help` → open a static shortcuts modal · `/exit` `/quit` → render a "close this tab" notice.

### C. Tool renderer registry (`src/components/tools/`, new)

`ToolCard.tsx` becomes a dispatcher: `const RENDERERS: Record<string, Component<{item: ToolItem}>>` keyed by tool name; unknown names fall back to today's generic `<details>` card (keep it as `GenericToolCard`). Each renderer is a pure Solid component over the existing `ToolItem` (`name`, parsed `args` — change `args` storage from pre-stringified JSON to the raw `unknown` object plus a lazy stringify — `status`, `output`). `MessageList` is untouched except importing the dispatcher.

## Approach

**Step 0 — persist the plan.** Write this document verbatim to `docs/web-tui-parity-plan.md` (new file; creating `docs/` is intentional — the user explicitly requested durable multi-session tracking) with the Progress section shown above inserted immediately after the title. Commit it before touching code.

Ordered phases. Dependencies: Phase 0 blocks everything; Phases 1–2 depend only on 0; Phase 3 depends on 0 (independent of 1–2); Phase 4 depends on 0; Phase 5 depends on 0 and reuses Phase 2's modal pattern; Phase 6 depends on 4's subagent plumbing and 2's modal pattern. Within a phase, steps are ordered.

### Phase 0 — Protocol generalization & state mirror

1. Rewrite `src/protocol.ts` with the frame types from Decision A exactly.
2. Rewrite `server/index.ts` command handling into the `RPC_METHODS` allowlist table + `list_sessions` + `list_files` handlers; add the post-mutation state broadcast, the `agent_end` state+stats broadcast (`call_result`-independent: `broadcast({type:"state", …})` and fetch `getSessionStats()` into a `stats` field of the state frame — extend it as `{type:"state", state, stats}`), the `onAvailableCommandsUpdate`/subagent subscriptions, and the `/download` static route (Phase 5 uses it; add it now with path validation: resolve the requested path, require it to be inside `os.tmpdir()` or the session dir).
3. Extend `src/state.ts`: `call()` helper with id/promise map; full-state mirror in `applyState`; `availableCommands`, `stats`, `subagents` store fields; reconnect-with-backoff in `connect()`.
4. Migrate `PromptBox`/`StatusBar` to the new protocol (`send({type:"call", method:"prompt", …})` etc.) with zero visual change; delete the old command union members.
5. Change `ToolItem.args` to raw `unknown` (parse at `tool_execution_start` from `e.args`, keep the 500-char summary as a derived string for the generic card).

Edge cases: WS message for unknown `call_result` id → ignore; `call` while disconnected → reject immediately (the UI surfaces via the existing error banner).

Verification (Phase 0): `bun run check:types` and `bun test` pass; manual: `bun run dev:server` + `bun run dev:web`, send a prompt, abort mid-stream, new session — all behave as before; kill and restart `dev:server` with the tab open → "disconnected" pill appears, then the UI resyncs (history + status bar repopulate) without a reload.

### Phase 1 — Streaming input parity

All edits in `src/components/PromptBox.tsx` + `src/state.ts` (+ small `src/history.ts`).

1. **Never disable the textarea.** While `state.streaming`, Enter sends `call("steer", [text, images])`; while idle, Enter sends `prompt`. `Ctrl+Enter` always sends `call("followUp", …)` (mirrors TUI `app.message.followUp`). Show the active target as a hint chip under the box ("steer", "follow-up", or "send").
2. **Escape → abort** while streaming (keydown on the textarea, mirrors TUI `app.interrupt`); keep the Stop button.
3. **Queued-count chip**: render `state.queuedMessageCount` in the status bar when > 0 (data already flows from Phase 0's `agent_end` broadcast; also refresh state after steer/followUp calls — Decision A's post-mutation broadcast covers this).
4. **Image paste**: `onPaste` handler — for each `clipboardData.items` with `type.startsWith("image/")`, read as base64 into `ImageContent {type:"image", data, mimeType}` (strip the `data:…;base64,` prefix). Show thumbnails in a row above the textarea with per-image remove buttons; pass the array to `prompt`/`steer`/`followUp`. Reuse the exact `ImageContent` shape from `pi-ai`.
5. **Prompt history**: `src/history.ts` — `localStorage["omp-web:history"]`, JSON array, max 100, dedupe consecutive. Up-arrow on an empty first line recalls older, down-arrow newer (store the in-progress draft when first browsing). Push on every successful submit.
6. **Multi-line niceties**: keep Shift+Enter newline; auto-grow the textarea to 12 rows max (`field-sizing: content` with a max-height fallback for older browsers).

Edge cases: empty text with images attached → allowed (send with empty message); paste of non-image data → default behavior; steer while not streaming → fall back to `prompt` (server would error otherwise — the agent errors `steer` on idle sessions).

Verification (Phase 1): prompt a long task ("count to 100 slowly"), while streaming type "actually stop and say hi" + Enter → agent steers mid-turn; Ctrl+Enter a second message → it runs after the turn ends and the queued chip shows `1` then drains; paste a screenshot → thumbnail row appears, send → the agent describes the image (vision model required — if the active model has no vision, expect a provider error notice instead, which is correct behavior); reload the page → Up-arrow recalls the last prompt.

### Phase 2 — Slash commands, autocomplete, bang-shell

New files: `src/commands.ts` (Decision B), `src/components/Autocomplete.tsx`, `src/components/Modal.tsx` (generic overlay: backdrop click + Esc closes, traps focus; every later picker reuses it). Edits: `PromptBox.tsx`, `server/index.ts` (`list_files` already added in Phase 0), `src/state.ts`.

1. Implement `dispatchInput` per Decision B, including `!`/`!!` bang-shell. `call("bash")` results render as a new `kind:"bash"` chat item: header `$ <cmd>`, body `<pre>` of `BashResult.output`, exit-code badge red when `exitCode !== 0`, `(truncated)` note when `truncated`. `!!` items get a dimmed style. Add an `abortBash` button on running bash items — note `bash` has no streaming over RPC, so the item appears only on completion; while the call is in flight show a transient spinner item keyed by the `call` id.
2. `Autocomplete.tsx`: opens when the textarea's current token starts with `/` at position 0, or `@` anywhere after whitespace/start. `/` list = `state.availableCommands` (name, aliases, description, `input.hint`, `subcommands`) filtered by prefix, fuzzy-ranked (exact > startsWith > subsequence — ~30 lines, no dependency). `@` list = send `list_files` (debounced 150 ms, latest-wins) filtered by the token. Keyboard: Up/Down cycle, Tab/Enter applies, Esc closes. Mouse click applies. Render as an absolutely-positioned popup above the textarea; max 12 rows, scrollable.
3. Applying a command completion inserts `/name `; applying an `@` completion inserts `@path ` (quote as `@"path"` when it contains spaces — the agent's prompt parser strips `@`-paths; if it doesn't resolve them, the plain text is still harmless context).
4. On submit of an unrecognized `/cmd` (not in web-local table), send via `prompt` unchanged — agent-side builtin/skill/extension/file commands execute per the RPC interception. Their invisible `command_output` is the documented tradeoff; the important ones have web-native displays (Decision B table, Phase 3 StatsPopover).

Edge cases: autocomplete suppressed inside fenced code blocks in the draft (check the text before the cursor for an odd ``` fence count); `list_files` error → popup just closes; very long `bash` output → reuse the existing 8000-char `capTail`.

Verification (Phase 2): type `/` → popup lists `/compact`, `/model`, `/rename`, extension/skill commands; `/model` opens the (Phase 3 stub ok: render picker with current models once Phase 3 lands — until then `/model` falls through to prompt and the agent replies it is TUI-only, acceptable mid-phase) — sequence phases so 3 lands right after; `!ls -la` → bash card with real directory listing and green `0` badge; `!false` → red `1` badge; `@pac` + Tab → completes `@package.json`; submit `/rename parity-check` → status bar session name updates (via post-mutation state broadcast).

### Phase 3 — Status bar parity

Rewrite `src/components/StatusBar.tsx` into a segment row; new components: `ModelPicker.tsx`, `ThinkingPicker.tsx`, `StatsPopover.tsx` (all on `Modal.tsx`). Edits: `src/state.ts` (stats handling), `server/index.ts` already broadcasts stats.

Segment order (mirroring the TUI `default` preset, minus terminal-only `pr`/`collab`): `model` · `mode badge` · `context_pct` · `cost` · `tokens` · `queued` · `session_name` (right-aligned) · connection dot.

1. **Model segment + picker**: label `provider/modelId` (from `state.model`), click opens `ModelPicker`: `call("getAvailableModels")` on open, fuzzy-filter input, grouped by provider, Enter/click → `call("setModel", [provider, modelId])`. Show the thinking level suffix in the segment (`model · high`).
2. **Thinking segment**: click cycles via `call("cycleThinkingLevel")`; right-click (or a small chevron) opens `ThinkingPicker` listing all eight `ThinkingLevel` values → `call("setThinkingLevel", [level])`. Disabled state shown as `off`.
3. **Context segment**: `state.contextUsage.percent` rendered with the TUI's threshold coloring (green < 60 %, yellow < 85 %, red ≥ 85 % — copy `context-thresholds.ts` breakpoints if they differ; implementer reads that file). Tooltip shows `tokens / contextWindow`.
4. **Cost + tokens segments**: from `state.stats` (refreshed at `agent_end`): `$x.xx` and `↑in ↓out` abbreviated (12.3k). Click opens `StatsPopover` with the full `SessionStats` table + `dumpTools` list (the `/tools` replacement) + a `call("compact")` button and the auto-compaction checkbox (`call("setAutoCompaction", [!current])`).
5. **Mode badge**: render `plan`/`goal` when `goal_updated` events arrive (handle that event: store `goal`; badge shows `goal: <objective, 20 chars>`; clear on `goal_updated` with `goal:null`) and a `compacting…` badge while `state.isCompacting`.
6. **Session name**: `state.sessionName ?? short sessionId`; click → inline prompt → `dispatchInput("/rename " + title)` (agent-side handler renames; post-mutation broadcast updates the bar).
7. **Queue mode toggles** (in a settings popover on a gear icon): steering mode + follow-up mode selects (`all`/`one-at-a-time` → `setSteeringMode`/`setFollowUpMode`), auto-retry checkbox (`setAutoRetry`). Keep the existing reveal/soften toggles there too.

Verification (Phase 3): switch model in the picker → segment updates and the next turn uses it (observe `config` via the next `state` frame); cycle thinking → suffix changes; run a long session → context % climbs and recolors; after each turn cost/token numbers increase; `/rename web-parity` → right segment updates; toggle auto-compaction off → `getState` shows `autoCompactionEnabled:false` (check via a `/context` StatsPopover snapshot or devtools on the state frame).

### Phase 4 — Rich tool renderers + subagent plumbing

New: `src/components/tools/{BashTool,DiffTool,ReadTool,TodoTool,TaskTool,SearchTool,WebSearchTool}.tsx`, `src/components/tools/index.ts` (the `RENDERERS` map), `src/diff.ts`, `src/components/SubagentPanel.tsx`. Edits: `ToolCard.tsx` (dispatcher), `state.ts` (subagent frames, expansion store), `server/index.ts` already forwards subagent frames.

1. **Registry + expansion**: `ToolCard` dispatches per Decision C. Add `state.toolsExpanded: boolean` + a toolbar button and `Ctrl+O` keybind (window keydown, ignored when focus is in the textarea) flipping it; each renderer receives `expanded` and shows collapsed previews when false (default: running tools expanded, settled tools collapsed — preserves today's behavior).
2. **BashTool**: header `$ command` (from `args.command`), body `<pre class="terminal">` streaming `output`, exit badge, truncated note. Collapsed: last 5 lines + "N hidden lines".
3. **DiffTool** for `edit`/`write`/`apply_patch`: parse args (`edit`: path + edits with old/new text; `write`: path + content; if an arg shape is unrecognized, fall back to `GenericToolCard`). `src/diff.ts`: line-based diff — use the `diff` npm package (`bun add diff`, `import { diffLines } from "diff"`), render inline (not side-by-side) with `+`/`-` line coloring, 3 lines of context collapsing. For `write` of a new file show the content with line numbers, capped at 200 lines collapsed.
4. **ReadTool**: file path header, body = `<pre>` with line numbers (strip the tool's own line-number prefixes if present in output; otherwise number from `args.offset ?? 1`), syntax coloring is NOT in scope (plain text; marked already handles fenced code inside assistant text).
5. **TodoTool**: render `state.todoPhases` (live, post-mutation broadcast keeps it fresh): phases as sections, items with checkbox glyph by status (`pending`/`in_progress`/`done`), strikethrough on done. The tool card itself becomes a compact "todos updated" marker linking to the panel — simplest: render the full list inline as the card body.
6. **SearchTool** for `grep`/`glob`: output lines as a monospace list, each `path:line:` prefix rendered as a button that copies the path to the clipboard (no editor to open; clipboard is the web equivalent).
7. **WebSearchTool**: parse result URLs/titles from output when structured, else generic card; render as a link list (`target="_blank" rel="noreferrer"`).
8. **TaskTool + SubagentPanel**: on connect, `call("setSubagentSubscription", ["progress"])`. `state.subagents: Map<string, RpcSubagentSnapshot>` maintained from `subagent_lifecycle`/`subagent_progress` frames; `TaskTool` shows the spawned agent list with status glyphs; a status-bar `subagents (N)` segment (visible when N > 0) opens `SubagentPanel` listing agent, status, description, last-update time. Read-only view; per-agent transcript drill-down (`getSubagentMessages`) is a Phase 6 stretch, not this phase.

Edge cases: huge outputs still capped at 8000 chars by the existing `capTail` — renderers must tolerate truncated JSON-ish output (never parse `output` as JSON; only `args` is parsed, and it arrives as an object on `tool_execution_start`). `tool_execution_update` for edit tools carries partial text only — renderers show the generic streaming pre until `tool_execution_end` if args are incomplete.

Verification (Phase 4): ask the agent to "create /tmp/parity-demo.txt with 3 lines, then change line 2" → Write card shows numbered content, Edit card shows a red/green inline diff; "run ls -la and ps aux" → two bash cards stream then collapse on completion with `0` badges; "make a todo list of 3 items and do them" → TodoTool flips items to strikethrough live; "spawn a subagent to research X" (the `task` tool) → TaskTool lists it running → done; Ctrl+O toggles all cards open/closed.

### Phase 5 — Session management & compaction display

New: `SessionPicker.tsx`, `BranchPicker.tsx`, `CompactionItem` rendering in `MessageList`. Edits: `state.ts` (new events + history reload), `server/index.ts` (`/download` already there).

1. **SessionPicker** (`/resume` + a header button): on open send `list_sessions`; table of name/id, cwd, modified time, message count; filter input; select → `call("switchSession", [path])` → server broadcasts history+state → UI replaces the transcript (Phase 0 already resyncs on those frames; ensure `loadHistory` resets `nextId` and clears `items`/`live`/`pendingDeltas`).
2. **BranchPicker** (`/tree`, `/branch`, double-Esc on empty textarea): `call("getBranchMessages")` → list of `{entryId, text}`; select → `call("branch", [entryId])` → resync. Show the returned `text` as a notice ("branched at: …"). This is a linear list, not the TUI's DAG — deliberate simplification, recorded in Assumptions.
3. **Compaction items**: handle `auto_compaction_end` — push `kind:"compaction"` chat item (collapsed `<details>`) showing `action`, before/after token counts from `result`, `skipped`/`aborted`/error states; the existing `auto_compaction_start` notice stays. Handle `auto_retry_end`, `retry_fallback_applied`, `retry_fallback_succeeded` as `notice` items (parity with today's `auto_retry_start`).
4. **Export**: `/export` (Decision B) → `call("exportHtml")` → on `call_result.ok`, render an in-chat link `/download?path=<encoded>` that streams the file. Server path validation (Phase 0 step 2) rejects anything outside tmpdir/session dirs with 403.
5. **New session / drop**: `/new` already works; add `newSession` confirmation only when the transcript is non-empty (window.confirm is fine).

Verification (Phase 5): have a conversation, `/new`, talk again, `/resume` → picker lists both sessions with correct cwd/times → switching restores the old transcript verbatim; scroll to an earlier message, `/branch` → picker → branch → transcript truncates at that message and continues fresh; force a compaction (long session or `/compact`) → compaction item appears collapsed with token counts and expands on click; `/export` → HTML link downloads and opens in a browser tab.

### Phase 6 — Secondary surfaces (path toward maximal)

Independent slices; order by interest. Each reuses Phase 2's `Modal` and Phase 0's relay.

1. **Login flow**: `LoginPanel.tsx` — `call("getLoginProviders")`, per-provider Login button. Server side: `client.login(providerId, { onOpenUrl: (url, instructions, launchUrl) => send(ws, {type:"login_url", url, launchUrl, instructions}), onManualCodeInput: prompt => new Promise(resolve => pendingCodeInputs.set(req, resolve)) })`; browser opens `url` in a new tab (`window.open`) and shows a code-entry modal whose submit resolves the input via a new `login_code` client command. (This is the one place `call` doesn't fit: the callbacks are streaming — implement as two dedicated frame types.)
2. **Subagent drill-down**: click a subagent in `SubagentPanel` → `call("getSubagents")`-backed detail view + `getSubagentMessages` paged transcript (read-only).
3. **Extension UI dialogs**: NOT reachable without upstream changes (`RpcClient` exposes no public `extension_ui_request` subscribe/respond). Web-only stance: leave unimplemented; extensions that block on a dialog will hang until their timeout. If this becomes painful, the upstream patch is ~20 lines (`onExtensionUIRequest(listener)` + `respondToExtensionUI(response)` on `RpcClient`) — pre-decided fallback, not part of this plan.
4. **Settings/theme**: dark/light CSS variable toggle persisted in localStorage (replaces TUI theme presets); font-size stepper. No settings-schema port.

Explicitly excluded (terminal-only or out of "more or less"): collab/QR sharing, `/live` voice, STT/TTS, sixel/kitty inline graphics, OSC hyperlinks/appearance, SGR mouse, external `$EDITOR`, native scrollback replay, marketplace/plugins management UI, plan-review overlay, goal/loop/vibe dedicated UIs (the `goal_updated` badge from Phase 3 is the parity surface), desktop notifications (optional later: one `Notification.requestPermission()` wrapper on `notice` events).

## Critical files & anchors

- `server/index.ts` — the whole relay; today `handleCommand` is the switch to replace with `RPC_METHODS`; imports `RpcClient` from `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client`.
- `src/state.ts` — store + `applyEvent` (add `auto_compaction_end`, `auto_retry_end`, `retry_fallback_*`, `goal_updated` cases) + `connect()` backoff + `call()` promise map. The reveal-queue machinery (`pendingDeltas`, `flushDeltas`) is untouched by every phase.
- `src/protocol.ts` — single source of truth for the wire; every phase extends the unions exactly as written in Decision A.
- `node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-client.ts` — read-only reference for exact method signatures (lines 553–870) before wiring each `RPC_METHODS` row.
- `node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-types.ts` — `RpcSessionState` (line 100), `RpcAvailableSlashCommand` (line 126), subagent frame shapes.

## Verification (overall)

Every phase: `bun run check:types` + `bun test` must pass, plus its phase-specific manual checks above (all run with `OMP_WEB_CWD=<scratch dir> bun run dev:server` and `bun run dev:web`, browser at `http://localhost:4713`). Add unit tests only for new pure logic: `src/diff.ts` context-collapsing, `src/commands.ts` dispatch table, `src/history.ts` ring behavior — mirror the existing `markdown.test.ts` style (`bun test`). The end-to-end parity checklist after Phase 5: open a scratch repo in both the TUI (`omp`) and the web UI pointed at the same cwd, run the same 10-minute workflow (prompt, steer, queue, bash, edit-file diff, todos, model switch, thinking switch, compact, resume, branch, export) and confirm each step has a web equivalent reachable without touching the terminal.

## Assumptions & contingencies

- **Single-user local tool**: no auth on the WS/HTTP server (matches today). `/download` path validation is the only trust boundary added.
- **`/tree` renders as a linear branch-message list**, not the TUI's session-DAG. If `getBranchMessages` proves too flat in practice, the fallback is still the list — do not build a DAG view without a new decision.
- **Slash-command text output (`command_output`) is unreachable web-only**; the plan accepts this and natively renders the high-value ones (`/context`, `/usage`, `/tools`). If many more are missed in practice, the fallback is the ~20-line upstream `RpcClient` notification listener, which is a scope change requiring explicit approval.
- **Extension UI dialogs are out** for the same reason (Phase 6 step 3 names the exact fallback patch if priorities change).
- **`list_files` performance**: 10k-entry ceiling assumed fine for typical repos; if the target cwd is huge, the fallback is server-side `fd`-style streaming with the 150 ms debounce already in place — cap, don't re-architect.
- **Subagent payloads**: `RpcSubagentSnapshot`/progress payloads are treated as JSON-safe per `rpc-types.ts`; if a frame ever carries non-serializable data, `JSON.stringify` in `broadcast` throws — wrap subagent forwards in try/catch and drop on error (log server-side).
- If `apply_patch`/`edit` arg shapes differ from what Phase 4 step 3 expects, the renderer falls back to `GenericToolCard` — never crash the transcript on an unrecognized tool payload.
