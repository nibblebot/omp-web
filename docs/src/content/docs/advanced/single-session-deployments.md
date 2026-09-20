---
title: Single-session deployments
description: Run one session daemon for one directory with omp-web session, connect a browser directly to it, and understand its host, token, idle, resume, and download behavior.
---

`omp-web session` runs a single session daemon that serves the browser UI from the same process. It is the right deployment when you want one checkout, one conversation, and no fleet: a workstation, a build box, or a remote host you reach through a forward. The session daemon is bound to one directory for its whole lifetime, hosts exactly one live session, and stores the conversation in a durable transcript that outlives the process. [Fleet and single-session modes](/concepts/runtime-modes/) compares this runtime with fleet mode.

## Prerequisites

- `omp-web` installed and on `PATH`. See [Installation](/getting-started/installation/).
- An `omp` configuration with at least one authenticated provider and a default model. The session daemon resolves them at boot, and prompts stay gated until resolution finishes. See [First run](/getting-started/first-run/) and [Start your first session](/getting-started/start-first-session/).
- A directory to serve. It is fixed when the session daemon starts and cannot change while the process runs.

## Start a session daemon for one directory

```sh
omp-web session --cwd ~/repos/my-app
```

The session daemon binds and prints its machine-readable listening line on stdout before the session finishes booting:

```text
OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}
```

A human-readable line goes to stderr. It always names `localhost`, while the stdout line carries the actual bind address and port:

```text
omp-session listening on http://localhost:4721
```

Expected result: a running process, the listening line above, and the UI at the printed address. The process keeps running until you stop it, it exits after its idle timeout, or it receives a termination signal.

Deployment options:

| Option | Default | Effect |
| --- | --- | --- |
| `--cwd <dir>` | the working directory | The directory this session daemon is bound to for its process lifetime. |
| `--port <n>` | `4721` | Listen port. `0` asks the operating system for a free port; the real port is in the listening line. |
| `--host <addr>` | `127.0.0.1` | Bind address. Loopback means `localhost`, `::1`, or any `127.x.x.x` address. Any other value requires a token. |
| `--token <secret>` | none | Bearer credential required from peers that are not on loopback. |
| `--idle-timeout <duration>` | `30m` | Exit after this much continuous inactivity. Accepts `90s`, `30m`, `1h`, or bare milliseconds. `0` disables the timeout. |
| `--resume <path>` | none | Continue the transcript at this path from boot. |
| `--name <name>` | the directory basename | Display name reported to clients and to a fleet that later supervises the session daemon. |
| `--label k=v` | none | Selector label for fleet fan-out; repeatable. |
| `--advertise <url>` | none | Reported verbatim as the `advertise` field of the listening line for wrappers. It does not change the bind. |

Each flag has an environment equivalent under `OMP_SESSION_*` (`--port` and `OMP_SESSION_PORT`, `--cwd` and `OMP_SESSION_CWD`, and so on). An explicit flag wins over its environment variable, which wins over the default. The complete flag list is in [CLI commands and flags](/reference/cli/), and the environment variables are in [Environment variables and precedence](/reference/environment/).

An ephemeral port keeps parallel deployments from colliding. Read the real port from the listening line:

```sh
omp-web session --cwd ~/repos/my-app --port 0
```

## Browser URL and what the session daemon serves

- Same machine, default bind: open `http://localhost:4721/`.
- The session daemon serves the UI itself from its embedded assets, and the page talks to the same origin: `/events` is the event stream and `/command` accepts commands. The UI's own traffic carries the credential from the page URL when the deployment uses a token.
- Opening the event stream attaches the browser to the single session immediately. There is no attach step and no session daemon switcher, because there is only one session daemon to reach.
- The chat surface is the same as in fleet mode, but the surrounding fleet surfaces are not. There is no fleet sidebar and no project or worktree management. Analysis is also unavailable, because the historical transcript and usage views read the fleet's control API, which this process does not serve.

If you run from a source checkout that has never been built, the session daemon serves a placeholder page instead of the UI. Install the release build to get the browser UI, as described in [Installation](/getting-started/installation/).

## Host, port, and token rules

- Loopback peers are exempt from the token. The default bind plus a browser on the same machine needs no credential.
- Binding a non-loopback address without a token is refused at startup:

  ```text
  omp-session: refusing to bind non-loopback address "0.0.0.0" without a token; pass --token or set OMP_SESSION_TOKEN
  ```

- Off loopback, every request must present the bearer token, through `Authorization: Bearer <token>` or a `?token=<token>` query parameter. This covers the page, its static assets, `/events`, `/command`, and `/download`. A missing or wrong value is HTTP 401, and the token value is case-sensitive.
- A browser can pass the token on the traffic the UI issues programmatically, the event stream and command POSTs, but plain requests for assets and downloads do not inherit the page's query string. Treat a token-carrying URL as suitable for a trusted local network only.

Reach a remote deployment through a transport you control: an SSH local forward, a private tailnet, or a TLS reverse proxy on the session daemon host that injects the credential or forwards to a loopback-bound session daemon. There is no built-in TLS server and no user accounts. Transport security, network reachability, token distribution, and filesystem permissions are deployment responsibilities. See [Networking and browser access](/operations/networking/) and [Security model](/operations/security/).

## Idle timeout and shutdown

The session daemon is disposable, and the transcript is durable.

