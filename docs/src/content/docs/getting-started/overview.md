---
title: What is omp-web?
description: One browser for running and supervising multiple Oh My Pi agent sessions across your repositories and worktrees.
---

omp-web is a browser UI for running multiple Oh My Pi agent sessions across all your repositories and worktrees: one installed command, one browser UI, N agent sessions. It is built for a solo operator who supervises parallel agents, so you can watch, steer, and fan out across many concurrent sessions without losing work when a process dies.

## Fleet mode is the normal path

Running `omp-web` starts fleet mode. The fleet, a registry and supervisor, spawns and supervises local session daemons, keeps track of the projects you register, and serves the web UI. Your browser talks to the fleet, and the fleet proxies you through to whichever session daemon you select.

The fleet sidebar lists each registered project with its main checkout and any linked worktrees as rows. Starting a session daemon from a row launches a separate process bound to that one directory, and selecting the row attaches your browser to its session. Concurrency comes from running multiple session daemons in parallel, normally one per worktree, not from several sessions inside one process.

## Single-session mode

If one session is all you need, `omp-web session` runs a single session daemon and serves the browser UI directly from it. The conversation experience is the same, but there is no fleet sidebar and no Analysis views. This suits focused work on one checkout and deployments that do not need a fleet.

## Session daemons are disposable, transcripts are durable

A session daemon is a process, not storage. It hosts one live agent session at a time, and it can go away at any moment: it goes to sleep after a period of inactivity, you can stop it from the UI or the CLI, and a crash triggers a bounded automatic restart. None of that loses work. Each conversation is durably recorded in its session transcript on disk, and waking or respawning a session daemon resumes from that transcript. The fleet itself keeps roster metadata such as registered projects, worktrees, and the last session file per entry, never agent state.

In practice: treat session daemons as replaceable workers, and transcripts as the thing worth keeping.

## Who it is for

omp-web targets a single operator running many agents, typically across local projects, Git worktrees, and remote sandboxes. Multi-user access is not a current feature. Some areas also have deliberate limits:

- Analysis, the historical transcript and usage views, is available only in fleet mode.
- Collaboration rooms are hosted and joined through the CLI or TUI; there is no browser collaboration surface.
- Remote access is user-managed, for example over SSH forwarding or a private network.

## Early stage

> **Early-stage software.** omp-web is under active development and has sharp edges. Expect breaking changes between releases: the wire protocol, configuration and state formats, and the UI are not yet stable. Session transcripts are durable JSONL files, but the surrounding tooling (fleet state, configuration, and managed worktrees) is still evolving, so do not treat it as production data storage yet. Report issues and rough spots as you find them.

## Next steps

- [Installation](/getting-started/installation/) covers the Bun runtime, the `omp` CLI, and provider requirements.
- [First run](/getting-started/first-run/) walks through starting the fleet for the first time.
- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) explains the model behind everything above.
