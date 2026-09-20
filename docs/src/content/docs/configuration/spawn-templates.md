---
title: Configure spawn templates
description: Define the commands omp-web uses to start local session daemons, how a template is selected, and how the provisioning hook enrolls remote session daemons.
---

Every local session daemon the fleet starts is launched from a spawn template: a named command, plus an optional declared host, that the fleet runs for one directory. The default template starts the installed `omp-web session` entrypoint. Custom templates cover wrappers: a container launcher, an SSH command that starts the session daemon on another machine, or anything else that ends with a real session daemon listening for the fleet.

Templates are fleet configuration, read from the fleet's config file. For the complete schema, see the [configuration reference](/reference/configuration/); this page covers the templates, their placeholders, how one is chosen, and the related provisioning hook.

## The config file

The fleet reads `~/.omp-web/config.json` by default, or the file named by `OMP_FLEET_CONFIG`. The first-run offer is the only writer, but hand edits are read on the next start and unknown keys are tolerated, so a templates block can simply be added to the file:

```json
{
  "templates": {
    "local": {
      "command": "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}"
    },
    "sandbox": {
      "command": "/usr/local/bin/omp-web-sandbox {cwd} {token} {name} {labels} {resume}",
      "host": "sandbox-host"
    }
  },
  "defaultTemplate": "local",
  "projectTemplates": { "app": "sandbox" }
}
```

- The `local` command in this example is the built-in default template. It only needs to exist in the file when you want to change it.
- The command runs through `sh -c`, so it can be a wrapper, a pipeline, or any shell invocation.
- The optional `host` is a template-declared reachable hostname. The fleet uses it when the spawned process reports a listening port but no other reachable address, composing the dial address from that host and the reported port.

## Placeholders

| Placeholder | Expands to |
| --- | --- |
| `{cwd}` | The absolute directory the session daemon must bind. |
| `{token}` | A bearer token minted fresh for this spawn or restart. It gates that one session daemon. |
| `{name}` | The entry's display name, from the spawn request or the directory basename. |
| `{labels}` | Zero or more `--label k=v` arguments, or empty when the entry has no labels. |
| `{resume}` | `--resume <session file>` when there is a session to resume, or empty for a fresh start. |

Three rules matter when writing a command:

- The template is trusted configuration; the values substituted into it are not. The fleet shell-quotes every value before substitution, so place a placeholder directly as an argument and do not add your own quotes around it. A directory containing spaces or quotes arrives at the command as one safe argument.
- Unknown placeholders are left verbatim. Anything that does not parse as a bare word inside braces, such as `{cwd }`, stays in the command text, so the spawn fails visibly instead of substituting an empty value.
- The command must end with a real session daemon: a process that prints its `OMP_SESSION|` listening contract on stdout, with logs on stderr. Wrappers that start the session daemon indirectly (in a container, over SSH) can instead print an `OMP_SESSION|` endpoint line naming the reachable address.

The fleet resolves the address to dial in this order: a wrapper-reported endpoint line, then the template `host` with the reported listening port, then the session daemon's advertised URL, then loopback. If no listening line arrives within 30 seconds, the spawn fails and the child is killed.

## Selecting a template

First match wins:

1. **An explicit template** named in the spawn request: `omp-web spawn <path> --template <name>`, `omp-web add-repo <path> --template <name>`, or the Add repo modal's Advanced section, whose dropdown lists the configured template names.
2. **A per-directory override** from `projectTemplates`, keyed by the basename of the directory being spawned. A main checkout is keyed by its repository directory name; a managed worktree is keyed by its worktree directory name.
3. **`defaultTemplate`**, which defaults to `local`.

An unknown name at any tier rejects the spawn before any roster entry is created. The resolved name is stored on the entry, so stop, wake, and crash restarts reuse the same template even if the selection settings change later. Editing a template's command affects the next restart of every entry using that name; removing the name leaves those entries unable to restart, and the affected row reports an unknown spawn template error.

