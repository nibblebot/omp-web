# omp-web ↔ TUI Feature Parity — Inventory, Todo, Won't-Implement

Date: 2026-08-03. Supersedes nothing; extends `web-tui-parity-plan.md` (Phases 0–6 complete) with a full-source re-inventory.

**Sources** (all local):
- TUI inventory: `oh-my-pi/packages/tui`, `oh-my-pi/packages/coding-agent/src/modes`, `slash-commands/builtin-registry.ts` (69 commands), `config/keybindings.ts`, cross-checked against `oh-my-pi/docs/*`.
- omp-web state: `src/`, `server/index.ts` (Solid.js 1.9 + Bun; WS `/ws` → stdio JSON-RPC → `@oh-my-pi/pi-coding-agent` **17.1.8** dist).
- Backend boundary: `packages/coding-agent/src/session/agent-session.ts` — `AgentSession` is the client boundary; runtime behavior (tools, sessions, compaction, subagents, skills/hooks/extensions, models, events) comes **for free** over RPC. Only rendering/interaction is web-side.
- Reusable asset: `oh-my-pi/packages/collab-web/src/tool-render` — per-tool web renderers shared with HTML exports (React; design reference only, omp-web is Solid).

**Two load-bearing constraints (from 17.1.8 dist + prior plan decisions):**
1. **C1 — `command_output` frames dropped.** Agent-side slash commands execute via prompt passthrough, but their textual output frames are dropped by RpcClient → ~40 commands are fire-and-forget (no visible output). Fix = small upstream patch (forward a notification) + one WS frame.
2. **C2 — Extension/hook UI unreachable.** `extension_ui_request` bridging exists in newer source (`modes/rpc/rpc-types.ts:363-420`) but is not forwarded by the pinned 17.1.8 client → approvals/Ask-dialog/plan-review prompts block until timeout. Fix = same upstream patch seam.

---

## 1. Full TUI Feature Inventory

### 1.1 Slash commands — all 69 (`builtin-registry.ts:380–2719`)

Web status: ✅ = implemented web-local · 🔀 = passthrough works, output invisible (C1) or no UI · ❌ = missing/blocked · 🚫 = won't-implement (§4)

