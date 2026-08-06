# omp-web

A Solid.js web UI for [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent). The agent runs in-process via its SDK (`createAgentSession`); a Bun WebSocket server bridges it to the browser. Brings the TUI's core feature set to the web, plus web-only affordances (inline images, clickable queue chips, per-message copy/branch, live bash streaming).

## Features

### Chat & streaming
- Streaming assistant replies with text + thinking blocks, optional reveal-queue and soft-fade display modes
- Steer and follow-up prompts while streaming; queue shorthand (`->` steer, `=>` follow-up) and `/queue`
- Queued-message chip bar above the composer: per-message previews, dequeue (× or Alt+↑ restores the text), clear-all
- Escape to abort; Ctrl+Enter queues a follow-up; double-Esc on an empty composer opens the branch picker
- Image paste into the prompt with thumbnail tray; images render inline in the transcript with click-to-zoom
- Prompt history recall (↑/↓) plus Ctrl+R fuzzy history search; auto-growing textarea
- Slash commands (`!` bang-shell, `$` python mode) with `@`-file, `/`-command autocomplete, and `/`-command help
- `!`/`!!` bash and `$`/`$$` python execution stream live output; abort buttons; exit-code and truncation badges

### Rich tool rendering
- Dedicated renderers: bash terminal card, diff view, file read with line numbers, todo checklist, grep/glob search results, web search, task/agent tool, eval, lsp, hub, ask Q&A
- Inline images inside tool results (computer/inspect_image screenshots); everything collapsible (Ctrl+O), unknown payloads fall back to a generic card
- Live subagent list in the status bar with progress; click through to a paged transcript drill-down, steer or abort running agents

### Status & controls
- Status bar segments: model, thinking level, plan/goal badges, context usage % (threshold-colored), cost/tokens, queued count, subagents, retry countdown, session name, streaming state, disconnected indicator
- Model and thinking-level pickers, session stats popover with context-usage breakdown bars and per-turn usage rows under each reply
- Goal mode popover (set/pause/resume/drop with budget), plan-mode toggle, usage reports panel (provider windows/limits), auto-retry live countdown
- Full settings panel (TUI `/settings` parity): left sidebar with the main sections and the active section's nested subsections on wide screens, horizontal tab bar fallback on narrow — a client-local "Web UI" tab (web-only toggles — theme preference, font-size stepper, desktop notifications, reveal queue, soft fade, fast mode, auto-retry, login providers — plus an Images group with `images.autoResize`/`images.blockImages`), one tab per web-relevant schema tab (Model, Interaction, Context, Memory, Files, Shell, Tools, Tasks, Providers), and a "TUI" tab limited to terminal-only appearance (Theme, Status Line, Display + terminal image rendering); per-type controls (toggles, selects, text/secret inputs, multiselect chips, per-provider request limits), changed-vs-default markers, global search, live condition gating (e.g. the Hindsight cluster appears when `memory.backend` is hindsight), session side effects (steering/interrupt modes, thinking level, sampling params), and in-process + disk persistence via the shared Settings singleton
- "TUI" tab: terminal-only settings — Theme, Status Line, and Display groups (`theme.*`, `statusLine.*`, `display.*`, `tui.*`, `terminal.*`, symbol preset, color-blind mode, hardware cursor, resolved-model badge) plus the terminal image renderer (`terminal.showImages`)
- Inline session rename in the status bar; new-session with confirmation

### Sessions
- Resume past sessions from a picker (full transcript restored); multi-session multiplexing with a live-sessions sidebar (attach/create/close, process stats)
- Branch or fork from any earlier turn (hover a user message for branch/copy)
- Compaction summaries rendered inline; auto-compaction, retry and model-fallback notices shown in the transcript
- `/handoff` starts a new session carrying a summary document; `/fresh` resets provider state; `/dump` downloads transcript + LLM request JSON
- `/export` downloads a standalone HTML transcript (served with path-traversal protection)

### Side channels & extras
- `/btw <question>` answers a side question in a streaming panel without touching the transcript
- OAuth login for 60+ providers from the settings panel: popup-safe flow with manual code entry and authenticated badges
- Desktop notifications when the tab is hidden (opt-in); Kimi, the streaming pet; 7 themes and a font-size stepper

## Develop

```sh
bun install
bun run dev:server   # agent SDK server on :4711
bun run dev:web      # vite dev server on :4713
```

Production: `bun run build && bun run start` (serves `dist/` on :4711).

The agent's working directory defaults to the server's cwd; override with `OMP_WEB_CWD`.

Checks: `bun run check:types`, `bun test`.

## Architecture

```
browser (Solid) ⇄ WebSocket ⇄ Bun server (in-process pi-coding-agent SDK)
```

- `server/index.ts` — hosts agent sessions in-process via `createAgentSession`, relays an allowlist of session methods, broadcasts session events/state; multiplexes multiple live sessions (attach/create/close from the Sessions sidebar); serves static files and `/download` (realpath-jailed to tmpdir/agent cwd/server cwd/session dirs)
- `src/protocol.ts` — client/server frame types (including unicast frames for OAuth, `ui_request`/`ui_response` for the `ask` tool, and streamed bash/python/ephemeral chunk frames)
- `src/state.ts` — client store: chat items, streaming, session state mirror, `call()` method helper, reconnect with backoff

See `docs/web-tui-parity-plan.md` for the phased parity plan against the TUI.
