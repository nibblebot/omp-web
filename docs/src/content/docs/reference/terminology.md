---
title: Terminology
description: Concise definitions of the recurring omp-web terms, from projects and worktrees to roster statuses and analysis vocabulary.
---

This page is the canonical glossary for omp-web. Entries are deliberately short; the deeper explanation lives in [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) and in the task guides each entry links to.

Throughout the documentation, the per-directory `omp-session` process is called a **session daemon**. Quoted CLI output, UI labels, and protocol fields may shorten that to `daemon`; those spellings stay unchanged when quoted.

## Terms that are easy to mix up

| Terms | Distinction |
| --- | --- |
| Project and worktree | A project is the fleet's registration of a repository. A worktree is one directory that repository owns. |
| Worktree and clone workspace | A worktree is a linked checkout inside your own repository on this machine. A clone workspace is an independent clone on a provider-run volume, with its own object store and its own lifecycle. |
| Session daemon and session | The session daemon is the disposable process. The session is the conversation it hosts, recorded in a durable transcript. |
| Transcript and stored session | A transcript is the JSONL file the agent writes on the machine running the daemon. A stored session is the fleet's durable mirror of that lineage in the log store, which survives the workspace. |
| Fleet and roster | The fleet is the process that supervises session daemons. The roster is the list of those session daemons in the sidebar. |
| The fleet and a session daemon | The fleet serves the web UI and supervises session daemons. A session daemon runs one live session for one bound directory and serves the wire API only. |
| Ready and attached | Ready is a session daemon status. Attached describes this browser tab, which holds one session daemon at a time. |
| Wake and attach | Waking starts an asleep session daemon and then attaches. Attaching alone binds a browser tab to a session daemon that is already ready. |
| Branch, fork, and handoff | Branch starts a new transcript from an earlier message. Fork copies the current session in full. Handoff summarizes into a new session. |
| Streaming and blocked | Streaming means a turn is producing output. Blocked means that turn is waiting for an answer in a dialog. |
| Daemon bearer token and browser access token | The bearer token authenticates one session daemon to the fleet. The browser access token authenticates a browser to the fleet's own surface. |

## A to C

**Advisor**. A reviewer agent that watches a session's turns and can inject advice notes into the conversation. It is configured in the omp agent (the `advisor.enabled` setting, plus optional `WATCHDOG.yml` advisor entries), and omp-web can assign its model through the built-in model role named Advisor. Advisor transcripts appear with the session's subagent transcripts in Analysis.

**Analysis**. The top-level view that browses historical work instead of the live chat: a session list, then Overview (analytics), Transcript, and Subagents tabs for the selected session, plus the Sync stats DB action. Analysis reads through the fleet's statistics service, which every deployment has. See [Analysis and usage](/analysis/) for the full view set.

**Attached**. Describes a browser tab bound to one session daemon, receiving its live frames and sending prompts to it. Clicking a ready roster row attaches; waking an asleep row starts the session daemon first and then attaches. Each tab holds one attached session daemon at a time, so attaching to a different row moves the chat column to that session.

**Blocked**. A roster activity state for a ready session daemon whose turn is waiting for an answer in a dialog, such as an ask or a login prompt. A blocked row shows a red dot even while a different session is attached.

**Branch**. An action that starts a new transcript from an earlier point in the conversation. The messages up to the chosen user message are kept, later messages stay only in the previous session file, and the chosen message is offered back in the composer for editing. The new session file records the old one as its parent. See [Slash commands](/reference/slash-commands/).

**Browser access token**. The operator credential that turns on browser sign-in for the fleet's own surface. `--browser-access-token` or `OMP_FLEET_BROWSER_TOKEN` supplies it in plaintext and it is stored only as its SHA-256 hex digest, so the `browserAccessToken` config key must already be that digest. A non-loopback fleet bind with no token configured refuses to start. See [Browser access and sign-in](/operations/browser-auth/).