| # | Command (line) | Function | Web status |
|---|---|---|---|
| 1 | `/security` (382) | Security scans, 11 subcommands | ❌ deferred |
| 2 | `/settings` (402) | Fullscreen settings editor | ✅ SettingsPopover (subset) |
| 3 | `/setup` (410) | Provider setup wizard | ❌ deferred (login ✅) |
| 4 | `/plan` (427) | Toggle plan mode | 🔀 toggle, no review UI |
| 5 | `/plan-review` (446) | Re-open plan review overlay | ❌ blocked by C2 |
| 6 | `/vibe` (456) | Toggle vibe mode | 🔀 toggle only |
| 7 | `/goal` (472) | Toggle/set goal mode | 🔀 toggle + badge |
| 8 | `/guided-goal` (496) | Interview → goal setup | 🔀 chat-driven |
| 9 | `/loop` (509) | Loop mode count/duration | 🔀 toggle only |
| 10 | `/queue` (530) | Queue message after yield | ✅ Ctrl+Enter follow-up |
| 11 | `/model` (539) | Model hub | ✅ ModelPicker (hub roles/fallbacks 🚫) |
| 12 | `/switch` (583) | Session-only model switch | ✅ same picker |
| 13 | `/fast` (595) | Priority service tier | 🔀 no readback |
| 14 | `/computer` (664) | Toggle computer-use tool | 🔀 no readback |
| 15 | `/vision` (708) | Vision delegation on/off/auto | 🔀 no readback |
| 16 | `/prewalk` (749) | Cheap model for next action | 🔀 |
| 17 | `/advisor` (773) | Second-model review config | 🔀 config UI ❌ |
| 18 | `/export` (889) | Export session HTML | ✅ + `/download` |
| 19 | `/dump` (912) | Transcript→clipboard + JSON | ❌ (easy web analog) |
| 20 | `/share` (944) | Encrypted share link | 🔀 link invisible (C1) |
| 21 | `/collab` (969) | Live share via relay | 🚫 (collab-web SPA exists) |
| 22 | `/join` (1055) | Join collab session | 🚫 |
| 23 | `/leave` (1083) | Leave collab | 🚫 |
| 24 | `/browser` (1106) | Headless↔visible toggle | 🔀 no readback |
| 25 | `/copy` (1181) | Copy-picker selector | 🚫 native selection + copy buttons |
| 26 | `/todo` (1220) | View/modify agent todos | ✅ TodoTool card (view) |
| 27 | `/session` (1255) | info/delete/pin | ❌ picker lacks actions |
| 28 | `/jobs` (1332) | Async background jobs | ❌ |
| 29 | `/usage` (1373) | Provider usage/limits + reset | ✅ local (from state); reset 🔀 |
| 30 | `/stats` (1415) | Local stats dashboard | ❌ link-out (easy) |
| 31 | `/changelog` (1434) | Show changelog | 🔀 output invisible (C1) |
| 32 | `/hotkeys` (1459) | Shortcuts panel | ✅ help modal |
| 33 | `/tools` (1467) | Tools visible to agent | ✅ StatsPopover dumpTools |
| 34 | `/context` (1495) | Context usage breakdown | ✅ local (from state) |
| 35 | `/extensions` (1513) | Extension Control Center | ❌ blocked by C2 |
| 36 | `/agents` (1522) | Agent Control Center | 🔶 SubagentPanel (subset) |
| 37 | `/branch` (1530) | Branch from user message | ✅ BranchPicker (linear) |
| 38 | `/fork` (1542) | Fork from message | ❌ backend `fork` exists |
| 39 | `/tree` (1550) | Session DAG navigation | 🔶 linear list; DAG parked |
| 40 | `/login` (1558) | OAuth login | ✅ LoginPanel |
| 41 | `/logout` (1610) | OAuth logout | ❌ badges only |
| 42 | `/mcp` (1632) | MCP add/list/remove/test | 🔀 passthrough; wizard ❌ |
| 43 | `/ssh` (1671) | SSH host management | 🔀 passthrough; UI ❌ |
| 44 | `/new` `/clear` (1693) | New session | ✅ + confirm guard |
| 45 | `/fresh` (1702) | Reset provider stream state | 🔀 |
| 46 | `/drop` (1723) | Delete session + new | ❌ |
| 47 | `/compact` (1731) | Compact w/ modes | ✅ StatsPopover + passthrough |
| 48 | `/shake` (1779) | Drop heavy context | 🔀 |
| 49 | `/handoff` (1806) | Hand off to new session | ❌ one allowlist row away |
| 50 | `/resume` (1817) | Resume session/foreign | ✅ (foreign @claude/@codex ❌) |
| 51 | `/btw` (1847) | Ephemeral side question | ❌ panel TUI-mode-only |
| 52 | `/tan` (1858) | Background tangent agent | ❌ deferred |
| 53 | `/omfg` (1869) | Forge TTSR rule from complaint | ❌ deferred |
| 54 | `/retry` (1880) | Retry failed turn | 🔀 no UI affordance |
| 55 | `/debug` (1891) | Debug tools selector | 🚫 devtools/server logs |
| 56 | `/memory` (1899) | Memory maintenance | 🔀 output invisible (C1) |
| 57 | `/rename` (1971) | Rename session | ✅ |
| 58 | `/move` (1998) | Move session directory | ❌ |
| 59 | `/add-dir` (2043) | Add workspace dir | ❌ |
| 60 | `/remove-dir` (2074) | Remove workspace dir | ❌ |
| 61 | `/dirs` (2102) | List workspace dirs | 🔀 output invisible (C1) |
| 62 | `/exit` (2111) | Exit app | ✅ (tab close semantics) |
| 63 | `/marketplace` (2116) | Plugin marketplace | 🚫 management UI (deferred→🚫) |
| 64 | `/plugins` (2495) | Plugin list/enable/disable | 🚫 same |
| 65 | `/reload-plugins` (2625) | Reload plugins | 🔀 |
| 66 | `/force` (2640) | Force tool next turn | 🔀 |
| 67 | `/live` (2689) | Realtime voice mode | 🚫 |
| 68 | `/pause` (2697) | Freeze all agents | ❌ backend pause gate exists |
| 69 | `/quit` (2705) | Quit | ✅ |

