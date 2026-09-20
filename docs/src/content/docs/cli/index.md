---
title: CLI and automation
description: Inspect and operate the fleet from scripts and terminals.
---

The installed `omp-web` command starts runtime modes and exposes fleet operations for local automation.

## Command families

- Inspect the roster with `sessions` and adoptable linked worktrees with `projects`.
- Register repositories or endpoints with `add-repo` and `add`.
- Start work with `spawn` and `provision`.
- Operate entries with `stop`, `remove`, and `rm-project`.
- Manage worktrees with `add-worktree` and `rm-worktree`.
- Send prompts with `prompt`.
- Start runtimes with bare `omp-web`, `serve`, or `session`.
- Inspect or update the installation with `--version` and `update`.

Fleet selectors can address one session daemon ID, all eligible entries, a name glob, a label, or a project. Fan-out runs different session daemons concurrently while preserving prompt order within each one.

## In this section

- [CLI overview](/cli/overview/) covers the control-plane connection, runbook, output streams, and exit codes.
- [Manage projects and worktrees](/cli/projects-and-worktrees/) registers projects and creates, adopts, or deletes worktrees.
- [Operate session daemons](/cli/session-daemon-operations/) lists, starts, stops, and removes roster entries.
- [Select multiple session daemons](/cli/selectors/) documents the selector grammar.
- [Fan-out prompting](/cli/fanout/) sends one prompt to many session daemons with correlated results.
- [Run a standalone session daemon](/cli/standalone/) starts single-session mode from the terminal.

Use [CLI commands and flags](/reference/cli/) for the exact syntax supported by the installed version.
