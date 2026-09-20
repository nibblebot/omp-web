---
title: Fleet management
description: Organize projects and worktrees, then operate their session daemons.
---

The fleet is the normal omp-web experience for supervising work across multiple repositories and Git worktrees. It stores roster metadata and process configuration, and it serves the web UI. Durable agent state remains in session transcripts.

## Browser workflow

[The fleet sidebar](/fleet/sidebar/) explains project groups, main-checkout and worktree rows, session selection, activity indicators, and row actions.

To create the first group, follow [Add your first project](/getting-started/add-first-project/). To start or resume work from a row, follow [Start your first session](/getting-started/start-first-session/).

## In this section

- [The fleet sidebar](/fleet/sidebar/) reads the roster at a glance: groups, rows, dots, and menus.
- [Register and remove projects](/fleet/projects/) adds a repository and deregisters it safely.
- [Create and adopt worktrees](/fleet/worktrees/) gives a project a second checkout, managed or adopted.
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/) operates the process behind a row.
- [Resume previous sessions](/fleet/resume-sessions/) reopens a durable transcript from the session picker.
- [Understand roster status](/fleet/roster-status/) decodes every status and activity indicator.
- [Safely delete managed worktrees](/fleet/delete-worktrees/) walks the guarded deletion flow.

## Safety model

Managed worktrees live under the configured workspace directory. omp-web only deletes worktrees it can prove it manages, refuses dirty trees, and never offers force deletion. Session transcripts live outside worktrees, so deleting an eligible managed worktree does not delete its conversation history.