Beyond registry: `/init` (embedded fallback), `/skill:<name>`, file-based/extension/MCP commands — passthrough ✅, merged into autocomplete via `available_commands` ✅.

### 1.2 Keybindings (`tui/src/keybindings.ts` + `coding-agent/src/config/keybindings.ts`)

**Port candidates** (web-missing): Ctrl+P / Shift+Ctrl+P model cycle · Ctrl+T thinking-block visibility · Ctrl+Shift+O tool visibility · Alt+R retry · Ctrl+R history fuzzy search · Alt+↑ dequeue · double-Esc branch gesture (was in plan Phase 5, never implemented) · Alt+Shift+P plan toggle.
**Already ported**: Enter/Ctrl+Enter/Shift+Enter send modes · Esc abort · ↑↓ history · Ctrl+O expand-all · Tab autocomplete.
**Won't port** (native browser): all editor cursor/word/delete ops, kill ring, undo, PageUp/Down, Ctrl+C/Z/D terminal semantics, Ctrl+G external editor, mouse chords.

### 1.3 Panels / overlays (60+ in `modes/components/`)

| Panel | Source | Web status |
|---|---|---|
| Approval prompt (Approve/Deny) | `extensibility/extensions/wrapper.ts:317` | ❌ **blocked by C2 — critical** |
| Ask-tool multi-question dialog | `ask-dialog.ts` | ❌ blocked by C2 |
| Plan review overlay + TOC | `plan-review-overlay.ts` | ❌ blocked by C2 |
| Hook UI (select/input/editor/confirm) + widgets | `hook-*.ts` | ❌ blocked by C2 |
| Autocomplete popup | `tui/autocomplete.ts` | ✅ / + @, fuzzy |
| Model hub / picker / browser | `model-hub.ts` etc | ✅ picker; hub editor 🚫 |
| Session selector (rename/delete/sort/path) | `session-selector.ts` | 🔶 filter+switch only |
| Tree selector (DAG) | `tree-selector.ts` | 🔶 linear; DAG parked |
| Settings editor + theme | `settings-selector.ts` | ✅ subset |
| Agent hub / dashboard / transcript viewer | `agent-hub.ts` | 🔶 SubagentPanel+drill-down (read-only) |
| Extension dashboard | `extension-dashboard.ts` | ❌ |
| Login/OAuth/logout dialogs | `login-dialog.ts` | ✅ login; logout ❌ |
| MCP wizard / SSH controller | `mcp-add-wizard.ts` | ❌ |
| Copy selector | `copy-selector.ts` | 🚫 native |
| History search | `history-search.ts` | ❌ (↑↓ ring only) |
| Plugin marketplace UI | `plugin-selector.ts` | 🚫 |
| Todo panel | `todoContainer` | 🔶 inline TodoTool card |
| Pause screen | `pause-screen.ts` | ❌ |
| Move overlay / queue-mode / reset-usage / advisor-config | various | ❌ (queue modes ✅ settings) |
| Diff viewer | `components/diff.ts` | ✅ inline diffs |
| Setup wizard / welcome / splash | `setup-wizard/`, `welcome.ts` | ❌ deferred |
| btw / omfg panels | `btw-panel.ts`, `omfg-panel.ts` | ❌ deferred |
| Usage rows / reset-usage | `usage-row.ts` | 🔶 stats popover subset |

