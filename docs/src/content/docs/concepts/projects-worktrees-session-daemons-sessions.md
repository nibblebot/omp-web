---
title: Projects, worktrees, session daemons, and sessions
description: "The four-level omp-web model: a registered project, its main checkout and linked worktrees, the session daemon bound to each directory, and the durable session transcripts those processes serve."
---

omp-web organizes work in four levels. A **project** owns worktrees. A worktree is served by exactly one **session daemon**. A session daemon hosts one **session** at a time, and that session lives on disk as a durable transcript.

One rule explains most of the behavior you will see: a session daemon is bound to one directory for its entire life, and it hosts one live session at a time. Concurrency in omp-web comes from running several session daemons, not from several live sessions inside one process. To work on two branches at once, create a worktree for each and let each worktree run its own session daemon.

## The four levels

| Level | What it is | What to know |
| --- | --- | --- |
| **Project** | A Git repository registered in the fleet. | Identified by the realpath of its main checkout, so registering the same repository through different paths returns the same project. Registration stores metadata only: it never copies, moves, or deletes repository files. Each project gets a stable id such as `p1`, and removing a project is refused while session daemons still reference it. |
| **Worktree** | The project's main checkout or a linked Git worktree of it. | The main checkout is the project's default workspace and gets a roster row of its own. Linked worktrees let one repository host several branches at once. A linked worktree created under the fleet workspace directory (default `~/.omp-web/workspaces`) is fleet managed and can be deleted from the UI. A linked worktree elsewhere can be registered, but the fleet does not own it and will not delete it. |
| **Session daemon** | One `omp-session` process bound to one project or worktree directory. | Runs the agent SDK in-process and hosts one live session at a time. Disposable: stopping it, or letting it exit after its idle timeout, loses nothing durable. One roster row corresponds to one session daemon. |
| **Session** | One agent conversation. | Stored as a JSONL transcript on disk and resumable later. New-session and resume actions replace the live session one after another rather than running side by side. A transcript can outlive its session daemon and its worktree. |

## The hierarchy

```text
project: ~/code/app                        registered by realpath
├─ main checkout: ~/code/app               project default workspace
│    └─ session daemon: omp-session process
│         └─ session: JSONL transcript on disk
├─ linked worktree (managed): ~/.omp-web/workspaces/app/feature-x
│    └─ session daemon
│         └─ session: JSONL transcript on disk
└─ linked worktree (adopted): ~/code/app-hotfix
     └─ session daemon
          └─ session: JSONL transcript on disk
```

Read the tree from the bottom up: sessions are the durable record, session daemons are the disposable processes that produce them, worktrees are the directories that scope them, and the project is the registration that ties the worktrees together. A session daemon does not have to run on the same machine as the fleet; a remote session daemon follows the same model.

## One directory, fixed at start

A session daemon takes one working directory when it starts and keeps it for its entire life.

- A session daemon started by the fleet takes its directory from the project or worktree row, and the fleet verifies the directory the process reports against the row that started it.
- A session daemon you start yourself serves the directory you started it from, the current directory unless `--cwd` names another. See [Run a session daemon](/cli/session-daemon/).
- There is no operation that repoints a running session daemon at another checkout.

Because the directory is fixed:

- Working on branches concurrently requires a distinct worktree and session daemon for each branch.
- A row keeps targeting the same checkout even when the session daemon stops or sleeps.
- Waking an asleep row always resumes in that same directory, so a row means the same workspace over time.

## Concurrency comes from multiple session daemons

- **One session daemon, one live session.** The session daemon never multiplexes several conversations. `newSession`, `switchSession`, `branch`, `fork`, `handoff`, `compact`, `retry`, and `freshSession` run sequentially and change what the single live session is; they do not add a second one.
- **Parallel work means several session daemons.** Each is an independent process with its own live session, queue, model selection, and tool state, so work in one worktree cannot stall or overwrite work in another.
- **Several browser tabs can share one session.** Tabs attached to the same session daemon see the same conversation, and replacing the live session refreshes every attached view, not only the one that asked.
- **A transcript belongs to one session daemon at a time.** Starting a second session daemon that resumes a transcript already in use is refused instead of risking two writers on one history.
- **Fleet operations follow the same rule.** Prompts sent to one session daemon are serialized; prompts to different session daemons run in parallel.

## Disposable processes, durable transcripts

The process is disposable; the transcript is not.

- Everything durable lives on disk: the session transcript, your Git state, and the worktree files. Stopping a session daemon, closing the browser, or letting the session daemon exit after its idle timeout removes the process, not the history.
- Waking an asleep row respawns a local session daemon and resumes its last session file, or starts a fresh session when the row has none. A remote session daemon is dialed again instead of respawned.
- An idle session daemon exits cleanly on its own once nothing is attached and the agent is not working. That exit is normal, and the roster shows the row as asleep until you wake it.
- Session file locking protects resume: the lock is held for the session daemon's lifetime, and a second process aimed at the same transcript refuses to start. If a start is blocked by a lock, see [Troubleshooting](/operations/troubleshooting/).

## The fleet holds no agent state

omp-fleet is a registry, a supervisor, and a proxy. It tracks which projects and session daemons exist, starts and stops local child processes, dials remote session daemons, and forwards browser traffic to the session daemon you attach. It does not run the agent SDK, and it holds zero agent state.

- Models, provider credentials, prompts, tool calls, queued messages, subagent activity, and the transcript all live in the session daemon and its session file.
- The registry mirrors only the facts needed to operate a row: the bound directory, the last session file, and readiness. Restarting the fleet loses no agent state because the fleet never held any.
- After a fleet restart, locally spawned rows are asleep because their child processes are gone with the fleet; waking a row respawns it with its transcript. Remote rows are dialed again.
- Removing a project removes only the registration. Repository files are untouched, deleting a managed worktree is a separate guarded action, and removal is refused while session daemons still reference the project.

## Related pages

- [What is omp-web?](/getting-started/overview/)
- [Start your first session](/getting-started/start-first-session/)
- [The fleet sidebar](/fleet/sidebar/)
- [Prompting the agent](/sessions/prompting/)
- [Troubleshooting](/operations/troubleshooting/)