**Callback pair**. The two outbound HTTP streams (a downlink from the fleet and an uplink to it) that a clone workspace daemon uses in place of an inbound service. The daemon dials the fleet, authenticates with workspace enrollment credentials plus workspace, generation, and connection headers, and the pair is HTTPS-only except for the explicit loopback HTTP development exception. See [Clone workspaces](/fleet/clone-workspaces/).

**Clone workspace**. An independent checkout of a registered project, created with `omp-web add-clone` or from the add-workspace dialog, that a provider runs for the fleet on its own volume: `.checkout/` holds the clone with its own object store and `.home/agent/` holds the agent directory and its sessions. It is not a Git worktree in your repository, it has no inbound listener, and it is removed by the guarded verify-at-deletion gate. Provider selection, declared resources, and secret references come from a provider profile. See [Clone workspaces](/fleet/clone-workspaces/).

**Collaboration room**. A multi-agent surface for one session, operated through the omp CLI or TUI. omp-web intentionally has no collaboration surface in the browser.

**Compaction**. Reducing the active context by summarizing older messages so a long session keeps fitting the model's context window. Compaction runs manually through `/compact` or automatically when the window fills, if auto-compaction is enabled. The summary is recorded in the session file, and recent messages are kept verbatim.

**Context**. Everything sent to the model for the next turn: the system prompt, tool definitions, and the messages still in the active window. The status bar's context meter shows used tokens against the model's context window. Compaction reduces context; it does not change the transcript on disk.

## D to F

**Enrollment credentials**. The workspace-scoped credential a clone workspace daemon presents when it dials the fleet's callback pair, generated per workspace at 256 bits and stored in the fleet state only as a hash. They are bound to the workspace id and an authorized generation, so a credential is valid for one workspace and can be revoked by bumping the generation. They never ride a URL path or a query string. See [Clone workspaces](/fleet/clone-workspaces/).

**Fan-out**. Sending one prompt to many session daemons at once from the command line, selected with a selector, for example `omp-web prompt 'project:app' "Summarize the open work."`. Each session daemon runs the prompt as its own turn. Fan-out is a CLI feature; the browser sends prompts to the attached session only. See [Fan-out prompting](/cli/fanout/).

**Fleet**. The registry, supervisor, and proxy for session daemons, run by bare `omp-web` (the same as `omp-web serve`). It tracks projects, clones, and session daemons, spawns and stops local child processes, dials remote session daemons, runs clone workspaces through their provider, and serves the web UI. The browser only ever talks to the fleet, which proxies it through to the attached session daemon. Agent state stays in the session daemons and their transcripts: the fleet keeps a durable mirror of the session lineage it is streamed in the log store, but it holds no model state and no live session.

**Follow-up**. A message queued to run after the current turn finishes, instead of interrupting it. Contrast with steering. Queue chips in the composer show what is waiting.

**Fork**. An action that copies the whole live session, including its messages and artifacts, into a new session file with the same state. Use it to try a different direction without losing the original transcript.

## G to L

**Git state**. The per-row facts the fleet polls for local session daemons: the current branch and dirty-file counts, plus optional line counts. Remote session daemons are never probed locally, so those columns stay empty for them.

**Goal mode**. A session mode in which the agent keeps working toward one objective across turns, with statuses such as active, paused, and complete, and an optional token budget. Goals are created, paused, resumed, and dropped from the goal panel or the corresponding slash command.

**Handoff**. An action that generates a handoff document with a one-shot model call and then starts a new session seeded with that document. Use it when a conversation is too long to continue and a fresh summary should carry the work forward.

**Idle auto-exit**. The session daemon's self-stop after a quiet period, 30 minutes by default (`--idle-timeout`; `0` disables it). It triggers only when nothing is attached, no turn or queued message is running, no bash or eval call is in flight, no dialog is open, and no collaboration room is live. The exit is normal, and the roster shows the row as asleep. While a browser is connected, the fleet keeps a stream open to every ready session daemon, which counts as an attached client and postpones idle exit until the last browser disconnects.