### 1.4 Editor (composer) — `tui/components/editor.ts` + `custom-editor.ts`

Ported: multi-line, history ring, autocomplete host, image paste (base64 tray), steer/follow-up.
Missing: large-paste collapse `[Paste #N]` markers · image attach via file path/picker · Ctrl+R history search · magic-keyword shimmer (cosmetic).
Won't port: bracketed-paste assembly, kill ring, custom undo, word ops, IME chrome, external editor, STT hold-Space.

### 1.5 Status / chrome

StatusLine 24 segments (`status-line/segments.ts`) — web has fixed bar: model+thinking ✅, context % ✅ (thresholds ported), cost/tokens ✅, mode badges 🔶 (goal only), subagents ✅, queued ✅. Missing: **cwd + git branch** (footer.ts fs.watch), usage windows, time_spent, session segment, cache stats, configurable presets/separators (🚫 config-file territory).
Terminal title/progress states → web analog: `document.title` + favicon attention state (cheap, high value).

### 1.6 Rendering

Markdown: marked+DOMPurify ✅, streaming frozen-prefix ✅, reveal modes ✅. Missing: **syntax highlighting** (explicitly parked) · LaTeX math (TUI: →unicode; web: raw) · tables render via marked ✅.
Tool rendering: registry + 10 renderers + generic fallback ✅. Missing: hashline/apply_patch arg shapes (17.1.8) fall back to generic card · read-tool grouping · image content blocks in transcript.
Engine/ANSI layer: all 🚫 terminal-bound.

### 1.7 Media / terminal integrations — ALL 🚫 (§4)

Kitty/iTerm2/sixel inline images, OSC 0/8/9/9;4/11/52/66/99/5522/2031, BEL/D-Bus notify, SGR mouse, kitty keyboard protocol, mux (tmux/zellij) handling, bracketed paste, clipboard image reads, capability probing.

### 1.8 Session management

Resume ✅ (foreign sessions ❌) · branch ✅ linear · fork ❌ · tree DAG parked · rename ✅ · new ✅ · drop/fresh ❌/🔀 · delete/pin ❌ · move/dirs ❌ · export ✅ · share 🔀(C1) · dump ❌ · compact ✅ · shake 🔀 · handoff ❌ (one row) · auto-title ✅ backend.

### 1.9 Other surfaces

Approvals (tiered modes + per-tool policy) ❌ C2-critical · plan mode 🔀 · vibe/goal/loop 🔀 toggles · message queue (view/dequeue) 🔶 chip only · desktop notifications ❌ (Notification API analog) · TTSR/late-diagnostics transient messages 🔶 via notice events · stats dashboard ❌ link · debug tooling 🚫 · extension custom UI ❌ C2.

---

## 2. TODO — Port to omp-web (priority order)

### Tier 0 — Unblockers (server/upstream, small, gates everything below)
- [ ] **T0.1 Forward `command_output`** (fixes C1): upstream RpcClient patch → WS `command_output` frame → render as system/notice chat item. Unlocks visible output for /share, /memory, /changelog, /dirs, /mcp, /ssh, /reload-plugins, advisor/fast/vision status. *Files: `server/index.ts`, upstream `pi-coding-agent` RpcClient, `src/protocol.ts`, `src/state.ts`.*
- [ ] **T0.2 Wire extension-UI bridge** (fixes C2): forward `extension_ui_request`/`respond` frames (select/confirm/input) → web modal host. Verify whether pinned 17.1.8 emits them; if not, same upstream patch seam as T0.1. **Gates approvals, Ask-dialog, plan-review, hook UI.**
- [ ] **T0.3 Add `handoff` to `RPC_METHODS` allowlist** + `/handoff` local command. One row + one entry.

