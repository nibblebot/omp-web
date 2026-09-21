---
title: Configuration
description: Configure browser preferences, agents, the fleet, and persistent data.
---

omp-web settings have different owners and persistence boundaries. Treating them as one global settings object leads to incorrect expectations.

## Configuration domains

- **Browser-local preferences:** theme, font size, notifications, sidebar usage visibility, and prompt history.
- **Session controls:** thinking level, fast mode, retry behavior, reveal behavior, and active-session actions.
- **Agent configuration:** providers, authentication, models, roles, and schema-backed Oh My Pi settings.
- **Fleet configuration:** spawn templates, the default template, project template selection, spawn hooks, the managed-worktree directory, provider profiles, and the browser-auth settings (access token, public origin, trusted proxies).
- **Persistent data:** fleet registry state, the fleet log store, the browser-auth store, session transcripts, historical statistics, and browser storage.

Precedence is specific to each domain. Fleet and session-daemon flags, environment variables, configuration-file values, and defaults must be evaluated against the command that owns them rather than assumed to share one universal order.

## In this section

- [Settings overview](/configuration/settings/) maps the settings panel and each save path.
- [Models and provider authentication](/configuration/models-and-auth/) assigns models to roles and authenticates providers.
- [Web interface preferences](/configuration/web-preferences/) lists the browser-local display and behavior options.
- [Data and state management](/configuration/data-and-state/) explains what lives on disk and what is safe to back up or delete.
- [Configure spawn templates](/configuration/spawn-templates/) defines the commands used to start session daemons.
- [Provider profiles](/configuration/provider-profiles/) declares the bwrap or Kubernetes environments that manage clone workspaces.
