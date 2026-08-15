# omp

- Multiple repos
- Multiple worktrees
- Multiple sessions - start/stop/sleep, label?, group?
- Tool Cards - omp-specific
- Subagents - panel, controls, details, steer
- Session controls (omp)
- Collab

# Copilot
Plan
Meta-harness


# Cursor
Plan mode -> produces .md
checkpoints
queued messages with drag and drop reorder
Desktop has more IDE capabilities vs. Web - File tree, Diff Viewer, terminal, browser
Session GUI has nice flow to it
Repo director shows session history, not worktrees
Repo -> Worktrees -> Sessions is the correct abstraction

Linux local sandboxes with landlock?
mobile web control plane
Cloud Agents: unlimited parallel agents on isolated VMs producing merge-ready PRs with artifacts (screenshots/videos/logs) and remote-desktop takeover; kicked off from web, iOS, Slack, GitHub PRs, Linear

# Codex
Cloud tasks (parallel isolated sanboxes) - task logs, summary, diff review, one click PR
Projects View?
Goal mode
Auto-review agent that reviews cloud agent work
delegate from different surfaces: Github, Linear, Slack
Pets!

# CLaude Code
Artifacts viewer - versioning, sharing
Routines - scheduled cloud work
mobile app
checkpoints
Cloud sessions
/tasks to monitor background sessions
diff/file view
auto-fix github PRs, comment, push
session sharing
local <-> cloud
inline diff comments
PR handoff

# Google Jules
Publish Branch + open-PR dropdown from the UI; commit authorship modes
Suggested Tasks: Jules proactively finds TODOs/optimizations and can auto-solve the top-confidence one
Scheduled Tasks with edit/pause/resume; CI Fixer detects CI failures on its PRs and resubmits fixes
Planning Critic: a hidden second agent critiques every auto-approved plan (-9.5% task failure rate)
Side-by-side and stacked diff views; image rendering in diffs; environment snapshots

# Replit
Task board: agent work as kanban stages (queued / running / ready for review) with review, start, monitor, dismiss, 'Apply changes to main version'

# Devin
Interactive Planning: responds in seconds with relevant files and an editable preliminary plan you approve before autonomous work
Devin Search with Deep Mode: agentic codebase Q&A with cited code
Devin Wiki: repos auto-indexed into wikis with architecture diagrams and source links
Review Autofix: Devin plans, codes, reviews its own output, fixes issues before the PR is opened
Computer-use desktop testing: after a PR, Devin tests on its own Linux desktop and sends screen recordings

# opencode
Official web UI: `opencode web` serves the same agent experience in the browser with session list, server status, optional password auth, mDNS, CORS; `opencode attach <url>` attaches a TUI to the web server sharing the same sessions

# cline
Kanban web board for parallel agents: each card gets its own worktree + terminal, auto-commit, dependency-chain linking, live per-card tool calls, diff review with line comments
Parallel agents via Kanban with worktrees; scheduled agents on cron

# openhands
Multi-backend switching from one UI: local, Docker, VM, Modal, or OpenHands Cloud sandbox — flip backends without losing focus
metaharness via ACP
/goal: agent works until a judge LLM confirms the objective; live status banner shows round, judge score, missing work
Automations on schedules or webhooks integrating Slack, GitHub, Linear, Notion
Inline rich preview of Markdown artifacts
Sandboxed execution (Docker/VM/cloud) with mount-boundary jail

# qwen code
Agent Arena (multi-model head-to-head)

# amp
Rebuilt as hosted web-first product: start agents on web/terminal/phone, 'orbs' = event-driven remote subagents, durable URL-shareable threads, capability modes, voice input, multiplayer workspaces, Slack integration.

---

# Feature plan — solo engineer vs. team/collaboration

Split criterion: does the feature cross a human boundary? **Solo** = one engineer + their agents, no other human in the loop. **Team** = shared repos/PRs + CI, chat/webhook triggers, sharing, multiplayer, takeover. Solo features are phased for implementation; team features are listed with dependencies (they ride on solo foundations + existing collab).

## Solo engineer features — implementation plan

### Phase 1 — Agent loop hardening (protocol-additive, daemon-side)

Nothing needs new infra; every item is one dispatch row + one frame + one UI.

1. **Checkpoints** (Cursor, Claude Code) — `checkpoint_save`/`checkpoint_list`/`checkpoint_restore`. Snapshot = `.jsonl` offset + `WebSessionState` + git HEAD, stored in session dir; restore = replay-to-offset. No SDK change.
2. **Queue reorder** (Cursor) — queue already exists (`getQueuedMessages`/`popLastQueuedMessage`/`clearQueue`); add `reorderQueue` + drag-and-drop in the queue UI.
3. **Review agent / planning critic** (Jules −9.5%, Codex, Devin Review Autofix) — `reviewRun` spawns a second in-process agent session (SDK `createAgentSession` is already in-process; subagent-mirror infra exists) with a reviewer persona over the same context; `review` frames; approve gate.
4. **Editable plan artifact** (Devin, Cursor, Copilot) — plan mode exists (`setPlanModeState`); add `plan_artifact` frame + inline edit + approve gate before autonomous work.
5. **Goal-mode judge banner** (openhands `/goal`) — `goalCreate`/`goalModeState` already exist in `WebSessionState`; surface round/judge-score/missing-work banner in the goal modal.
6. **Capability modes** (amp) — `setComputerToolEnabled`/`setFastMode`/`setInspectImageMode` exist; package into named curated tool-profile presets.