**Label**. A `k=v` tag attached to a session daemon when it is spawned or registered, for example `role=review`. Labels show on roster rows and drive CLI selectors and fan-out.

**Lifecycle stage**. The progress label a clone workspace row shows while its provider brings the workspace up: preparation, runtime, callback, then ready, with failed as the terminal failure state. A parked workspace has no stage, and a stage never sticks at callback over a dead process. See [Understand roster status](/fleet/roster-status/).

**Log store**. The fleet's durable copy of the session lineage that managed session daemons stream, kept under `<state dir>/logs/<workspaceId>/<sessionId>/<relpath>` with a per-session `index.json`. It outlives the compute that produced it: retention is explicit, verified history is never garbage-collected, and a workspace deleted without passing its verification gate leaves an orphaned subtree. See [Stored sessions](/analysis/stored-sessions/) and [Files and directories](/reference/files/).

## M to P

**Main checkout**. The repository's primary working directory, the one that contains the Git directory, as opposed to a linked worktree. Registering a project auto-registers its main checkout as the project's default workspace with its own roster row.

**Managed worktree**. A linked worktree created through omp-web under the workspace directory, so the fleet owns it and can delete it from the UI. Deletion requires a clean working tree, has no force option, and deletes the branch only when asked and only with a safe delete. A linked worktree registered from another location is adopted, not managed, and the fleet never deletes it.

**Model role**. A named model slot, for example Default, Fast, Thinking, or Subtask, that resolves to a provider model. The model-roles picker assigns models to roles, optionally baking in a thinking level, and a change to the session's active role applies immediately. Role storage scope follows the session's role-storage setting (global config against project configuration).

**Orphaned store subtree**. A workspace's directory under the log store that outlived the workspace because the deletion did not pass its verification gate. The registry records a marker with the source and pinned revision, `GET /ctl/logs/orphans` lists it, and only an explicit purge removes it. See [Stored sessions](/analysis/stored-sessions/).

**Plan mode**. A session mode in which the agent researches and writes a plan before making changes, then presents it for approval. Approving the plan starts execution.

**Project**. A Git repository registered with the fleet, keyed by the realpath of its main checkout and given a stable id such as `p1`. Registration stores metadata only; it never copies, moves, or deletes repository files. Registering the same repository through another path returns the existing project, and removing a project is refused while session daemons still reference it.

**Prompt composer**. The input area at the bottom of the chat column where prompts, slash commands, and image attachments are entered. Autocomplete, prompt history, and queue chips all live there.

**Provider profile**. A named entry in the config file's `providerProfiles` map that declares how clone workspaces of one kind are run: the provider (`bwrap` or `kubernetes`), the provider executable, the tools to expose, optional resource and storage limits, and secret references by name only. The fleet validates each profile at load and serves the secret-free view through `omp-web profiles`. See [Provider profiles](/configuration/provider-profiles/).

## Q to S

**Queue**. Messages accepted while a turn is running: steers are injected into that turn, and follow-ups run after it. The composer shows the pending count, and queued user messages can be popped back into the composer one at a time.

**Ready**. A session daemon status, and the point at which the session daemon accepts prompts. The session daemon reports ready after its session exists and the provider, model, and credentials have resolved; before that, prompt-family calls fail with a not-ready error and the composer shows a starting hint. Roster rows also use the ladder below.

**Remote session daemon**. A session daemon the fleet reaches over the network instead of supervising as a local child process. It is registered with its URL and token, and the fleet dials out to it; the local machine never probes its Git state, and waking redials instead of starting a process. Connections are dial-in only, which fits SSH tunnels, tailnets, and sandboxes; a clone workspace is the one row kind that instead dials the fleet's callback pair. See [Local and remote sessions](/concepts/local-and-remote/).

