---
title: Remote and advanced
description: Connect remote session daemons and understand advanced deployment boundaries.
---

omp-web can supervise session daemons outside the fleet host when you provide a reachable endpoint and the required authentication.

## Connection model

Remote operation is dial-in: the fleet initiates the connection to a remote session daemon. The remote environment does not connect back to the fleet. Use SSH forwarding, a private tailnet, or user-managed TLS to protect that path.

A managed clone workspace is the one exception: its sandboxed daemon has no inbound service and dials the fleet's callback pair outbound. Clone workspaces are covered in [Clone workspaces](/fleet/clone-workspaces/) and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

A custom-provider setup follows the same process boundary. The session daemon runs where the project files and agent configuration are available, while the fleet retains only roster and connection metadata.

## Collaboration boundary

Collaboration rooms are hosted and joined through the CLI or TUI. omp-web currently has no browser collaboration surface.

## In this section

- [Run a remote session daemon over SSH](/advanced/ssh/) wires a session daemon on another host through a tunnel or a direct dial.
- [Integrate a custom provider](/advanced/custom-provider/) enrolls session daemons through the provisioning hook.
- [Collaboration rooms](/advanced/collaboration/) hosts and joins CLI/TUI collaboration rooms.
- [Sandboxed session runtime](/advanced/sandbox-runtimes/) describes what runs inside a clone workspace sandbox, and its isolation limits.
- [Architecture overview](/advanced/architecture/) maps the runtime products, topology, and boundaries for contributors.