### Phase 2 — Workspace & task UX (client-heavy)

7. **Agent Arena** (qwen) — N daemons, one task prompt, different model roles (`setModelRole`/`cycleModel` + `getAvailableModels` exist); side-by-side output + judge pass. Spawn labels + roster carry the orchestration.
8. **Task board / kanban** (Replit, cline) — extend `subagent-mirror.ts` with queued/running/review stages; per-card worktree via spawn template; auto-commit per card (git commit in cwd on completion); dependency-chain links; subscribe `subagent_event` per card (frames exist, currently unsubscribed).
9. **Diff viewer upgrade** (Jules, Cursor, Claude Code) — side-by-side + stacked on top of `src/diff.ts` (`buildDiffRows`); image rendering in diffs; diff between branches/checkpoints via a read-only git method; inline diff comments persisted as `.jsonl` annotations.
10. **File tree** (Cursor desktop) — `list_files` + `/download` jail exist; add tree UI with click-to-open/download.
11. **Session grouping + Projects view** (Codex, Cursor) — group roster by project/label; Repo → Worktrees → Sessions sidebar tree (discovery already yields `isWorktree`/`worktreeOf`/`branch`).
12. **Interactive terminal pane** (Cursor, cline) — PTY attach to daemon cwd; `terminal_chunk` frames (precedent: `bash_chunk`) + `terminal_input` command.

### Phase 3 — Automation & scale (fleet-side; zero agent state preserved)

