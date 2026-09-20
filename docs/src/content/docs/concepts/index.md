---
title: Core concepts
description: Understand the omp-web ownership model, persistence, and lifecycle.
---

omp-web separates durable conversations from the processes that serve them. Understanding that distinction makes session recovery, worktree management, and fleet status predictable.

## Start with the ownership model

[Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) explains the four objects visible throughout omp-web and how they relate.

The central rule is simple: a session daemon is a replaceable process bound to one directory, while a session is a durable conversation stored in a transcript. Running several session daemons across worktrees provides concurrency.

## In this section

- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) defines the four-level model and the concurrency it enables.
- [Session persistence](/concepts/session-persistence/) separates durable state from disposable processes and shows what survives each kind of restart.
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) walks every status a session daemon passes through, including sleep, reconnection, and error.
- [Local and remote sessions](/concepts/local-and-remote/) explains how a session daemon joins the fleet, whether spawned locally or dialed in over the network.

For the initial workflow, continue to [Start your first session](/getting-started/start-first-session/).