### Tier 1 — Core interactive parity
- [ ] **T1.1 Approval prompts**: Approve/Deny modal w/ tool-tier display + approval-mode setting (always-ask/write/yolo). Depends T0.2. Without it approval-gated turns stall.
- [ ] **T1.2 Ask-tool dialog**: tabbed multi-question modal w/ custom answers (port of `ask-dialog.ts` semantics). Depends T0.2.
- [ ] **T1.3 Plan mode**: status-bar toggle (Alt+Shift+P), plan-review overlay (approve/edit) for latest plan. Depends T0.2.
- [ ] **T1.4 `/retry` affordance**: retry button on error banner + Alt+R.
- [ ] **T1.5 Render image content blocks** in transcript (user + tool-result images as `<img>`).
- [ ] **T1.6 Syntax highlighting**: code fences + ReadTool/DiffTool (shiki or highlight.js; extend DOMPurify allowlist). Reverses prior out-of-scope decision — see §3 D3.
- [ ] **T1.7 Desktop notifications**: Notification API on `notice`/`agent_end` when tab hidden + `document.title` attention state.

### Tier 2 — Session & state completeness
- [ ] **T2.1 Session actions**: delete/pin/rename-in-list in SessionPicker (`/session delete|pin`); `/drop`, `/fresh` commands.
- [ ] **T2.2 Fork UI**: BranchPicker gains fork action (user-message selector → `fork`).
- [ ] **T2.3 Mode toggles**: plan/vibe/goal/loop/fast visible toggles w/ state readback where RpcSessionState exposes it; goal-set input.
- [ ] **T2.4 Jobs panel**: async background jobs (`/jobs`) — extend SubagentPanel or dedicated popover.
- [ ] **T2.5 Workspace dirs**: `/dirs` list, `/add-dir`, `/remove-dir`, `/move` (settings section; list output needs T0.1).
- [ ] **T2.6 Keyboard parity batch**: Ctrl+P/Shift+Ctrl+P model cycle, Ctrl+T thinking visibility, Ctrl+Shift+O tool visibility, double-Esc branch gesture (finish plan Phase 5 step 2).
- [ ] **T2.7 History search**: Ctrl+R fuzzy over localStorage ring.
- [ ] **T2.8 Queue management**: view queued messages, dequeue (Alt+↑).
- [ ] **T2.9 Composer paste/attach**: `[Paste #N]` collapse for large pastes; attach-file button (picker → ImageContent).
- [ ] **T2.10 `/dump` analog**: copy-transcript button + JSON download via `/download`.
- [ ] **T2.11 Logout**: provider logout in LoginPanel (`/logout` account selector).
- [ ] **T2.12 Status bar**: cwd + git branch segment (server-side git query), usage windows if cheap.
- [ ] **T2.13 Per-message copy buttons** (assistant text, code blocks).
- [ ] **T2.14 Feature toggles in settings**: /computer, /browser, /vision, /prewalk, /fast, /advisor (on/off rows; readback where exposed, else fire-and-forget noted).
- [ ] **T2.15 Foreign sessions** in SessionPicker (@claude/@codex import path — backend `session-entries` supports).
- [ ] **T2.16 Pause**: `/pause` toggle + paused banner (backend pause gate exists).
- [ ] **T2.17 Hashline/apply_patch arg shapes** for DiffTool (17.1.8 edit format) instead of generic fallback.