Sidebar actions that start a session (the project header's start action, or starting a session while creating a worktree) pass no explicit template, so they follow the override and default tiers.

Labels are separate from templates but travel with them: the entry's `k=v` labels are rendered into `{labels}`. Set them with `--label k=v` (repeatable) on `omp-web spawn`, `--labels k=v,...` on `omp-web add-repo`, or the labels field in the Add repo modal. They also feed fleet fan-out selectors; see [Fan-out prompting](/cli/fanout/).

## Provisioning hook for remote session daemons

The `spawnHook` key enrolls a session daemon that the fleet does not start as a child, typically on a remote host or inside a container. `OMP_FLEET_SPAWN_HOOK` wins over the file value.

The hook runs through `sh -c` with a 60 second deadline and two environment variables: `OMP_HOOK_NAME` (the requested name, possibly empty) and `OMP_HOOK_LABELS` (comma-joined labels, possibly empty). Its last non-empty stdout line must be a JSON object:

```json
{ "name": "sandbox", "url": "ws://127.0.0.1:49153", "token": "...", "cwd": "/home/you/code/app" }
```

Everything else the hook prints on stdout is ignored, and diagnostics belong on stderr. On success the fleet registers a remote entry and dials it. The model is dial-in only: the session daemon accepts a connection from the fleet and never learns the fleet's address or state, and the token gates only that session daemon.

Trigger the hook with `omp-web provision <name> [--label k=v]…`. Provisioning is a CLI-driven surface: the browser has no action for it, and the fleet's provisioning route is refused as misconfigured when no hook is set. [Integrate a custom provider](/advanced/custom-provider/) has a complete hook skeleton, and [Run a remote session daemon over SSH](/advanced/ssh/) and [Run session daemons in Docker](/advanced/docker/) show the same pattern aimed at remote hosts and containers.

## Managed worktree root

The same config file carries `workspaceDir`, the root under which fleet-managed worktrees are created. It resolves as `--workspace-dir` on `omp-web serve`, then `OMP_FLEET_WORKSPACE_DIR`, then the config key, then `~/.omp-web/workspaces`. A leading `~` expands to your home directory, and the root is created lazily on the first managed worktree. Because deletion refuses worktrees outside this root, keep it stable; see [Data and state management](/configuration/data-and-state/).

## Environment overrides

| Variable | Effect |
| --- | --- |
| `OMP_FLEET_CONFIG` | Selects the config file. |
| `OMP_FLEET_LOCAL_TEMPLATE` | Replaces the `local` template's command outright. The development runners use it to launch source entry points; prefer named templates in normal use. |
| `OMP_FLEET_SPAWN_HOOK` | Overrides the file's `spawnHook`. |
| `OMP_FLEET_WORKSPACE_DIR` | Overrides the file's `workspaceDir`; `--workspace-dir` overrides both. |

The environment reference owns the full precedence list: [Environment variables and precedence](/reference/environment/).

## Failure states

- `unknown spawn template: <name>` means the request named a template that is not defined, or a stored name no longer exists after an edit. The spawn is rejected before an entry is created.
- `endpoint timeout` means the command ran but no listening line arrived within 30 seconds. The child is killed and the row reports the error.
- A child that exits before becoming ready is restarted with exponential backoff, up to five restarts. When the budget is exhausted, the row reports how many times the child exited.
- A ready session daemon that exits cleanly with no clients attached is a normal idle sleep. The row becomes asleep and wakes with `--resume` when you pick it.
- `error cwd mismatch` means the session daemon reported a different working directory than the one registered. The fleet refuses to attach there; fix the wrapper so it starts the session daemon in `{cwd}`.
- A hook that exits non-zero, times out, or prints no JSON object fails the provisioning request without registering an entry.

## Related

- [Configuration schema](/reference/configuration/)
- [Environment variables and precedence](/reference/environment/)
- [Data and state management](/configuration/data-and-state/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Run a remote session daemon over SSH](/advanced/ssh/)
- [Run session daemons in Docker](/advanced/docker/)
- [Integrate a custom provider](/advanced/custom-provider/)
- [Fan-out prompting](/cli/fanout/)
