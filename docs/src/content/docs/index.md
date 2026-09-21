---
title: omp-web
description: Web sessions and fleet management for Oh My Pi.
template: splash
hero:
  tagline: Run and manage Oh My Pi coding sessions from the browser.
  actions:
    - text: Get started
      link: /omp-web/getting-started/installation/
      icon: right-arrow
    - text: First run
      link: /omp-web/getting-started/first-run/
      icon: rocket
    - text: View on GitHub
      link: https://github.com/nibblebot/omp-web
      icon: external
      variant: minimal
---

Start with [What is omp-web?](/getting-started/overview/) for the product model, or continue to
[Installation](/getting-started/installation/) and [First run](/getting-started/first-run/).

## Browse the documentation

- [Getting started](/getting-started/): install omp-web, register a project, and send your first prompt.
- [Core concepts](/concepts/): the project and worktree model, persistence, and lifecycle.
- [Working with sessions](/sessions/): prompting, queues, tool calls, models, history, recovery, and export.
- [Fleet management](/fleet/): the sidebar, projects, worktrees, session daemon operations, and status.
- [Clone workspaces](/fleet/clone-workspaces/): provider-managed sessions on their own volume, with stop, wake, and verified deletion.
- [Analysis and usage](/analysis/): context and cost, provider limits, transcripts, analytics, and subagents.
- [Stored sessions](/analysis/stored-sessions/): read-only browsing of the transcripts the fleet mirrors into its log store.
- [Configuration](/configuration/): settings ownership, models and auth, web preferences, data, and spawn templates.
- [Provider profiles](/configuration/provider-profiles/): declare sandboxed bwrap or Kubernetes environments under `providerProfiles`.
- [CLI and automation](/cli/): fleet commands, selectors, fan-out prompting, and session daemons.
- [Remote and advanced](/advanced/): SSH, custom providers, collaboration, and architecture.
- [Sandboxed session runtime](/advanced/sandbox-runtimes/): the session-runtime image and the provider executables clone workspaces run on.
- [Operations](/operations/): networking, security, updates, lifecycle recovery, diagnostics, and troubleshooting.
- [Browser access and sign-in](/operations/browser-auth/): the access token, session cookie, and origin checks that gate non-loopback browsers.
- [Reference](/reference/): canonical tables for commands, configuration, environment, files, and terminology.
- [Project](/project/): changelog, contributing, release process, and design.
