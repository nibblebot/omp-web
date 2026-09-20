---
title: Remote and advanced
description: Connect remote session daemons and understand advanced deployment boundaries.
---

omp-web can supervise session daemons outside the fleet host when you provide a reachable endpoint and the required authentication.

## Connection model

Remote operation is dial-in: the fleet initiates the connection to a remote session daemon. The remote environment does not connect back to the fleet. Use SSH forwarding, a private tailnet, or user-managed TLS to protect that path.

A custom-provider setup follows the same process boundary. The session daemon runs where the project files and agent configuration are available, while the fleet retains only roster and connection metadata.

## Collaboration boundary

Collaboration rooms are hosted and joined through the CLI or TUI. omp-web currently has no browser collaboration surface.

## In this section

- [Run a remote session daemon over SSH](/advanced/ssh/) wires a session daemon on another host through a tunnel or a direct dial.
- [Integrate a custom provider](/advanced/custom-provider/) enrolls session daemons through the provisioning hook.
- [Collaboration rooms](/advanced/collaboration/) hosts and joins CLI/TUI collaboration rooms.
- [Single-session deployments](/advanced/single-session-deployments/) runs one session daemon for one directory without a fleet.
- [Architecture overview](/advanced/architecture/) maps the runtime products, topology, and boundaries for contributors.

For the simpler direct-browser deployment, [What is omp-web?](/getting-started/overview/#single-session-mode) introduces single-session mode.
