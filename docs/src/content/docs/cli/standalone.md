---
title: Run a standalone session daemon
description: "Start one session daemon for a single checkout with omp-web session, connect a browser to it directly, and know what single-session mode does not have."
---

`omp-web session` runs one session daemon bound to one directory and serves the web interface from that same process. This is single-session mode: the browser talks to the session daemon directly, with no fleet, no roster, and no projects or worktrees to manage. It is also the command the fleet runs for a local session daemon, so everything here applies to those children too.

Use it when a whole fleet would be overhead: a single repository on one machine, a container that serves exactly one checkout, or a remote host you want to reach directly. For the mode comparison, see [Fleet and single-session modes](/concepts/runtime-modes/); for the deployment considerations of serving one session daemon, see [Single-session deployments](/advanced/single-session-deployments/).

## Start one

```sh
cd ~/code/app
omp-web session
```

Then open the URL the process prints, `http://localhost:4721` by default. The directory is bound at startup and never changes for the life of the process, so there is no command that repoints a running session daemon.

Useful flags:

| Flag | Effect |
| --- | --- |
| `--cwd <dir>` | Bind this directory instead of the current one |
| `--port <n>` | Listen on this port; default 4721, and `0` picks an ephemeral port |
| `--host <addr>` | Bind address; default `127.0.0.1` |
| `--token <t>` | Bearer credential required from off-loopback peers |
| `--advertise <url>` | Address reported to a fleet dialing this session daemon, when it differs from the bind; `ws://` or `wss://` form |
| `--name <n>` | Display name, defaulting to the directory name |
| `--label k=v` | Attach a selector label; repeatable |
| `--resume <file>` | Open this session transcript at startup instead of a new session |
| `--idle-timeout <d>` | Idle auto-exit window; default 30m, accepts `90s`, `30m`, `1h`, or bare milliseconds, and `0` disables it |

Each flag has an `OMP_SESSION_*` environment equivalent; see [Environment variables and precedence](/reference/environment/).

With `--port 0` the real port is assigned at bind time. Read it from the process output rather than assuming one.

## Output and startup failures

- Standard output carries one machine-readable contract line whose JSON describes the bound address, port, and URL. Everything else, including human logs, goes to standard error, so a supervisor can parse standard output safely. See [CLI commands and flags](/reference/cli/).
- An invalid value, such as a port outside the valid range or a malformed duration, exits 1 with the reason.
- Binding a non-loopback address without a token is refused at startup with exit 1. The session daemon will not run unauthenticated off loopback.
- `--resume` on a file that cannot be opened warns on standard error and starts a fresh session instead of failing.

## Single-session mode differences

- One live session per process. New session, resume, branch, fork, and handoff replace the live session one after another; they never run side by side.
- No fleet sidebar, no roster, and no project or worktree management. Those belong to the fleet.
- The Analysis view is fleet mode only, so it is not available here, and browser fan-out prompting does not exist in either mode. Use [Fan-out prompting](/cli/fanout/) from the terminal instead.
- Collaboration rooms are a separate, non-browser surface; see [Collaboration rooms](/advanced/collaboration/).

## Idle auto-exit and restart

A session daemon exits on its own after 30 minutes during which nothing needs it: no attached browser, no running turn or queued prompt, no in-flight tool work, no open dialog, and no live collaboration room. `--idle-timeout 0` disables that behavior for a session daemon that must stay resident.

The exit is safe because the session is a durable file. Start the session daemon again with `--resume <file>` to continue the same conversation, or let a fleet wake it. A session file is locked while a session daemon holds it, so a second session daemon pointed at the same transcript refuses to start instead of risking two writers. See [Session persistence](/concepts/session-persistence/) and [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

## Reaching it from another machine

The default bind is loopback, which means only the same machine can reach the UI. To serve other machines, bind a reachable address and set a token:

```sh
omp-web session --host 0.0.0.0 --token "$TOKEN"
```

Browsers then present the token, and a request with the wrong credential is rejected. Binding a non-loopback address without a token is the startup error described above, so the two flags travel together. See [Networking and browser access](/operations/networking/) and [Security model](/operations/security/).

When the session daemon sits behind SSH port forwarding or a container publish, the address it binds is not the address a fleet can dial. `--advertise` reports the reachable address in the contract line instead:

```sh
omp-web session --cwd /srv/app --port 4721 --host 0.0.0.0 --token "$TOKEN" --advertise ws://127.0.0.1:48080
```

## Registering it with a fleet

The fleet never discovers session daemons by scanning. To let a fleet dial a session daemon you started by hand, register its address:

```sh
omp-web add app-box ws://app-box.example.com:4721 --token "$TOKEN" --cwd /srv/app
```

The entry appears as a remote row, and the fleet reconnects to it as needed. See [Operate session daemons](/cli/session-daemon-operations/), [Local and remote sessions](/concepts/local-and-remote/), and the worked examples in [Run a remote session daemon over SSH](/advanced/ssh/) and [Run session daemons in Docker](/advanced/docker/).

## Related

- [CLI overview](/cli/overview/)
- [Fleet and single-session modes](/concepts/runtime-modes/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Session persistence](/concepts/session-persistence/)
- [Operate session daemons](/cli/session-daemon-operations/)
- [Single-session deployments](/advanced/single-session-deployments/)
- [CLI commands and flags](/reference/cli/)
