---
title: Run a session daemon
description: "Start one session daemon with omp-web session: a single bound directory, one live agent session, a stdout listening contract, token and host rules, idle auto-exit, and how a fleet dials it."
---

`omp-web session` starts one session daemon: a process bound to one directory for its lifetime, hosting exactly one live agent session. It serves the wire API only, never a browser UI. Two kinds of caller run this command:

- The fleet's default local spawn template, which starts a session daemon as a child process with `--port 0` and dials the endpoint it prints.
- You, by hand, on a host the fleet should reach over the network.

Either way the browser talks to the fleet, and the fleet proxies it through to the attached session daemon. A session daemon on its own has no web UI to open. See [Local and remote sessions](/concepts/local-and-remote/) for how the two fit together, and [Configure spawn templates](/configuration/spawn-templates/) for the local spawn path.

A session daemon never reads the fleet config or the fleet registry. It is bound to one directory and hosts one live session at a time: new session, resume, branch, fork, and handoff replace the live session one after another rather than running side by side.

## Start one

```sh
cd ~/code/app
omp-web session
```

The process binds and stays in the foreground until you stop it, it exits after its idle timeout, or it receives a termination signal.

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

One more group of flags exists for the clone workspace transport: `--callback-url`, `--callback-workspace`, `--callback-generation`, `--callback-token`, `--callback-proxy`, and `--callback-allow-http`. They make the daemon dial the fleet's callback pair instead of listening for it, which is how a workspace that has no inbound service is reached. The fleet fills them for the daemons it starts inside a workspace; you do not set them by hand unless you are building that transport yourself. See [Clone workspaces](/fleet/clone-workspaces/) and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## Output and startup failures

- Standard output carries one machine-readable contract line whose JSON describes the bound address, port, and URL:

  ```text
  OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}
  ```

  Everything else, including human logs, goes to standard error, so a supervisor can parse standard output safely. See [CLI commands and flags](/reference/cli/).
- An invalid value, such as a port outside the valid range or a malformed duration, exits 1 with the reason.
- Binding a non-loopback address without a token is refused at startup with exit 1. The session daemon will not run unauthenticated off loopback.
- `--resume` on a file that cannot be opened warns on standard error and starts a fresh session instead of failing.

## What the daemon serves

- The wire API: `GET /events` streams events, `POST /command` accepts commands, and the collaboration relay listens at `/r/<roomId>`. See [Collaboration rooms](/advanced/collaboration/).
- No HTML and no browser bundle. The fleet edge serves the web UI and proxies the browser to the session daemon you attach, so open the fleet's printed `Web UI` URL to work in a browser.
- No registry, no roster, no project or worktree management, and no Analysis views. Those belong to the fleet. A fleet-only command answers as unknown here, because there is no roster to read or change.
- The `/download` route serves a file to a client that calls it directly, but a browser attached through the fleet never resolves it: the fleet does not proxy that route, so export and dump notices name the path on the host running the session daemon instead. Retrieve the file there.

## Idle auto-exit, resume, and session locks

A session daemon exits on its own after 30 minutes during which nothing needs it: no attached client, no running turn or queued prompt, no in-flight tool work, no open dialog, and no live collaboration room. `--idle-timeout 0` disables that behavior for a session daemon that must stay resident.

The exit is safe because the session is a durable file. Start the session daemon again with `--resume <file>` to continue the same conversation, or let a fleet wake it. A session file is locked while a session daemon holds it, so a second session daemon pointed at the same transcript refuses to start with `omp-session: session file <file> is locked by another omp-session (pid <pid>)` instead of risking two writers. See [Session persistence](/concepts/session-persistence/) and [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

## Token and host rules

- The default bind is `127.0.0.1`, and loopback peers are exempt from the token. That is the right setup for a session daemon the fleet spawns on its own machine.
- A non-loopback bind requires a token. Without one the process refuses to start:

  ```text
  omp-session: refusing to bind non-loopback address "0.0.0.0" without a token; pass --token or set OMP_SESSION_TOKEN
  ```

- Off loopback, every request must present the bearer token, through `Authorization: Bearer <token>` or a `?token=<token>` query parameter. A missing or wrong value is HTTP 401, and the token value is case-sensitive.
- `--advertise <url>` reports the address a fleet should dial when it differs from the bind, which happens behind SSH port forwarding or a container publish:

  ```sh
  omp-web session --cwd /srv/app --port 4721 --host 0.0.0.0 --token "$TOKEN" --advertise ws://127.0.0.1:48080
  ```

The session daemon has no built-in TLS and no user accounts. Transport security, network reachability, token distribution, and filesystem permissions are deployment responsibilities; see [Networking and browser access](/operations/networking/) and [Security model](/operations/security/).

## Registering it with a fleet

The fleet never discovers session daemons by scanning. To let a fleet dial a session daemon you started by hand, register its address:

```sh
omp-web add app-box ws://app-box.example.com:4721 --token "$TOKEN" --cwd /srv/app
```

The entry appears as a remote row, and the fleet reconnects to it as needed. The connection is dial-in only: the session daemon never dials out and never learns the fleet's address. See [Operate session daemons](/cli/session-daemon-operations/), [Local and remote sessions](/concepts/local-and-remote/), and the worked example in [Run a remote session daemon over SSH](/advanced/ssh/).

## Related

- [CLI overview](/cli/overview/)
- [Operate session daemons](/cli/session-daemon-operations/)
- [Local and remote sessions](/concepts/local-and-remote/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Session persistence](/concepts/session-persistence/)
- [Configure spawn templates](/configuration/spawn-templates/)
- [CLI commands and flags](/reference/cli/)
