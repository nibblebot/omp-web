# SDK Conversion Plan — omp-web

Replace the stdio JSON-RPC bridge with the in-process SDK (`createAgentSession`), add
multi-session multiplexing, and remove the settings/ask/subagent hacks. Execute top to
bottom; each phase is independently verifiable and leaves the app working.

**Do not start from scratch.** The client never speaks JSON-RPC — it speaks our own
WebSocket protocol (`src/protocol.ts`). The RPC coupling is quarantined in
`server/index.ts` plus type imports. ~80% of the repo (all renderers, the event
pipeline, styles, pickers) is transport-agnostic and survives untouched.

All API claims below were verified against the installed
`@oh-my-pi/pi-coding-agent@17.1.8` package source. Line refs point into
`node_modules/@oh-my-pi/pi-coding-agent/src/`.

---

## 0. Prerequisites

- Bun **≥ 1.3.14** (SDK requirement). Check `bun --version`.
- `bun install` already run; deps at 17.1.8.

---

## 1. Verified API facts (read before writing any code)

### 1.1 Imports

- **There is NO `/sdk` subpath** in the published package (`exports["./sdk"]` is null —
  the online docs describe one, this version doesn't ship it). The package root does
  `export * from "./sdk"` (`src/index.ts`), and the exports map has a `./*` wildcard so
  deep subpaths work. Exact, verified import locations:
  - Package root `@oh-my-pi/pi-coding-agent`: `createAgentSession`,
    `discoverAuthStorage`, `Settings` (via `./sdk`), `ModelRegistry` (via
    `./config/model-registry`), `ExtensionUIContext` type (via
    `./extensibility/extensions`).
  - `AgentRegistry`, `AgentRef`, `MAIN_AGENT_ID` →
    `@oh-my-pi/pi-coding-agent/registry/agent-registry` (NOT root-exported).
  - `EventBus` → `@oh-my-pi/pi-coding-agent/utils/event-bus` (NOT root-exported).
  - `SessionManager` → `@oh-my-pi/pi-coding-agent/session/session-manager` (NOT
    root-exported).
  - `AuthStorage` type → `@oh-my-pi/pi-coding-agent/session/auth-storage`.
  - Subagent bus channel constants (`TASK_SUBAGENT_LIFECYCLE_CHANNEL`,
    `TASK_SUBAGENT_PROGRESS_CHANNEL`, `TASK_SUBAGENT_EVENT_CHANNEL` and payload types
    `SubagentLifecyclePayload` / `SubagentProgressPayload` / `SubagentEventPayload`) →
    `@oh-my-pi/pi-coding-agent/task` (there IS a `./task` subpath export) or
    `.../task/types`.
  - `getOAuthProviders` → `@oh-my-pi/pi-ai/oauth`.
  - `buildAvailableSlashCommands(session)` →
    `@oh-my-pi/pi-coding-agent/slash-commands/available-commands`.
  - `executeAcpBuiltinSlashCommand` → `@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins`
    (this is how RPC mode runs `/export`, `/compact`, etc. typed into the chat — reuse
    it or slash parity regresses).
  - `USER_INTERRUPT_LABEL` → `@oh-my-pi/pi-coding-agent/session/messages`.

### 1.2 `createAgentSession(options)` → result

Options we need (`src/sdk.ts:338+`):
`cwd`, `agentDir`, `authStorage`, `modelRegistry`, `settings`, `sessionManager`,
`eventBus`, `agentRegistry`, `hasUI` (default **false** — line 1641), `enableMCP`,
`enableLsp`, `model`, `thinkingLevel`.

Result (`src/sdk.ts:567-581`): `{ session, extensionsResult, setToolUIContext,
mcpManager?, modelFallbackMessage?, lspServers?, eventBus }`.
`setToolUIContext(uiContext, hasUI)` feeds the tool UI context (line 2947).

Hard rules:
- If both `authStorage` and `modelRegistry` are passed, the registry MUST have been
  constructed with that same authStorage instance; creation rejects divergent stores.
- **Multiplexing**: pass a **private `new AgentRegistry()` per session**. The default
  `AgentRegistry.global()` admits only one `"Main"` identity (sdk.ts:1595).
- **Never share loaded extension instances across sessions** — pass
  `preloadedExtensionPaths`, not `preloadedExtensions`, when reusing discovery.
- Give each session its own `EventBus` (default is per-session anyway) and its own
  `SessionManager` (`SessionManager.create(cwd)` file-backed keeps resume/branch
  working; `SessionManager.inMemory()` for ephemeral).
- `hasUI`: pass `hasUI: true` in options AND call
  `setToolUIContext(uiContext, true)`. The `ask` tool only registers when
  `session.hasUI` is true (`AskTool.createIf()`), and `execute()` requires
  `context.ui`. Default `hasUI: false` is why ask never worked cleanly over RPC.

### 1.3 RPC command → `AgentSession` method mapping

Extracted verbatim from the RPC dispatch (`modes/rpc/rpc-mode.ts:988-1420`). Our new
server reimplements exactly this adapter, minus stdio:

| Current `RPC_METHODS` key | SDK call |
|---|---|
| `prompt` | fire-and-forget `session.prompt(text, { images, streamingBehavior })` — do NOT await in the WS handler (rpc-mode:1035 deliberately doesn't; the promise resolves at turn end). Pre-pass through `executeAcpBuiltinSlashCommand` for `/` builtins (rpc-mode:988-1038 is the reference flow). |
| `steer` / `followUp` | `await session.steer(text, images)` / `session.followUp(text, images)` |
| `abort` | `await session.abort({ reason: USER_INTERRUPT_LABEL })` (`USER_INTERRUPT_LABEL` from `session/messages`) |
| `abortAndPrompt` | `await session.abort({...})` then fire-and-forget `session.prompt(...)` with `.catch` |
| `newSession` / `switchSession` / `branch` | `session.newSession(opts)` / `session.switchSession(path)` / `session.branch(entryId)` — all return `{ cancelled }`-shaped results; `branch` also returns `selectedText` |
| `compact` | `session.compact(customInstructions?)` |
| `setModel` | find in `session.getAvailableModels()`, on miss `await session.modelRegistry.awaitBackgroundRefresh()` and retry, then `await session.setModel(model)` (rpc-mode:1169-1188) |
| `cycleModel` / `cycleThinkingLevel` | same names on session |
| `getAvailableModels` | `await session.modelRegistry.awaitBackgroundRefresh()` then `session.getAvailableModels()` |
| `setThinkingLevel` | `session.setThinkingLevel(level)` |
| `setSteeringMode` / `setFollowUpMode` | same names (also `setInterruptMode` exists) |
| `setAutoCompaction` | `session.setAutoCompactionEnabled(enabled)` |
| `setAutoRetry` | `session.setAutoRetryEnabled(enabled)` — and **`session.autoRetryEnabled` getter EXISTS** (agent-session.ts:6671). The `SettingsPopover.tsx:15` fire-and-forget hack can die: add `autoRetryEnabled` to the state snapshot. |
| `abortRetry` / `abortBash` | same names |
| `bash` | `session.executeBash(command)` |
| `getSessionStats` | `session.getSessionStats()` |
| `exportHtml` | `session.exportToHtml(outputPath?)` → `{ path }` |
| `getBranchMessages` | `session.getUserMessagesForBranching()` |
| `getLoginProviders` | `getOAuthProviders().map(p => ({ id, name, available, authenticated: authStorage.hasAuth(p.id) }))` |
| `login` | `authStorage.login(providerId, { onAuth, onProgress, onPrompt })` then `await modelRegistry.refreshProvider(providerId, "online")` — see §1.5 |
| `getSubagents` | `agentRegistry.list()` (richer than the RPC snapshot — see §1.4) |
| `getSubagentMessages` | read the subagent's session `.jsonl` directly, or `SessionManager.open(path)`. RPC's implementation is `readRpcSubagentTranscript` = `fs.readFile` + `parseSessionEntries` (`modes/rpc/rpc-subagents.ts:1-15`) — copy that logic or import it |
| `setSubagentSubscription` | **delete** — it was an RPC bandwidth gate, meaningless in-process |

### 1.4 State snapshot recipe (replaces `get_state`)

Build the SAME shape the client already consumes (keep the `RpcSessionState` field
names for Phase 1 so `src/state.ts` doesn't change — rename to `WebSessionState` in
Phase 4):

```ts
const state = {
  model: session.model,
  thinkingLevel: session.thinkingLevel,
  isStreaming: session.isStreaming,
  isCompacting: session.isCompacting,
  steeringMode: session.steeringMode,
  followUpMode: session.followUpMode,
  interruptMode: session.interruptMode,
  sessionFile: session.sessionFile,
  sessionId: session.sessionId,
  sessionName: session.sessionName,
  autoCompactionEnabled: session.autoCompactionEnabled,
  autoRetryEnabled: session.autoRetryEnabled,        // NEW — kills the hack
  messageCount: session.messages.length,
  queuedMessageCount: session.queuedMessageCount,
  todoPhases: session.getTodoPhases(),
  systemPrompt: session.systemPrompt,
  dumpTools: session.agent.state.tools.map(t => ({
    name: t.name, description: t.description,
    parameters: isZodSchema(t.parameters) ? zodToWireSchema(t.parameters) : t.parameters,
    examples: t.examples,
  })),
  contextUsage: session.getContextUsage(),
};
```
(rpc-mode.ts:1074-1101; `isZodSchema`/`zodToWireSchema` are imported there — copy the
imports or skip `dumpTools` if the UI doesn't use it; check `state.ts` first.)

History: `session.messages` (what `get_messages` returns). `session.sessionManager.getLeafId()`
exists if paging is ever needed.

### 1.5 Login flow (replaces `loginWithCallbacks` + `pendingCodeInputs` hack)

`authStorage.login(providerId, callbacks)` (rpc-mode.ts:1379-1419):
- `onAuth(info)` → push our `login_url` frame (`info.url`, `info.launchUrl`,
  `info.instructions`) to the requesting socket.
- `onProgress(message)` → toast/notify frame.
- `onPrompt(prompt)` → push `login_code_request`, await the socket's reply.
  **Keep the rpc-mode guard**: if `onPrompt` fires before any `onAuth`, reject —
  that provider needs pre-auth interactive input the web UI can't satisfy.
- After success: `await modelRegistry.refreshProvider(providerId, "online")`.

The per-socket pending-code map in `server/index.ts` survives as-is (it's our WS
protocol, not RPC hackery) — only the callback wiring changes.

### 1.6 Subagents: observation + control

Observation (ports 1:1):
- `eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL | …_PROGRESS_CHANNEL | …_EVENT_CHANNEL, cb)`
  — this is literally what `RpcSubagentRegistry` subscribes to
  (`modes/rpc/rpc-subagents.ts:118-124`). Same payload types, no stdio.
- Roster: `agentRegistry.list()` → `AgentRef[]` with `id`, `displayName`, `kind`
  (`"main"|"sub"|"advisor"` — hide advisors), `status`
  (`"running"|"idle"|"parked"|"aborted"`), `activity` (one-line gist),
  `sessionFile`, `session` (`registry/agent-registry.ts`). Subscribe
  `agentRegistry.onChange(...)` for registered/status_changed/removed.

Control (new capabilities, RPC has none):
- `ref.session?.subscribe(...)` — full per-subagent event stream for drill-down.
- `ref.session?.steer(text)` — steer a running subagent mid-task (designed path; the
  IRC-delivery mechanism does exactly this).
- `ref.session?.abort()` — kill ONE subagent; Main and siblings unaffected.
- Parked refs have `session: null` — cannot steer; revive via
  `registry/agent-lifecycle.ts` or re-open the session file.
- DON'T call lifecycle methods (`newSession`/`switchSession`/`dispose`) on a subagent
  session — the task executor owns those. `steer`/`abort`/`subscribe` are safe.

### 1.7 `ExtensionUIContext` for the web host

Full interface: `extensibility/extensions/types.ts:227`. For a headless web host,
implement the dialog subset for real and stub the terminal rest:

- Real: `select`, `confirm`, `input`, `editor`, `askDialog` (rich multi-question form —
  this is the actual `ask` tool UI; result type `ExtensionAskDialogResult`), `notify`
  (toast frame).
- Stub/no-op: `onTerminalInput`, `setStatus`, `setWorkingMessage`, `setWidget`,
  `setFooter`, `setHeader`, `setTitle`, `custom`, `setEditorText`, `pasteToEditor`,
  `getEditorText` (return `""`), `addAutocompleteProvider`, `setEditorComponent`,
  theme getters/setters (`theme` readonly field is required — stub it),
  `getToolsExpanded`/`setToolsExpanded`.

Pattern per dialog method: generate request id, push `{ type: "ui_request", id,
method, ... }` to the socket(s) owning that session, store resolve/reject in a pending
map, resolve on the client's `ui_response` command. Reject pending entries on socket
close and on session dispose. This replaces the `extension_ui_request` frame scraping
with typed function calls.

### 1.8 Lifecycle

- Per-session teardown: `session.beginDispose()` (sync admission barrier) →
  `await session.dispose()`. Both idempotent.
- Server shutdown: dispose every session in the map.

---

## 2. File inventory

### Keep untouched
- `src/components/**` (all renderers, modals, pickers), `src/markdown.ts`,
  `src/diff.ts`, `src/theme.ts`, `src/kimi-sprite.ts`, `src/styles.css`,
  `src/App.tsx`, tests, `vite.config.ts`.
- `src/state.ts` `applyEvent()` (line 281) — switches on `AgentSessionEvent`, which is
  exactly what `session.subscribe()` emits. Zero changes.
- `server/index.ts` static/`/download`/`list_files` halves.

### Adapt
- `src/protocol.ts` — Phase 1: keep frame shapes (swap `rpc-types` imports for local
  type copies). Phase 2: add `sessionId`. Phase 4: drop `RpcSessionState` for
  `WebSessionState`.
- `src/state.ts` — `call()` helper keeps its shape; add sessionId plumbing in Phase 2.
- `src/components/SettingsPopover.tsx` — read `autoRetryEnabled` from state instead of
  the local fire-and-forget signal (line 15-16 comment marks the spot).
- `src/components/LoginPanel.tsx` — same frames, now backed by real callbacks.

### Rewrite
- `server/index.ts` agent half: delete `RpcClient` spawn, `cliPath` resolution,
  `RPC_METHODS` whitelist, `READ_ONLY`/`HISTORY_RELOAD` tables, subagent frame relay.
  Replace with the session map + dispatch table from §1.3. Keep the WS upgrade,
  broadcast helpers, `pendingCodeInputs` map, `/download` canonicalization, `listFiles`.

### Delete
- All imports of `modes/rpc/rpc-client` and (in Phase 4) `modes/rpc/rpc-types`.

---

## 3. Phases

### Phase 1 — Frame-compatible bridge swap (client untouched)

Goal: same `ServerFrame`s on the wire, produced in-process. The UI cannot tell the
difference — that's the regression net.

1. Bootstrap once at startup:
   ```ts
   const cwd = process.env.OMP_WEB_CWD ?? process.cwd();
   const authStorage = await discoverAuthStorage();
   const modelRegistry = new ModelRegistry(authStorage);  // refresh happens in background via createAgentSession
   const settings = await Settings.init({ cwd, agentDir });
   ```
2. `createSession(cwd?)` factory: `createAgentSession({ authStorage, modelRegistry,
   settings, sessionManager: SessionManager.create(cwd), agentRegistry: new
   AgentRegistry(), hasUI: true, ... })`. Store `{ session, agentRegistry, eventBus,
   setToolUIContext }`. Call `setToolUIContext(uiCtx, true)` with the §1.7 context.
3. Wire broadcasts: `session.subscribe(e => { broadcast({type:"event", event:e}); if
   (e.type === "agent_end") broadcastState(true); })` — mirrors the existing
   `onSessionEvent` block including the stats-on-`agent_end` behavior.
4. `broadcastState` = §1.4 snapshot; `broadcastHistory` = `session.messages`.
5. Available commands: `buildAvailableSlashCommands(session)` on startup and after
   session changes (rpc-mode emits `available_commands_update` on command-metadata
   changes — replicate by re-pushing after `newSession`/`switchSession`/`branch` and
   after login).
6. Rewrite `RPC_METHODS` per §1.3 (fire-and-forget prompt!). Keep the
   `READ_ONLY`/`HISTORY_RELOAD` resync semantics — they're our protocol's, not RPC's.
7. Subagent relay: subscribe the three `eventBus` channels, broadcast the same
   `subagent_*` frames; roster from `agentRegistry.list()`; transcripts by reading the
   session file (copy `readRpcSubagentTranscript`'s fromByte/reset logic).
8. Login per §1.5.

Acceptance:
- `bun run check:types` and `bun test` green.
- Smoke (real browser, `bun run dev:server` + `dev:web`): prompt streams; steer chip;
  escape aborts; model/thinking pickers work; settings toggles persist across reload;
  `/export` downloads; session resume/branch pickers restore transcripts; subagent
  panel populates during a `task` run; OAuth login for one provider end-to-end; slash
  commands (`/compact`, `/export`) work.
- `grep -rn "rpc-client" server/ src/` → nothing.

### Phase 2 — Multiplexing

Goal: N concurrent sessions in one process; tabs attach to a session.

1. `protocol.ts`: add `sessionId: string` to `call`, `login_code`, `list_files`?? (no —
   list_files is cwd-global; only call/ui_response/state-scoped frames) and to
   server→client frames `event`, `state`, `history`, `available_commands`,
   `subagent_*`, `ui_request`, `call_result`.
2. Server: `Map<string, SessionEntry>`; `broadcastTo(sessionId, frame)`; per-session
   pending-UI maps. New client commands: `create_session { cwd? }`,
   `attach { sessionId }`, `detach`, `close_session`. On `attach`, push current
   state+history+commands immediately.
3. Session factory now per-session `AgentRegistry`/`EventBus`/`SessionManager`
   (already in Phase 1 factory) — subagent rosters stay cleanly namespaced per session
   with zero extra code.
4. `state.ts`: track current `sessionId`; filter session-scoped frames by it;
   `call()` injects it. Session picker doubles as the multiplexer UI.
5. Socket close → detach only; sessions outlive sockets. `close_session` →
   `beginDispose()` + `await dispose()` + remove from map.

Acceptance: two browser tabs on different sessions stream independently; a steer in
tab A never appears in tab B; closing a tab doesn't kill the agent; `close_session`
frees the session (registry empty, no listener leaks).

### Phase 3 — Hack removal + new capabilities

1. **ask tool**: server pushes `ui_request` frames from the real `ExtensionUIContext`
   (§1.7); add an `AskDialog` component consuming `askDialog` questions (multi-
   question, options with descriptions, `multi`, `recommended`, custom input,
   cancellation). Fallback: render `select`/`input` requests with the same modal.
   Verify: prompt the agent to use `ask`; answer; result lands in transcript.
2. **Settings**: `autoRetryEnabled` now in state (done in Phase 1 snapshot) — wire
   `SettingsPopover` to it and delete the local signal. Any further settings via the
   typed `settings` object server-side; expose read/write commands only as needed.
3. **Subagent controls** (new UI, optional but now trivial): steer/abort buttons in
   `SubagentPanel` rows → `call("subagentSteer"|"subagentAbort", [sessionId, agentId,
   text?])` → `agentRegistry.get(agentId)?.session?.steer/abort()`. Guard
   `status === "running"` and `session !== null`.

Acceptance: ask dialog round-trips (including cancel → tool error surfaces as
"Ask tool was cancelled by the user"); auto-retry toggle reflects real state after
reload; subagent abort kills one agent, others continue.

### Phase 4 — Cleanup

1. Rename `RpcSessionState` → `WebSessionState` in `protocol.ts`; remove every
   `modes/rpc/*` import repo-wide (`grep -rn "modes/rpc" src/ server/` → nothing).
2. Remove `setSubagentSubscription` from protocol + any dead client code.
3. Update `README.md` architecture section (browser ⇄ WS ⇄ Bun in-process SDK) and
   `docs/web-tui-parity-plan.md` status.

---

## 4. Gotchas (all verified)

- **Never `await session.prompt()`** in the WS handler — it resolves at turn end and
  would block the relay. Fire-and-forget with `.catch` → error frame (rpc-mode:1035).
- `hasUI` defaults to false; forgetting `hasUI: true` + `setToolUIContext(_, true)`
  silently removes the `ask` tool.
- `authStorage`/`modelRegistry` instance pairing is enforced; share ONE pair across
  all sessions.
- Private `AgentRegistry` per session or the second session fails to register "Main".
- `agent_end` has `isTerminal?: boolean` — only treat `isTerminal !== false` as done
  (already handled in `state.ts`? verify).
- `setModel` must retry after `awaitBackgroundRefresh()` on cold start (§1.3).
- Slash commands typed into chat need `executeAcpBuiltinSlashCommand` BEFORE
  `session.prompt` or builtin `/` commands regress (rpc-mode:988-1038 reference flow).
- Don't share loaded extension instances across sessions (`preloadedExtensionPaths`
  only).
- `ExtensionUIContext.theme` is a required readonly field — stub it or type-check
  fails.
- The `session` on an `AgentRef` is owned by the task executor: `steer`/`abort`/
  `subscribe` only, never `dispose`/`newSession`/`switchSession`.

## 5. If something's unclear

The RPC mode source `modes/rpc/rpc-mode.ts` is the exact specification of the adapter
being replaced — when in doubt about any call's semantics, read the corresponding
`case` there. The installed package ships full TS source under
`node_modules/@oh-my-pi/pi-coding-agent/src/`; harness docs live at `omp://sdk.md`,
`omp://rpc.md`, `omp://tools/ask.md`, `omp://tools/hub.md`.
