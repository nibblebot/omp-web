---
title: What is omp-web?
description: One browser for running and supervising multiple Oh My Pi agent sessions across your repositories and worktrees.
---

omp-web is a browser UI for running multiple Oh My Pi agent sessions across all your repositories and worktrees: one installed command, one browser UI, N agent sessions. It is built for a solo operator who supervises parallel agents, so you can watch, steer, and fan out across many concurrent sessions without losing work when a process dies.

## The fleet at the center

Running `omp-web` starts the fleet: a registry and supervisor that spawns and supervises local session daemons, keeps track of the projects you register, and serves the web UI. Your browser talks to the fleet, and the fleet proxies you through to whichever session daemon you select.

The fleet sidebar lists each registered project with its main checkout, any linked worktrees, and any clone workspaces as rows. Starting a session daemon from a row launches a separate process bound to that one directory, and selecting the row attaches your browser to its session. Concurrency comes from running multiple session daemons in parallel, normally one per worktree, not from several sessions inside one process.

A clone workspace is an independent checkout the fleet creates through a declared provider profile (sandboxed `bwrap` or Kubernetes). It runs in its own volume with an explicit stop and wake lifecycle, and its transcripts are mirrored into the fleet's own log store. See [Clone workspaces](/fleet/clone-workspaces/) and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

The fleet starts each local session daemon by running `omp-web session`, the same command you run by hand to stand up a session daemon on a remote host for the fleet to dial. See [Run a session daemon](/cli/session-daemon/).

## Session daemons are disposable, transcripts are durable

A session daemon is a process, not storage. It hosts one live agent session at a time, and it can go away at any moment: it goes to sleep after a period of inactivity, you can stop it from the UI or the CLI, and a crash triggers a bounded automatic restart. None of that loses work. Each conversation is durably recorded in its session transcript on disk, and waking or respawning a session daemon resumes from that transcript. The fleet itself keeps roster metadata such as registered projects, worktrees, and the last session file per entry, plus two deliberate persistence exceptions: a fleet-private workspace record on each clone row, and the log store that mirrors transcript lineage.

In practice: treat session daemons as replaceable workers, and transcripts as the thing worth keeping.

## Who it is for

omp-web targets a single operator running many agents, typically across local projects, Git worktrees, and provider-managed clone workspaces. Multi-user access is not a current feature. A few boundaries are worth knowing:

- Analysis, the historical transcript and usage views, is served by the fleet alongside the Work view.
- Collaboration rooms are hosted and joined through the CLI or TUI; there is no browser collaboration surface.
- Remote access is user-managed, for example over SSH forwarding or a private network. The fleet can also gate the browser with an operator access token and run behind your own TLS reverse proxy; see [Browser access and sign-in](/operations/browser-auth/).
- Clone workspaces need a declared provider profile. A fleet with none configured reports clone creation as unavailable until you add one; see [Provider profiles](/configuration/provider-profiles/).

## Early stage

> **Early-stage software.** omp-web is under active development and has sharp edges. Expect breaking changes between releases: the wire protocol, configuration and state formats, and the UI are not yet stable. Session transcripts are durable JSONL files, but the surrounding tooling (fleet state, configuration, managed worktrees, and clone workspaces with their provider profiles) is still evolving, so do not treat it as production data storage yet. Report issues and rough spots as you find them.

## Next steps

- [Installation](/getting-started/installation/) covers the Bun runtime, the `omp` CLI, and provider requirements.
- [First run](/getting-started/first-run/) walks through starting the fleet for the first time.
- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) explains the model behind everything above.