- The default idle timeout is 30 minutes. `--idle-timeout 0` keeps the process alive until you stop it.
- A session daemon counts as idle only when nothing is attached and nothing is in progress: no open browser stream, no streaming turn, no queued message, no open dialog, no in-flight shell or Python call, and no live collaboration room. The check runs every 15 seconds, and any socket message or active condition resets the clock.
- With a browser tab open, the stream keeps the session daemon alive, so the idle timer does not fire under active use.
- On idle exit the session daemon logs to stderr and exits 0:

  ```text
  omp-session: idle for 1800000ms; shutting down
  ```

- `Ctrl+C`, `SIGTERM`, and `SIGHUP` run the same shutdown: the session is disposed, the session file lock is released, and the process exits 0.

Restarting after an idle exit is normal operation, not recovery. Start the session daemon again with `--resume` to continue the same conversation.

## Resume and transcript locking

- Boot resume: `omp-web session --cwd ~/repos/my-app --resume <path-to-transcript>` switches the new session into that transcript. If the switch fails, the session daemon logs `omp-session: --resume <path> failed (<error>); starting fresh` on stderr and serves a fresh session instead.
- A fresh session is a draft until it receives a message. If the session daemon exits while the transcript is still empty, it drops the draft file; a conversation with any content persists.
- In the browser, `/resume` opens `Resume from disk`, listing the transcripts recorded for the bound directory only, newest first, up to 200 entries. Picking one switches the live session to that transcript. Transcripts from other directories are never listed, even when the bound directory has none.
- The session daemon locks the transcript it resumes before boot finishes, and locks the live session file once the session exists. A second session daemon pointed at the same file refuses to start and exits 1:

  ```text
  omp-session: session file <file> is locked by another omp-session (pid <pid>)
  ```

- Locks are released on every exit path, including idle exit, `Ctrl+C`, and signals. Never delete a lock file to force a takeover: stop the process that holds it.
- The transcript survives the process. Closing the browser tab does not end the conversation; stop the process if you want the session daemon gone.

## Downloads

The session daemon streams a requested file back over HTTP at `/download?path=<path>`. The export notices link to it: `/export` for the session HTML, `/dump` for the LLM request JSON, and `/handoff` for the handoff document.

The route is the session daemon's only file-egress path, and the target is resolved through `realpath` before it is served:

- Approved roots are the system temp directory, the bound `--cwd` directory, and the directory of a live session file. A canonical path outside those roots is refused with HTTP 403, so symlinks cannot escape.
- A request without `path` is HTTP 400, and a missing file or a path that is not a file is HTTP 404.
- A relative path is resolved against the bound directory first, then the session daemon's process working directory.

Off loopback the bearer rules apply here too, and a plain browser download does not inherit the page's token, as described above. On loopback the route needs no credential. See [Export and download sessions](/sessions/export/) for the user-facing export workflow.

## Differences from fleet mode

| Aspect | Fleet mode | Single-session mode |
| --- | --- | --- |
| Process supervision | The fleet spawns, restarts, stops, and wakes session daemons | You start and stop the process, for example with a terminal, a service manager, or a container |
| Directories | Many registered projects and worktrees | One bound directory |
| Browser surfaces | Fleet sidebar, roster, project and worktree management, Analysis | Chat surface only, with no fleet sidebar and no Analysis |
| Fleet verbs | Work against the running fleet | `spawn`, `spawn_resume`, `stop`, and `list_projects` answer `fleet-only command` |
| Credentials | A fresh token is minted per spawn | You choose the token, and it is required only off loopback |
| State | The fleet registry under the data home | No registry; the session daemon reads your `omp` agent configuration for providers, models, and settings |
| Concurrency | One session daemon per worktree, many at once | One live session per process |

A fleet can supervise a session daemon that runs elsewhere only by dialing in. The fleet initiates the connection to the session daemon endpoint; the session daemon never dials out and never learns the fleet's address. That is why remote session daemons are registered with an endpoint and a token instead of a callback address. See [Run a remote session daemon over SSH](/advanced/ssh/) and [Networking and browser access](/operations/networking/).

## Common failures

- Refused bind: the session daemon prints the token refusal above and exits 1. Start it with `--token` or `OMP_SESSION_TOKEN`, or bind loopback and use a forward.
- HTTP 401 in the browser: the request lacks the bearer credential. Off loopback, load the page with `?token=<token>`; asset and download requests need the same credential through a proxy or forward.
- Prompts stay gated with a resolving state: provider, model, or authentication did not resolve. Fix the `omp` configuration, then restart the session daemon.
- `Failed to start agent session: <error>` followed by exit 1: the session could not be created, usually because the bound directory is missing or unreadable. Check `--cwd` and start again.
- `omp-session: session file <file> is locked by another omp-session (pid <pid>)`: another process holds that transcript. Stop it, or resume a different transcript.
- Port already in use: another process owns the port. Use `--port 0` and read the real port from the listening line, or choose a different port.
- Placeholder page in the browser: the process is running from a source checkout with no built UI. Install the release build.
- A dropped stream that does not recover: check the session daemon process and the network path first. A 401 and a protocol mismatch are terminal and need a credential or matching versions instead of patience. [Troubleshooting](/operations/troubleshooting/) covers the general symptom list.

## Related

- [What is omp-web?](/getting-started/overview/)
- [Fleet and single-session modes](/concepts/runtime-modes/)
- [Run a standalone session daemon](/cli/standalone/)
- [Networking and browser access](/operations/networking/)
- [Security model](/operations/security/)
- [CLI commands and flags](/reference/cli/)
- [Troubleshooting](/operations/troubleshooting/)
