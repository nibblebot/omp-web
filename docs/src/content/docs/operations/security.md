---
title: Security model
description: Understand omp-web trust boundaries, what the application protects by default, and the transport, filesystem, and update duties that stay with the operator.
---

omp-web supervises agents that read files, run shell commands, and change your repositories. Its safety model has two halves: protections built into the fleet and the session daemon, and deployment decisions that only you can make. This page covers both and states plainly which is which.

## Before you start

- Know whether you run fleet mode (browser talks to the fleet) or single-session mode (browser talks directly to one session daemon). The boundaries below apply to both, with the fleet absent in single-session mode.
- Know the machine and OS account that runs `omp-web`. Every session daemon it spawns runs as that account with that account's filesystem access, including access to provider credentials and SSH keys.
- The exact commands for starting modes and connecting a browser live in [Networking and browser access](/operations/networking/); this page explains what those settings protect.

## Trust boundaries

| Boundary | What sits behind it | Protected by |
| --- | --- | --- |
| Browser client | Prompting, dialogs, settings, roster control | Same-origin access to the fleet edge; the client holds no credential of its own |
| Fleet edge and control plane | The browser API plus project, spawn, and worktree control | A loopback bind, and nothing else |
| Local session daemon | The agent surface: prompts, bash, python, file listing, session export | Loopback by default; a bearer token once bound off loopback |
| Remote session daemon | The same agent surface on another host or in a container | The bearer token on every off-loopback route, plus the transport you choose |
| Model provider | Conversation content and tool output sent to the provider | Your provider account and the session daemon's network egress |
| On-disk state | Tokens, transcripts, statistics, configuration | Operating-system file permissions |

The critical consequence: anyone who can reach one of these planes can drive an agent. A user who reaches the fleet port can register projects, spawn session daemons, and send prompts. A user who reaches a session daemon with a valid token can run bash and python in the session daemon's working directory. Treat access to either plane like shell access to the host.

omp-web assumes a single operator. It has no user accounts, no multi-user mode, and no browser collaboration surface, and it does not terminate TLS for you.

## The fleet plane is loopback only

The fleet binds its browser edge and control API to `127.0.0.1`. It prints this on startup:

```text
fleet listening on 127.0.0.1:4722
Web UI: http://localhost:4722
```

- The port comes from `--port`, then `OMP_FLEET_PORT`, then the default `4722`. The bind address is not configurable; there is no host flag.
- There is no bearer token on this plane. The browser API, the `/ctl` routes the CLI uses, and the streaming endpoints share one loopback server with no credential check.
- Reaching the fleet from another machine therefore means tunneling to loopback. Use SSH local forwarding (`ssh -L 4722:127.0.0.1:4722 <host>`) or a tailnet that authenticates devices, and treat the tunnel itself as the login. Never port-forward the fleet port to a public or shared interface, because anything that reaches it has full agent control without a credential.

Expected result: with the fleet running, `curl -s http://127.0.0.1:4722/ctl/sessions` answers, and the same command against your machine's external address is refused.

## Authorizing a session daemon

A session daemon binds `127.0.0.1` by default and is exempt from token checks for loopback peers. Once it is bound off loopback, every route requires the bearer token:

- `GET /events`, `POST /command`, and the collab host upgrade accept `Authorization: Bearer <token>` or `?token=<token>`.
- `/download` and the static UI require the token too when the session daemon carries one.
- A missing or wrong credential returns HTTP 401 before any protocol exchange. The scheme is matched case-insensitively, but the token value is compared exactly, so a wrong-case token is rejected.
- Binding a non-loopback address without a token is a startup error:

```text
omp-session: refusing to bind non-loopback address "0.0.0.0" without a token; pass --token or set OMP_SESSION_TOKEN
```

Loopback is resolved strictly: `localhost`, `::1`, and numeric `127.0.0.0/8` addresses. A name such as `127.a.b.c` counts as off loopback, so it triggers both the token requirement and the startup refusal.

To start a standalone session daemon reachable from another host:

```sh
omp-web session --cwd /path/to/worktree --host 0.0.0.0 --token "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
```

To register an already running remote session daemon with the fleet, pass its URL and token through the CLI:

```sh
omp-web add build-box ws://build-box.internal:4721 --token "$OMP_REMOTE_TOKEN" --cwd /srv/project
```

