# omp-web

A Solid.js web UI for [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent). The agent runs headless in JSON-RPC mode; a Bun WebSocket server bridges it to the browser. Brings the TUI's core feature set to the web.

## Features

### Chat & streaming
- Streaming assistant replies with text + thinking blocks, optional reveal-queue and soft-fade display modes
- Steer and follow-up prompts while the agent is streaming (queued with a chip indicator)
- Escape to abort; queued steer shown until consumed
- Image paste into the prompt with thumbnail tray
- Prompt history recall (↑/↓), auto-growing textarea
- Slash commands and `!` bang-shell with `@`-file and `/`-command autocomplete

### Rich tool rendering
- Dedicated renderers: bash terminal card, diff view, file read with line numbers, todo checklist, grep/glob search results, web search, task/agent tool
- Everything collapsible; unknown payloads fall back to a generic card
- Live subagent list in the status bar with progress; click through to a paged transcript drill-down

### Status & controls
- Status bar segments: model, thinking level, context usage %, session cost/tokens, streaming state, disconnected indicator
- Model and thinking-level pickers, session stats popover
- Settings popover: steering/follow-up modes, auto-retry, theme (dark/light), font-size stepper (both persisted)
- Session rename; new-session with confirmation

### Sessions
- Resume past sessions from a picker (full transcript restored)
- Branch a session from any earlier turn
- Compaction summaries rendered inline; auto-compaction and retry notices shown in the transcript
- `/export` downloads a standalone HTML transcript (served with path-traversal protection)

### Login providers
- OAuth login for 60+ providers from the settings popover: popup-safe flow with manual code entry and authenticated badges

## Develop

```sh
bun install
bun run dev:server   # agent RPC bridge on :4711
bun run dev:web      # vite dev server on :4713
```

Production: `bun run build && bun run start` (serves `dist/` on :4711).

The agent's working directory defaults to the server's cwd; override with `OMP_WEB_CWD`.

Checks: `bun run check:types`, `bun test`.

## Architecture

```
browser (Solid) ⇄ WebSocket ⇄ Bun server ⇄ stdio JSON-RPC ⇄ pi-coding-agent
```

- `server/index.ts` — spawns the agent CLI, relays a whitelist of RPC methods, broadcasts session events/state; serves static files and `/download`
- `src/protocol.ts` — client/server frame types (including unicast frames for OAuth)
- `src/state.ts` — client store: chat items, streaming, session state mirror, `call()` RPC helper

See `docs/web-tui-parity-plan.md` for the phased parity plan against the TUI.