13. **Scheduled/routine tasks** (Claude Code Routines, Jules, cline cron) — `scheduled` registry in fleet `state.json` (metadata only); cron trigger → spawn daemon with prompt; edit/pause/resume. (Webhook triggers are team — T1.)
14. **Suggested tasks** (Jules) — background discovery pass mining TODOs/optimizations; one-click spawn prompt.
15. **Environment snapshots** (Jules) — tar cwd + session state at checkpoint time (ties to #1).
16. **Cloud parallel tasks** (Codex, Claude Code) — provision VM → omp-session → existing `remote` fleet entries; task logs/summary/artifacts via `/download`; diff review is solo, the one-click PR is team (T4).

### Phase 4 — Execution, knowledge, mobility (independent; any order after P1–P3)

17. **Landlock local sandbox** (Cursor) — daemon bash under landlock rules (cwd + tmp + session-dir write, no network); kernel 6.x supports it; bwrap fallback.
18. **Multi-backend sandboxes** (openhands) — Docker/VM execution backends behind the same wire; mount-boundary jail; backend switch in UI.
19. **Cited codebase Q&A** (Devin Search) — index worktrees; cited answers via `runEphemeralTurn` (the `/btw` side-channel seam, `ephemeral_delta` frames exist).
20. **Auto-indexed wiki** (Devin) — static architecture docs generated from indexed repos.
21. **Artifacts viewer/versioning** (Claude Code) — versioned artifact store (screenshots/videos/logs) over `/download`; sharing half is team (T7).
22. **Mobile control plane + voice** (Cursor, Claude Code, amp) — PWA pass over the existing web UI; Web Speech input.
23. **mDNS + TUI attach** (opencode) — `omp attach <url>`; bonjour/avahi discovery; the collab CLI grows into it.
24. **Meta-harness via ACP** (openhands, Copilot) — ACP server so other harnesses can drive omp.

## Team/collaboration features — full list

Dependency order, not phases. Foundation: existing collab rooms (`collab_start`/`collab_stop`, `viewLink`) + solo Phase 3's fleet automation plumbing.

- **T1. Webhook/chat delegation ingress** (Cursor, Codex, Claude Code, openhands, amp) — Slack/Linear/GitHub-PR events → spawn session with prompt. Shared ingress with solo #13; nearly everything below rides on it.
- **T2. Event-driven orbs** (amp) — remote subagents triggered by webhook/chat events; T1 + solo #16 cloud infra.
- **T3. CI Fixer** (Jules) — on CI failure for tracked PRs → spawn fix session → push + comment; T1 + solo #3 review gate.
- **T4. PR lifecycle** (Claude Code, Jules) — publish branch + open-PR dropdown; PR handoff; commit authorship modes; auto-fix comment/push. Requires GitHub token storage in fleet state.
- **T5. Durable shareable threads** (amp, Claude Code) — URL-shareable session views; collab `viewLink` seam; read-only shares.
- **T6. Multiplayer workspaces** (amp) — extend collab rooms to multi-session workspace sharing.
- **T7. Artifact sharing** (Claude Code) — share links for versioned run artifacts (solo #21).
- **T8. Remote-desktop takeover** (Cursor) — human/agent takeover of a cloud-agent desktop (noVNC); largest; rides on solo #16.
- **T9. Computer-use desktop testing** (Devin) — desktop env + screen recording for PR validation; rides on solo #17/#18 + T4.

---

# Beyond the omp TUI

Gaps (from the plan):

**Solo** — checkpoints · queue reorder · review agent · editable plan artifact · goal judge banner · capability modes · Agent Arena · task board/kanban · diff viewer upgrade · file tree · session grouping/Projects view · interactive terminal pane · scheduled tasks · suggested tasks · environment snapshots · cloud parallel tasks · landlock sandbox · multi-backend sandboxes · cited codebase Q&A · auto-indexed wiki · artifacts viewer · mobile control + voice · mDNS/TUI attach · ACP meta-harness

**Team** — webhook/chat delegation · event-driven orbs · CI Fixer · PR lifecycle · shareable threads · multiplayer workspaces · artifact sharing · remote-desktop takeover · computer-use testing

---

# In omp-fleet, not in the omp TUI

- **Roster / multi-daemon supervision** — spawn, stop, remove, restart N omp-session daemons; monotonic status ladder (spawning → connecting → session → resolving → ready; asleep; error); idle auto-exit → `asleep` → respawn with `--resume`
- **Project & worktree discovery** — multi-root scan parsing `git worktree list --porcelain` (main vs linked worktree, branch), git branch/dirty counts; powers the spawn picker
- **Labels, selectors & prompt fan-out** — `label:k=v`, `project:name`, `dN`, `all`, name glob; `/ctl/prompt` fans one prompt to N daemons with per-daemon correlation (`--wait`)
- **Control-plane CLI** — `omp-fleet serve|sessions|projects|spawn|add|provision|stop|remove|prompt` over loopback `:4722 /ctl/*`
- **Provision hook** — `config.spawnHook` (`sh -c`, `OMP_HOOK_NAME`/`OMP_HOOK_LABELS`) enrolls external daemons as remote entries; per-daemon bearer tokens minted per spawn/restart, never serialized
- **Remote entries** — `omp-fleet add <name> <url> --token`, dial-in only
- **Historical stats API** — `/ctl/stats/*` (sessions, tools, per-session stats, transcripts, sync, health) over read-only stats.db; drives the roster-mode transcripts browser
- **Roster-mode web UI** — daemon sidebar, spawn picker, per-daemon logs/stop/restart from the browser, fleet-stamped `sessionId` guards, aggregated `daemons` frame
- **Edge aggregation** — browser `/events` downlink multiplexing N daemons, per-browser proxy pipes, `roster`/`daemon_status` frames

---

# Plan summary — titles only

## Solo — Phase 1: Agent loop hardening
- Checkpoints (Cursor, Claude Code)
- Queue reorder (Cursor)
- Review agent / planning critic (Jules, Codex, Devin)
- Editable plan artifact (Devin, Cursor, Copilot)
- Goal-mode judge banner (openhands)
- Capability modes (amp)

## Solo — Phase 2: Workspace & task UX
- Agent Arena (qwen)
- Task board / kanban (Replit, cline)
- Diff viewer upgrade (Jules, Cursor, Claude Code)
- File tree (Cursor)
- Session grouping + Projects view (Codex, Cursor)
- Interactive terminal pane (Cursor, cline)

## Solo — Phase 3: Automation & scale
- Scheduled/routine tasks (Claude Code, Jules, cline)
- Suggested tasks (Jules)
- Environment snapshots (Jules)
- Cloud parallel tasks (Codex, Claude Code)

## Solo — Phase 4: Execution, knowledge, mobility
- Landlock local sandbox (Cursor)
- Multi-backend sandboxes (openhands)
- Cited codebase Q&A (Devin)
- Auto-indexed wiki (Devin)
- Artifacts viewer/versioning (Claude Code)
- Mobile control plane + voice (Cursor, Claude Code, amp)
- mDNS + TUI attach (opencode)
- Meta-harness via ACP (openhands, Copilot)

## Team/collaboration
- T1 Webhook/chat delegation ingress (Cursor, Codex, Claude Code, openhands, amp)
- T2 Event-driven orbs (amp)
- T3 CI Fixer (Jules)
- T4 PR lifecycle (Claude Code, Jules)
- T5 Durable shareable threads (amp, Claude Code)
- T6 Multiplayer workspaces (amp)
- T7 Artifact sharing (Claude Code)
- T8 Remote-desktop takeover (Cursor)
- T9 Computer-use desktop testing (Devin)