### Tier 3 — Deferred (large scope or needs decision; not wont-implement)
- [ ] **T3.1 Session DAG tree view** (`/tree`) — explicitly parked; needs re-decision (D4).
- [ ] **T3.2 Extension Control Center** (read-only dashboard feasible post-T0.2).
- [ ] **T3.3 MCP add wizard + SSH management UIs** (passthrough works today).
- [ ] **T3.4 `/security` scan UI** (11 subcommands).
- [ ] **T3.5 `/stats` dashboard link/embed** (packages/stats runs its own web server).
- [ ] **T3.6 `/btw`, `/tan`, `/omfg` panels** (TUI-mode controllers; RPC surface unclear).
- [ ] **T3.7 Setup wizard + welcome screen** (first-run; LoginPanel covers the core).
- [ ] **T3.8 Agent hub upgrades**: kill/revive/chat subagent (agent-cmd), parked-agent transcript viewer (collab-web has reference impl).
- [ ] **T3.9 LaTeX math** (KaTeX + sanitize allowlist).
- [ ] **T3.10 Changelog viewer** (post-T0.1 trivial).
- [ ] **T3.11 Auto-retry readback**: RpcSessionState lacks `autoRetryEnabled`; checkbox is fire-and-forget (upstream state addition).

---

## 3. Open decision points

- **D1 (T0.1/T0.2)**: patch upstream `pi-coding-agent` (source is local at `~/repos/oh-my-pi`, newer than pinned 17.1.8) and/or point omp-web server at the local build. Prior plan assumed "no upstream changes" — that constraint now costs approvals, plan-review, and ~40 command outputs. Recommend dropping it.
- **D2**: multi-session/multi-tab architecture? Current server spawns ONE global agent shared by all tabs. Beyond parity, but blocks per-tab sessions.
- **D3**: syntax highlighting re-decision (prior: out of scope). Largest visible rendering gap.
- **D4**: session DAG tree re-decision (prior: do not build).
- **D5**: plugin/marketplace UI — keep excluded (config-file territory) or read-only list?

---

## 4. WON'T-IMPLEMENT

### 4.1 Terminal-bound (no web analog; browser native replaces each)
| TUI feature | Browser replacement |
|---|---|
| Kitty/iTerm2/Sixel inline images | `<img>` / canvas |
| OSC 0 title, OSC 9;4 progress | `document.title`, favicon state |
| OSC 8 hyperlinks | native `<a>` |
| OSC 9/99/BEL + D-Bus desktop notify | Notification API (T1.7) |
| OSC 11/2031 appearance detection | `prefers-color-scheme` (done) |
| OSC 52 clipboard + native clipboard backends | `navigator.clipboard` |
| OSC 66 text sizing, OSC 5522 paste | font-size stepper (done), native paste |
| Alt-screen, differential renderer, CSI 2026, DECCARA, scrollback commit | DOM rendering |
| Kitty keyboard protocol, modifyOtherKeys, SGR mouse | DOM key/mouse events |
| Bracketed paste assembly, tmux re-encode | native paste events |
| tmux/zellij/screen mux handling | N/A |
| Editor kill-ring, word-ops, custom undo, visual-line cursor | native textarea |
| External $EDITOR (Ctrl+G) | textarea is the editor |
| Ctrl+Z suspend, Ctrl+D EOF | tab lifecycle |
| Terminal capability probing/true-color | CSS |
| Terminal QR for /collab, codex fireworks, tiny-title progress | moot (collab excluded) |
| ANSI markdown renderer (116KB) | marked+DOMPurify (done) |

### 4.2 Product/scope exclusions (kept from prior plan, re-confirmed)
- **`/collab` + `/join` + `/leave` + QR live sharing** — separate product; `packages/collab-web` guest SPA already covers the browser side.
- **`/live` voice mode, STT push-to-talk, voice visualizer** — audio product surface.
- **`/copy` selector panel** — native selection + per-block copy buttons (T2.13) instead.
- **`/debug` selector** (raw SSE, terminal info) — browser devtools + server logs.
- **Model hub roles/fallbacks/cycle-order editor** — config-file editing stays in TUI; picker covers switching.
- **Marketplace/plugins management UI** — pending D5.
- **Startup splash/welcome terminal screens** — web landing; LoginPanel covers setup.
- **Magic-keyword shimmer** — cosmetic terminal flourish.

---

*Working notes: full subagent inventories with per-file line refs available in session history (TuiInventory, WebInventory, BackendBoundary scouts).*