**Resume**. Continuing a session from its transcript. Waking an asleep row resumes its last session file, or starts a fresh session when the row has none; the per-row session picker resumes one of the worktree's recent sessions. A transcript can be open in only one session daemon at a time, so a second session daemon aimed at a file that is already in use refuses to start. See [Troubleshooting](/operations/troubleshooting/) for a blocked start.

**Roster**. The fleet's list of session daemons, one row per session daemon, grouped by project. The sidebar shows the roster. Each row carries the bound directory, status, session title, and Git state, and clicking it attaches or wakes the session daemon. See [The fleet sidebar](/fleet/sidebar/).

**Roster status**. The lifecycle state shown for a session daemon row. The ladder is:

| Status | Meaning |
| --- | --- |
| spawning | The fleet is starting a local child process. |
| connecting | The fleet is dialing the session daemon. |
| session | The handshake passed and the session daemon created or restored its session. |
| resolving | The session daemon is resolving provider credentials and the model. |
| ready | The session daemon accepts prompts and can be attached. |
| asleep | No process or connection is live; clicking wakes the row. |
| reconnecting | A dial or a working connection failed and is being retried with backoff. |
| error | A terminal failure for this attempt; details are on the row, and a restart retries. |

After a fleet restart, locally spawned rows read as asleep because their child processes are gone, while remote rows are dialed again.

**Sandbox runtime**. The environment a clone workspace's session daemon runs in, produced by the profile's provider: a fleet-local `bwrap` sandbox built from an allowlist of mounts, or a Kubernetes pod on a persistent volume. Both share the host kernel, so neither is a confidentiality boundary. Operator prerequisites for a profile are reported by `omp-web preflight --profile <id>` and never provisioned for you. See [Sandboxed session runtime](/advanced/sandbox-runtimes/).

**Selector**. A CLI expression that names session daemons: `all`, an exact session daemon id such as `d3`, `label:k=v` (alias `tag:k=v`), `project:name`, or a name glob using `*` and `?`. An exact session daemon id wins over a glob interpretation. For example, `omp-web stop d3` stops one session daemon and `omp-web stop 'web-*'` stops every session daemon whose name matches the glob. See [CLI commands and flags](/reference/cli/).

**Session**. One agent conversation: the live message list, queue, model selection, and tool state hosted by a session daemon, persisted as a JSONL transcript and resumable later. A session daemon hosts one live session at a time, and actions such as starting a new session or resuming another replace that one session rather than adding a second.