Expected result: the session daemon answers only with the exact token, and a tokenless start of an off-loopback session daemon exits 1 with the refusal above. A fleet-managed connection attaches the token automatically; for a direct browser URL you include `?token=<token>` yourself.

## Remote connectivity is dial-in

The fleet always opens the connection to the session daemon. Session daemons never dial out to the fleet and never learn the fleet's address, its state file, or any other session daemon's credentials. This holds for SSH, Docker, and custom provision providers:

- A remote or sandboxed environment needs no route back to the fleet and can deny outbound traffic entirely.
- The token minted for a session daemon gates only that session daemon. A sandbox that leaks it exposes one working directory, not the fleet.
- Endpoint URLs must be `ws://` or `wss://` (the transport underneath is plain HTTP SSE; the scheme is normalized). omp-web ships no TLS termination and no certificates, so if traffic crosses a network you do not trust, carry it inside SSH, a tailnet, or a TLS endpoint you operate. See [Run a session daemon over SSH](/advanced/ssh/) and [Run session daemons in Docker](/advanced/docker/).

## Spawn tokens are minted fresh

For session daemons the fleet starts, the supervisor mints a new bearer token for every spawn attempt: 32 random bytes, base64url encoded (43 characters). Restarts and respawns mint again, so the previous token dies with the old process.

