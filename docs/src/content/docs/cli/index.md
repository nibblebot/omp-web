---
title: CLI and automation
description: Inspect and operate the fleet from scripts and terminals.
---

The installed `omp-web` command starts the fleet and session daemons, and exposes fleet operations for local automation.

## Command families

- Inspect the roster with `sessions`, adoptable linked worktrees with `projects`, and loaded clone provider profiles with `profiles`.
- Register repositories or endpoints with `add-repo` and `add`.
- Start work with `spawn` and `provision`, and provision clone workspaces with `add-clone`.
- Operate entries with `start`, `stop`, `remove`, and `rm-project`.
- Manage worktrees with `add-worktree` and `rm-worktree`.
- Send prompts with `prompt`.
- Validate a clone provider profile on this host with `preflight`.
- Start the fleet with bare `omp-web` or `serve`, and one session daemon with `session`.
- Inspect or update the installation with `--version` and `update`.

Fleet selectors can address one session daemon ID, all eligible entries, a name glob, a label, or a project. Fan-out runs different session daemons concurrently while preserving prompt order within each one.

## In this section

- [CLI overview](/cli/overview/) covers the control-plane connection, runbook, output streams, and exit codes.
- [Manage projects and worktrees](/cli/projects-and-worktrees/) registers projects and creates, adopts, or deletes worktrees.
- [Operate session daemons](/cli/session-daemon-operations/) lists, starts, stops, and removes roster entries.
- [Select multiple session daemons](/cli/selectors/) documents the selector grammar.
- [Fan-out prompting](/cli/fanout/) sends one prompt to many session daemons with correlated results.
- [Run a session daemon](/cli/session-daemon/) starts one session daemon from the terminal.

Use [CLI commands and flags](/reference/cli/) for the exact syntax supported by the installed version. Clone workspaces, their provider profiles, and the log store they leave behind are covered in [Clone workspaces](/fleet/clone-workspaces/), [Provider profiles](/configuration/provider-profiles/), and [Stored sessions](/analysis/stored-sessions/).