**Session daemon**. One `omp-session` process bound to one project or worktree directory at start and for its whole life. It runs the agent in process, hosts one live session, and serves the wire API; it serves no web UI, because the fleet is the only server of the UI. Session daemons are disposable: stopping one, or letting it exit after its idle timeout, loses nothing durable. One roster row corresponds to one session daemon, and parallel work means several of them. See [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

**Session file**. The JSONL file that holds one session transcript, stored under the agent session directory rather than inside the worktree. The file is the durable record, so worktree deletion never touches it.

**Session title**. The short generated name for a session, shown on roster rows and in the session picker. It is derived from the conversation and can be set manually.

**Spawn**. Creating a session daemon on a directory, either from a project or worktree row in the UI or through `omp-web spawn <path>` on the command line. The fleet fills a spawn template with the directory, name, labels, token, and resume file, then supervises the resulting process. The session daemon's default name is the directory basename.

**Spawn hook**. An optional command in the fleet configuration that `omp-web provision <name>` runs to obtain a remote session daemon's endpoint and token. The hook's last non-empty output line must be JSON with `url` and `token`, and may carry `name` and `cwd`; see [Environment variables and precedence](/reference/environment/) for the contract.

**Spawn template**. A named command in the fleet configuration used to start local session daemons, selected per spawn. The default `local` template runs `omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}`, with `{cwd}`, `{token}`, `{name}`, `{labels}`, and `{resume}` filled at spawn time. See [Configuration schema](/reference/configuration/).

**Stats database**. The SQLite database that `omp stats` fills from session transcripts, read by Analysis for analytics and tool tables. The Sync stats DB action in Analysis runs the omp summary pass on the server so unsynced transcripts pick up real numbers. See [Files and directories](/reference/files/) for its location.

**Steering**. A message sent while a turn is running and injected into that turn, so the agent sees it without waiting for the turn to end. Contrast with follow-up.

**Stored session**. One session's lineage as the fleet log store holds it, enumerated from disk under `logs/<workspaceId>/<sessionId>/` and readable without waking any compute. While the workspace is still known to the registry, a stored session also carries its secret-free provenance: the project, the workspace kind, the profile id, the branch, and the pinned revision. Once the workspace is gone the row reads as orphaned, and the registry's orphan marker is what preserves the source and pinned revision for a later resume onto a fresh clone. See [Stored sessions](/analysis/stored-sessions/).

**Streaming**. The state of a session daemon whose attached session is mid-turn and producing output. Roster rows show a spinning dot while streaming, including rows that are not currently attached.

**Subagent**. A child agent run that the main agent delegates a task to. Subagents have their own lifecycle, progress, and transcript files under the owning session's directory; they can be steered or aborted individually, and they leave the main session untouched. The chat shows active subagents, and Analysis lists their transcripts under the Subagents tab.

## T to Z

**Thinking level**. How much reasoning effort a model request uses, selected per model role or per session. Values depend on the model: off, inherit the model's default, a concrete effort level, or auto, which resolves a level per turn.

**Tool call**. One tool invocation by the agent, rendered in the chat as a card with its input, output, and any diff. Tool calls run inside the session daemon, so they stop when its process stops, while the transcript keeps the recorded result.

**Transcript**. The durable record of a session: a JSONL file under the agent session directory, one file per session, with subagent and advisor transcripts nested beneath it. Transcripts outlive session daemons, browser tabs, and managed worktrees, and Analysis browses them across all projects. See [Session persistence](/concepts/session-persistence/) for how transcripts survive processes.

**Turn**. One prompt-and-response cycle: the user prompt, the agent's reasoning and tool calls, and the final answer. Streaming and blocked both describe a turn in progress.

**Usage**. Token counts and cost per session and per model, shown in the context meter, the usage modal, and Analysis. Provider usage limits, when a provider exposes them, appear in the same places and are refreshed on demand, not on a timer.

**Wake**. Starting an asleep session daemon and attaching to it. Local rows respawn on their bound directory and resume their last session when they have one; remote rows are dialed again; a clone workspace re-provisions its compute and resumes its last session, materializing that transcript from the log store first when the volume is cold or the file is missing. See [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

**Work**. One of the two top-level views, alongside Analysis, and the live chat one: the roster sidebar plus the attached session's stream and composer. It is the default top-level view.

**Workspace directory**. The root under which managed worktrees are created, `~/.omp-web/workspaces` by default. It resolves with `--workspace-dir` winning over the `OMP_FLEET_WORKSPACE_DIR` environment variable, then the `workspaceDir` configuration key, then the default, and the directory is created lazily on the first managed worktree.

**Workspace volume**. The per-workspace volume a clone workspace runs on, rooted at `<workspaceDir>/<daemonId>`: `.checkout/` holds the working clone with its own object store and `.home/agent/` holds the sandbox's agent directory, including the sessions written there. The volume is what makes a stopped clone resumable and what the deletion gate verifies before anything is removed. See [Clone workspaces](/fleet/clone-workspaces/) and [Files and directories](/reference/files/).

**Worktree**. A directory a session daemon can be bound to: a project's main checkout or a linked Git worktree of that repository. Working on two branches at once means two worktrees, each with its own session daemon, because a session daemon never changes directory.
