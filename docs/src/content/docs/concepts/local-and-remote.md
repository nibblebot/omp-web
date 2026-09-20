---
title: Local and remote sessions
description: "How session daemons join a fleet: spawned locally as supervised child processes, or dialed in as remote endpoints with their own tokens and their own host."
---

A fleet can supervise session daemons in two places. A **local session daemon** is a child process the fleet starts on its own machine. A **remote session daemon** runs wherever you like, and the fleet connects to it over the network. Both speak the same contract, both serve the same session experience in the browser, and the roster row looks the same until you read the details.

The distinction matters because ownership follows the process. The fleet can restart, stop, and probe a process it started; for one it merely dials, it can only connect, disconnect, and report what the session daemon says about itself.

## Local session daemons

Local session daemons are the default path. When you start a row, create a managed worktree, or register a project with an immediate start, the fleet runs a spawn template:

```text
omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}
```

The template placeholders are filled at spawn time:

- `{cwd}` is the directory the row is bound to, quoted for the shell.
- `{token}` is a bearer token minted fresh for that spawn.
- `{name}` is the entry name, and `{labels}` expands to the row's labels.
- `{resume}` expands to `--resume <file>` when the row has a session to restore, and to nothing when it does not.

The child prints its endpoint on stdout, and the fleet dials it. How the reachable address is chosen matters when you write your own template: the last wrapper-reported endpoint wins, then a `host` declared in the template combined with the reported port, then the address the child advertises, and finally the loopback address on the reported port. That order is what lets the same mechanism run a session daemon inside a container and still reach it from the fleet.

Because the fleet starts the process, it can also own the checkout:

- It knows the bound directory and verifies the directory the child reports against the row.
- It probes the checkout for the current branch and uncommitted changes, which is where the roster's diffstat comes from.
- It reads the last session file's title for the row.
- It can create and delete managed worktrees under the workspace directory.
- It stops and restarts the child, and marks the row asleep when the process exits.

None of this requires the checkout to be a worktree the fleet created. A registered repository's main checkout is supervised the same way; managed worktrees simply add the deletion flow.

## Remote session daemons

A remote session daemon is registered by URL, and the fleet dials it. Two commands do that:

```sh
omp-web add <name> <url> --token <token> [--label k=v] [--cwd <path>]
omp-web provision <name> [--label k=v]
```

- `add` registers a session daemon you already know how to reach. The URL uses a `ws://` or `wss://` scheme, a legacy spelling of an endpoint that speaks the same HTTP and server-sent-events contract as every other session daemon. Registration does not start anything on the remote side.
- `provision` runs the spawn hook configured in the fleet config. The hook starts or finds a session daemon and prints its enrollment as the last non-empty line of stdout, a JSON object with `url` and `token` fields and optional `name` and `cwd`. The fleet registers the result as a remote entry and dials it.

The connection is dial-in only. The fleet initiates it; the remote session daemon never connects back, never learns the fleet's address, and never receives fleet state. Everything the remote side needs is in the command line or environment you use to start it, which is why the pattern composes with SSH, containers, and private networks.

The remote session daemon itself is the same program:

```sh
omp-web session --cwd /srv/project --port 4721 --host 0.0.0.0 --token <token>
```

It needs a bind address the fleet can dial and a token: when the fleet connects across a network, the session daemon listens on a non-loopback address, and a non-loopback bind without a token is a startup error on the session daemon side, not a soft warning. The token you pass there is the same one you register with `omp-web add`. Registration succeeds without one, but a session daemon that a fleet reaches over the network always has one, so pass the token it is running with.

### What a remote row can and cannot do

| Action or fact | Local session daemon | Remote session daemon |
| --- | --- | --- |
| Attach, prompt, steer, queue, model and settings changes | yes | yes |
| Session history actions and export | yes | yes |
| Wake after sleeping | respawn the child with the resume file | redial the endpoint |
| Stop | terminate the child and mark the row asleep | drop the connection and mark the row asleep |
| Remove from the roster | yes | yes |
| Git branch and uncommitted-change diffstat | yes, probed on this machine | no, the checkout is on another host |
| Session title on the row and the session dropdown | yes, read from the session file | no, the session file is on another host |
| Managed worktree creation and deletion | yes, when the checkout is fleet managed | no |
| Analysis transcripts and statistics | yes, when the transcripts are on the fleet host | not listed, transcripts are on the remote host |

A remote row therefore has fewer roster facts, not fewer session capabilities. It appears in the fallback group in the sidebar because it has no registered project on the fleet host, and its row shows the entry name with the directory the session daemon reported.

## Choosing between them

Local is the right default: it needs no network, gives the full set of roster facts, and lets the fleet manage checkouts. Reach for a remote session daemon when the work has to happen somewhere else:

- a sandbox or second machine where the repository and credentials live,
- a container that carries its own toolchain and provider configuration,
- a host you would rather not run a fleet on.

What follows from that choice is where state lives. A remote session daemon reads its own agent configuration, uses its own provider credentials, resolves its own model, and writes its transcripts on its own disk. The fleet holds only the endpoint, the token, and the roster metadata. Analysis reads transcripts the fleet host can see, so remote sessions do not appear there.

## Security

Remote support is deliberately narrow:

- Each session daemon has its own token, and tokens are per session daemon, not per fleet. A leaked token exposes one session daemon.
- Tokens never reach the browser. Roster frames carry ids, statuses, and metadata; the token stays in the fleet's state file, so protect that file with normal filesystem permissions.
- The fleet's control plane binds to loopback, so the browser side is not exposed to the network by registering a remote session daemon.
- Transport security is yours to provide. Dial endpoints over SSH forwarding, inside a private network such as a tailnet, or behind your own TLS termination. Publishing a session daemon port directly to the internet is not a supported configuration.

An endpoint that answers with the wrong token is reported as an authorization failure and does not retry: the fleet treats a rejected credential as terminal until the row is respawned or re-registered. An endpoint that is simply unreachable retries with backoff, like any other reconnection.

## Failure cases

- **The row never leaves reconnecting.** The endpoint is unreachable: the remote process is not running, the port is not forwarded, or the URL points at the wrong host. Start or forward the session daemon, then wake the row.
- **`unauthorized (401)`.** The registered token does not match the token the remote session daemon is running with. Re-register the row with the right token, or restart the remote session daemon with the one on file.
- **`cwd mismatch`.** You registered a `--cwd` that does not match the directory the session daemon reports. Register without `--cwd` to adopt whatever the remote side reports, or pass the correct path.
- **The remote side never comes up.** A non-loopback bind without `--token` makes the session daemon exit at startup. Check its own logs, not the fleet's.
- **The row still reads ready after the remote process exited.** The fleet cannot observe processes on another host, so a stale ready row is possible. Attaching or waking it redials; a failed dial moves it to reconnecting.

## Related

- [Fleet and single-session modes](/concepts/runtime-modes/) for how the fleet serves a browser in front of these session daemons.
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) for the states a remote row passes through and how a wake redials it.
- [Session persistence](/concepts/session-persistence/) for what is stored on the fleet host and what stays on the remote one.
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/) for operating rows in the UI.
- [Operate session daemons from the CLI](/cli/session-daemon-operations/) for the command surface behind registration and wake.
- [Networking and browser access](/operations/networking/) for bind addresses, ports, and forwarding mechanics.
- [Remote and advanced](/advanced/) for complete SSH and container enrollment setups.