- Persistence: the current token for each entry lives in the fleet state file, not in a keychain. Protect that file (see [Filesystem protection](#filesystem-protection)).
- Visibility on the host: the token is substituted into the spawn template command, so it is part of the spawned command line and is visible to process listings on the fleet host (and in container metadata such as `docker inspect`) for as long as the process runs. Anyone who can inspect processes or the container runtime on that host can read it.
- Rotation: stop a fleet-managed session daemon and wake it to mint a fresh token. For a standalone session daemon, restart it with a new `--token`. A remote registration that stored the old token keeps failing with 401 until you correct it, which is the intended fail-closed behavior.

## What the browser can and cannot see

Roster frames sent to the browser never contain bearer tokens, endpoints, or spawn templates. They do contain operational facts: session daemon IDs (`dN`), names, working directories, labels, status, git branch and dirty counts, session titles, last session file paths, PIDs, and error text. Treat all of that as sensitive; it describes your machine and your private code layout.

The Debug panel polls the loopback-only `/ctl/debug` route, which deliberately exposes endpoint URLs and ports and never serializes tokens. When you collect diagnostics, still remove anything you do not want to publish, as described in [Troubleshooting](/operations/troubleshooting/).

A direct browser connection carries the token in the page URL as `?token=<token>`; the client keeps it in page memory and forwards it to the stream and command endpoints. Tokens in URLs leak through browser history, terminal scrollback, logs, and screenshots, so prefer a forwarded loopback connection where no token is needed, and never share a link that contains one.

## Download and filesystem limits

`/download` is the only file egress path owned by omp-web, and it is jailed. The requested path is canonicalized with realpath on both sides, closing symlink escapes that a textual prefix check would miss, and the result must live inside one of:

- the system temp directory,
- the session daemon's bound working directory,
- the process working directory,
- or the directory of the live session file.

Anything else returns `Forbidden` (403); a missing or non-file target returns `Not found` (404). Relative export names resolve against the bound working directory first, then the process working directory. The file listing used by prompt autocomplete walks only the bound working directory and skips `.git` and `node_modules`.

This bounds omp-web's own egress. It does not sandbox the agent: the bash and python tools run with the access of the account that hosts the session daemon, and the approval dialogs are a UI affordance, not an operating-system boundary.

## Filesystem protection

The application writes state with your default umask, so file-level protection is your job. The files that matter:

| File | Contains |
| --- | --- |
| `<state dir>/fleet-state.json` (default `~/.omp-web/fleet-state.json`, override `OMP_FLEET_STATE`) | Bearer tokens for each session daemon, endpoints, working directories, session file paths, and roster metadata |
| `~/.omp-web/config.json` (override `OMP_FLEET_CONFIG`) | Spawn templates and the spawn hook, which the fleet executes through `sh -c` as your user; treat this file as code |
| Session transcripts under your Oh My Pi agent directory | Complete conversations, tool output, and anything the agent read |
| `stats.db` and related usage files | Token, cost, and error statistics for your sessions |
| Browser storage | Interface preferences and prompt history, which retains prompt text in the browser |

Recommended starting point on a single-user machine, once those files exist:

```sh
chmod 700 ~/.omp-web
chmod 600 ~/.omp-web/fleet-state.json ~/.omp-web/config.json
```

Then apply the same care to your Oh My Pi agent directory, which also holds provider credentials and transcripts. On a shared host, run omp-web under a dedicated account so transcripts and credentials are not readable by other users.

Lock files (`<statePath>.lock` and `<sessionFile>.lock`) protect state files and transcripts from concurrent writers. They are pidfile-based and self-healing when a holder dies, and they are not access control: never delete a lock held by a live process.

## Updates

`omp-web update` and the one-line installer both fetch a release manifest over HTTPS and compare the tarball's SHA-256 against it before installing. `omp-web update` verifies in memory, so unverified bytes never touch disk; the installer verifies the download in a temporary work directory, removes it on exit, and only then runs `bun add`. Either way a mismatch aborts with `sha256 mismatch` and installs nothing. The trust anchor is the release channel from which the manifest and tarball come, together: a mirror must serve the pair as one unit over transport you trust. See [Updates](/operations/updates/).

## Hardening checklist

1. Keep the fleet on loopback. Reach it with SSH forwarding or a tailnet, never with a raw port forward. Expected result: the banner shows `127.0.0.1` and remote `curl` against the host address is refused.
2. For any session daemon bound off loopback, pass `--token` or `OMP_SESSION_TOKEN` and put an encrypted, authenticated transport in front. Expected result: requests without the exact token return 401.
3. Keep one token per session daemon. Do not copy a token between session daemons or into shared shell profiles, and rotate by stopping and waking (or restarting) the session daemon.
4. Protect the fleet state file, the fleet config file, the Oh My Pi agent directory, and session transcripts with OS permissions.
5. Update from the official channel, and verify the reported version after updating.
6. Run untrusted repositories in a container or under a dedicated account, since the agent inherits your user's access wherever it runs.

## Common failures

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `Unauthorized` (HTTP 401) from a session daemon URL | The session daemon is off loopback and the token is missing, wrong, or stale | Add the exact `?token=`, or stop and wake a fleet-managed session daemon so a fresh token is minted |
| `refusing to bind non-loopback address ... without a token` | A standalone session daemon was started on a non-loopback host without a credential | Restart with `--token` or `OMP_SESSION_TOKEN` |
| `unauthorized (401): daemon rejected the token` in the fleet log | A stored remote registration no longer matches the session daemon | Update the registration token, or restart the session daemon with the known token |
| `Forbidden` (HTTP 403) on a download | The file is outside the download jail roots | Export from the session working directory, or place the file under the session working directory or the system temp directory |
| Browser through a tunnel shows the fleet as unreachable | The tunnel points at nothing or at the wrong port | Start `omp-web` and verify the forwarding target matches the banner port |

## Built in versus yours

Built into omp-web:

- Loopback binds for the fleet plane and, by default, for session daemons.
- A hard requirement for a bearer token on any off-loopback session daemon bind, enforced on every route.
- Fresh tokens for each spawned session daemon, with no token or endpoint serialization into browser frames.
- A realpath-jailed download path and a working-directory-scoped file listing.
- SHA-256 verification of update artifacts before installation, and fail-closed protocol and working-directory checks when attaching to a session daemon.

Left to you:

- Choosing and operating the transport for remote access (SSH, tailnet, or your own TLS), because omp-web provides none.
- Keeping the fleet port off non-loopback interfaces and protecting any tunnel you create.
- Permissions on state, configuration, transcripts, and the Oh My Pi agent directory.
- The trust you place in hosts, containers, and accounts where agents run, and in the update channel you use.

## Related

- [Networking and browser access](/operations/networking/)
- [Run a session daemon over SSH](/advanced/ssh/)
- [Run session daemons in Docker](/advanced/docker/)
- [Data and state management](/configuration/data-and-state/)
- [Files and directories](/reference/files/)
- [Updates](/operations/updates/)
- [Troubleshooting](/operations/troubleshooting/)
