---
title: Security model
description: Understand omp-web trust boundaries, what the application protects by default, and the transport, filesystem, and update duties that stay with the operator.
---

omp-web supervises agents that read files, run shell commands, and change your repositories. Its safety model has two halves: protections built into the fleet and the session daemon, and deployment decisions that only you can make. This page covers both and states plainly which is which.

## Before you start

- Know where the browser and the session daemons sit relative to the fleet: the browser talks only to the fleet, and every session daemon is either spawned by the fleet, run elsewhere and dialed in by it, or, for a managed clone workspace, run in a provider sandbox and dialed out to the fleet's callback pair.
- Know the machine and OS account that runs `omp-web`. Every session daemon it spawns outside a provider sandbox runs as that account with that account's filesystem access, including access to provider credentials and SSH keys. A managed clone workspace's daemon runs inside its sandbox instead, with only the mounts the sandbox allowlist gives it.
- The exact commands for starting the fleet and session daemons and connecting a browser live in [Networking and browser access](/operations/networking/); this page explains what those settings protect.

## Trust boundaries

| Boundary | What sits behind it | Protected by |
| --- | --- | --- |
| Browser client | Prompting, dialogs, settings, roster control | Same-origin access to the fleet edge; with browser auth enabled it holds one opaque `omp_session` cookie, and the access token is posted once at login and never persisted |
| Fleet edge and control plane | The browser API plus project, spawn, worktree, and clone control | A loopback bind by default; off loopback, browser auth: a live session for reads, plus the CSRF header and an allowed origin for mutations; a non-loopback bind without browser auth is a startup error |
| Local session daemon | The agent surface: prompts, bash, python, file listing, session export | Loopback by default; a bearer token once bound off loopback |
| Remote session daemon | The same agent surface on another host or in a container | The bearer token on every off-loopback route, plus the transport you choose |
| Managed clone workspace | The same agent surface inside a provider sandbox (bwrap or Kubernetes) | Workspace-scoped enrollment credentials on the outbound callback pair; an allowlist-built sandbox with no operator credentials mounted |
| Model provider | Conversation content and tool output sent to the provider | Your provider account and the session daemon's network egress |
| On-disk state | Tokens, transcripts, statistics, configuration | Operating-system file permissions |

The critical consequence: anyone who can reach one of these planes can drive an agent. A user who reaches the fleet port can register projects, spawn session daemons, and send prompts; that is true by default because loopback peers are exempt from every credential check, and it is the reason a non-loopback bind requires browser auth. With browser auth enabled, an off-loopback client also needs a live browser session, and a mutation needs the CSRF header and an allowed origin. A user who reaches a session daemon with a valid token can run bash and python in the session daemon's working directory. Treat access to either plane like shell access to the host.

omp-web assumes a single operator. It has no user accounts and no multi-user mode: browser auth is one operator access token, not an identity system. There is no browser collaboration surface, and omp-web does not terminate TLS for you.

## The fleet plane: loopback by default, browser auth off loopback

The fleet binds its browser edge and control API to `127.0.0.1` by default. It prints this on startup:

```text
fleet listening on 127.0.0.1:4722
Web UI: http://localhost:4722
```

- The port comes from `--port`, then `OMP_FLEET_PORT`, then the default `4722`. The bind address resolves `--bind`, then `OMP_FLEET_BIND`, then the config-file `bind` key, then `127.0.0.1`.
- With the default loopback bind there is no credential check on this plane. The browser API, the `/ctl` routes the CLI uses, and the streaming endpoints share one server, and loopback peers are exempt, so `curl` and the CLI work without a token.
- Reaching the fleet from another machine without changing the bind still means tunneling to loopback. Use SSH local forwarding (`ssh -L 4722:127.0.0.1:4722 <host>`) or a tailnet that authenticates devices, and treat the tunnel itself as the login. Never port-forward the fleet port to a public or shared interface while browser auth is disabled, because anything that reaches it has full agent control without a credential.
- Binding off loopback is supported and requires browser auth. A non-loopback bind with no operator access token is a startup error:

```text
refusing to bind non-loopback address "0.0.0.0" without browser auth; set OMP_FLEET_BROWSER_TOKEN (or --browser-access-token / config browserAccessToken)
```

The operator access token comes from `--browser-access-token`, then `OMP_FLEET_BROWSER_TOKEN`, then the config key `browserAccessToken`, which is a pre-hashed 64-character sha-256 digest. Only the digest is stored; the plaintext never outlives the load. With a token configured, the server additionally mounts `POST /auth/login` (access token in, session cookie out), `POST /auth/logout`, and `GET /auth/session`, and a non-loopback client must hold a live session for `/events`, `/command`, and `/ctl/*`. Mutations also need the `X-Omp-Csrf` header and an `Origin` on the allowlist: the configured `browserOrigin` plus the loopback-dev exception. Forwarded headers are honored only when the direct peer matches `trustedProxies` (`--trusted-proxy`, `OMP_FLEET_TRUSTED_PROXY`, config key `trustedProxies`), whose first `X-Forwarded-For` hop then becomes the client address; a loopback peer that carries forwarded headers is treated as an undeclared proxy and resolves as a remote client, which fails closed. The full login, session, and rotation story is in [Browser auth](/operations/browser-auth/).

Expected result: with the fleet on its default bind, `curl -s http://127.0.0.1:4722/ctl/sessions` answers, and the same command against your machine's external address is refused. With a non-loopback bind and browser auth enabled, a request without a session cookie answers `401 Unauthorized`.

## Authorizing a session daemon

A session daemon binds `127.0.0.1` by default and is exempt from token checks for loopback peers. Once it is bound off loopback, every route requires the bearer token:

- `GET /events`, `POST /command`, and the collab host upgrade accept `Authorization: Bearer <token>` or `?token=<token>`.
- `/download` requires the token too when the session daemon carries one.
- A missing or wrong credential returns HTTP 401 before any protocol exchange. The scheme is matched case-insensitively, but the token value is compared exactly, so a wrong-case token is rejected.
- Binding a non-loopback address without a token is a startup error:

```text
omp-session: refusing to bind non-loopback address "0.0.0.0" without a token; pass --token or set OMP_SESSION_TOKEN
```

Loopback is resolved strictly: `localhost`, `::1`, and numeric `127.0.0.0/8` addresses. A name such as `127.a.b.c` counts as off loopback, so it triggers both the token requirement and the startup refusal.

To start a session daemon reachable from another host, for the fleet to dial in:

```sh
omp-web session --cwd /path/to/worktree --host 0.0.0.0 --token "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
```

To register an already running remote session daemon with the fleet, pass its URL and token through the CLI:

```sh
omp-web add build-box ws://build-box.internal:4721 --token "$OMP_REMOTE_TOKEN" --cwd /srv/project
```

Expected result: the session daemon answers only with the exact token, and a tokenless start of an off-loopback session daemon exits 1 with the refusal above. A fleet-managed connection attaches the token automatically; a direct API client supplies the token itself.

## Remote connectivity is dial-in

The fleet opens the connection to each direct and worktree session daemon, locally or over an SSH or custom provision provider. Those session daemons never dial out to the fleet and never learn the fleet's address, its state file, or any other session daemon's credentials. Managed clone workspaces are the deliberate exception: their daemons have no inbound service at all and dial the fleet's callback pair outbound, authenticating with workspace-scoped enrollment credentials (256-bit, stored only as sha-256 digests) plus workspace, generation, and connection headers. The callback pair is HTTPS-only except the explicit loopback-HTTP developer exception, and credentials never ride URL paths or query strings.

- A remote environment needs no route back to the fleet and can deny inbound traffic entirely. A clone sandbox does need outbound reachability to the fleet's callback URL; `omp-web preflight --profile <id>` checks that reachability class (DNS plus TCP) for you.
- The token minted for a session daemon gates only that session daemon. A sandbox that leaks it exposes one working directory, not the fleet.
- Endpoint URLs must be `ws://` or `wss://` (the transport underneath is plain HTTP SSE; the scheme is normalized). omp-web ships no TLS termination and no certificates, so if traffic crosses a network you do not trust, carry it inside SSH, a tailnet, or a TLS endpoint you operate. See [Run a session daemon over SSH](/advanced/ssh/).

## Spawn tokens are minted fresh

For session daemons the fleet starts, the supervisor mints a new bearer token for every spawn attempt: 32 random bytes, base64url encoded (43 characters). Restarts and respawns mint again, so the previous token dies with the old process.

- Persistence: the current token for each entry lives in the fleet state file, not in a keychain. Protect that file (see [Filesystem protection](#filesystem-protection)).
- Visibility on the host: the token is substituted into the spawn template command, so it is part of the spawned command line and is visible to process listings on the fleet host for as long as the process runs. Anyone who can inspect processes on that host can read it.
- Rotation: stop a fleet-managed session daemon and wake it to mint a fresh token. For a session daemon you run by hand, restart it with a new `--token`. A remote registration that stored the old token keeps failing with 401 until you correct it, which is the intended fail-closed behavior.

## What the browser can and cannot see

Roster frames sent to the browser never contain bearer tokens, endpoints, or spawn templates. They do contain operational facts: session daemon IDs (`dN`), names, working directories, labels, status, git branch and dirty counts, session titles, last session file paths, PIDs, and error text. Treat all of that as sensitive; it describes your machine and your private code layout.

The Debug panel polls the `/ctl/debug` route, which deliberately exposes endpoint URLs and ports and never serializes tokens. A non-loopback client needs a browser session to read it, exactly like every other `/ctl` route, but the payload is still operational detail rather than a credential. When you collect diagnostics, still remove anything you do not want to publish, as described in [Troubleshooting](/operations/troubleshooting/).

The browser never receives a session daemon's token: the fleet attaches that token when it proxies the browser's stream and commands. What the browser can hold is its own login artifact: with browser auth enabled, an opaque `omp_session` cookie (HttpOnly, `SameSite=Lax`, 30-day absolute lifetime) plus an in-memory CSRF token for mutation headers. The operator access token is posted once to `/auth/login` and never persisted, so nothing recoverable sits in `localStorage` or in a URL. Session daemon tokens still travel in URLs elsewhere, for example a direct API client passing `?token=<token>` or an `omp-web add` registration; URLs leak through browser history, terminal scrollback, logs, and screenshots, so prefer the `Authorization` header where the client supports it, and never share a link that contains a token.

## Download and filesystem limits

`/download` is the only file egress path owned by omp-web, and it is jailed. The requested path is canonicalized with realpath on both sides, closing symlink escapes that a textual prefix check would miss, and the result must live inside one of:

- the system temp directory,
- the session daemon's bound working directory,
- the process working directory,
- or the directory of the live session file.

Anything else returns `Forbidden` (403); a missing or non-file target returns `Not found` (404). Relative export names resolve against the bound working directory first, then the process working directory. The file listing used by prompt autocomplete walks only the bound working directory and skips `.git` and `node_modules`.

This bounds omp-web's own egress for local and remote session daemons. It does not sandbox their agent: the bash and python tools run with the access of the account that hosts the session daemon, and the approval dialogs are a UI affordance, not an operating-system boundary. Managed clone workspaces are the scoped exception: their daemon runs in a bwrap or Kubernetes sandbox built by allowlist, seeded with a private home, and operator credentials, the SSH agent, and container sockets are never mountable into it. The limits are honest ones: both sandboxes share the host kernel, and model and tool credentials reach the sandbox as environment values a sandboxed process can read. See [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## Filesystem protection

The application writes state with your default umask, so file-level protection is your job. The files that matter:

| File | Contains |
| --- | --- |
| `<state dir>/fleet-state.json` (default `~/.omp-web/fleet-state.json`, override `OMP_FLEET_STATE`) | Bearer tokens for each session daemon, endpoints, working directories, session file paths, and roster metadata, plus the fleet-private workspace records for clone entries |
| `<state dir>/browser-auth.json` (next to the state file) | The sha-256 digest of the operator access token and the per-session records; written 0600, fail-closed on corruption |
| `<state dir>/logs/` | The fleet log store: a durable mirror of the lineage transcripts streamed by managed daemons over the callback pair. Verified history is never deleted internally |
| `~/.omp-web/config.json` (override `OMP_FLEET_CONFIG`) | Spawn templates, provider profiles, browser auth settings, and trusted proxies, plus the spawn hook, which the fleet executes through `sh -c` as your user; treat this file as code |
| Session transcripts under your Oh My Pi agent directory | Complete conversations, tool output, and anything the agent read |
| `stats.db` and related usage files | Token, cost, and error statistics for your sessions |
| Browser storage | Interface preferences and prompt history, which retains prompt text in the browser |

Recommended starting point on a single-user machine, once those files exist:

```sh
chmod 700 ~/.omp-web
chmod 600 ~/.omp-web/fleet-state.json ~/.omp-web/config.json ~/.omp-web/browser-auth.json
```

Then apply the same care to your Oh My Pi agent directory, which also holds provider credentials and transcripts. On a shared host, run omp-web under a dedicated account so transcripts and credentials are not readable by other users.

Lock files (`<statePath>.lock` and `<sessionFile>.lock`) protect state files and transcripts from concurrent writers. They are pidfile-based and self-healing when a holder dies, and they are not access control: never delete a lock held by a live process.

## Updates

`omp-web update` and the one-line installer both fetch a release manifest over HTTPS and compare the tarball's SHA-256 against it before installing. `omp-web update` verifies in memory, so unverified bytes never touch disk; the installer verifies the download in a temporary work directory, removes it on exit, and only then runs `bun add`. Either way a mismatch aborts with `sha256 mismatch` and installs nothing. The trust anchor is the release channel from which the manifest and tarball come, together: a mirror must serve the pair as one unit over transport you trust. See [Updates](/operations/updates/).

## Hardening checklist

1. Keep the fleet on loopback unless you need a non-loopback bind. Reach it with SSH forwarding or a tailnet, never with a raw port forward. If you do bind off loopback, configure browser auth first and put an authenticated transport in front. Expected result: the banner shows the bound address, remote `curl` against a loopback bind is refused, and a non-loopback bind without browser auth exits 1 with the refusal message.
2. For any session daemon bound off loopback, pass `--token` or `OMP_SESSION_TOKEN` and put an encrypted, authenticated transport in front. Expected result: requests without the exact token return 401.
3. Keep one token per session daemon. Do not copy a token between session daemons or into shared shell profiles, and rotate by stopping and waking (or restarting) the session daemon.
4. Protect the fleet state file, the browser-auth store, the fleet config file, the Oh My Pi agent directory, and session transcripts with OS permissions.
5. Update from the official channel, and verify the reported version after updating.
6. Run untrusted repositories in a container, under a dedicated account, or in a managed clone workspace whose daemon runs in a provider sandbox. Where an agent runs without a sandbox it inherits your user's access; where it runs in one, remember that the isolation is shared-kernel, not a confidentiality boundary.

## Common failures

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `Unauthorized` (HTTP 401) from a session daemon URL | The session daemon is off loopback and the token is missing, wrong, or stale | Supply the exact `Authorization: Bearer` header or `?token=`, or stop and wake a fleet-managed session daemon so a fresh token is minted |
| `refusing to bind non-loopback address ... without a token` | A session daemon was started on a non-loopback host without a credential | Restart it with `--token` or `OMP_SESSION_TOKEN` |
| `refusing to bind non-loopback address ... without browser auth` at fleet startup | The fleet was told to bind an off-loopback address with no operator access token configured | Set `--browser-access-token`, `OMP_FLEET_BROWSER_TOKEN`, or the config `browserAccessToken` digest (hash your token once), or bind loopback |
| `unauthorized` (HTTP 401) from the fleet at a non-loopback address | The browser session is missing, expired, or was revoked by a rotation | Sign in again at the fleet's login surface; rotating the operator token revokes every live session, so all devices must sign in again |
| `forbidden` (HTTP 403) on a browser mutation | The request lacks the `X-Omp-Csrf` header, or its `Origin` is not on the allowlist | Reach the fleet through the origin configured in `browserOrigin`, and keep the reverse proxy listed in `trustedProxies` so the client address and scheme resolve correctly |
| `unauthorized (401): daemon rejected the token` in the fleet log | A stored remote registration no longer matches the session daemon | Update the registration token, or restart the session daemon with the known token |
| `Forbidden` (HTTP 403) on the download route | The file is outside the download jail roots | Export from the session working directory, or place the file under the session working directory or the system temp directory |
| Browser through a tunnel shows the fleet as unreachable | The tunnel points at nothing or at the wrong port | Start `omp-web` and verify the forwarding target matches the banner port |

## Built in versus yours

Built into omp-web:

- Loopback binds for the fleet plane by default and for session daemons, with an off-loopback fleet bind refused unless browser auth is configured.
- Browser auth for off-loopback access: one operator access token kept only as a sha-256 digest, an opaque session cookie, CSRF and origin checks on mutations, and trusted-proxy-aware client resolution.
- A hard requirement for a bearer token on any off-loopback session daemon bind, enforced on every route.
- Fresh tokens for each spawned session daemon, with no token or endpoint serialization into browser frames.
- Allowlist-built bwrap or Kubernetes sandboxes for managed clone workspaces, with operator credentials, the SSH agent, and container sockets unmountable.
- A realpath-jailed download path and a working-directory-scoped file listing.
- SHA-256 verification of update artifacts before installation, and fail-closed protocol and working-directory checks when attaching to a session daemon.

Left to you:

- Choosing and operating the transport for remote access (SSH, tailnet, or your own TLS), because omp-web provides none.
- Deciding where the fleet binds, configuring browser auth whenever it binds off loopback, and protecting the tunnel or proxy in front.
- Access control for a loopback-bound fleet with browser auth disabled: loopback peers are exempt from every credential check, so whoever can reach the port can drive the fleet.
- Permissions on state, configuration, transcripts, and the Oh My Pi agent directory.
- The trust you place in hosts, containers, and accounts where agents run, and in the update channel you use.

## Related

- [Browser auth](/operations/browser-auth/): the login surface, sessions, and rotation.
- [Networking and browser access](/operations/networking/)
- [Run a session daemon over SSH](/advanced/ssh/)
- [Clone workspaces](/fleet/clone-workspaces/): provider-managed sandboxed sessions.
- [Sandboxed session runtime](/advanced/sandbox-runtimes/): bwrap and Kubernetes isolation, and its limits.
- [Data and state management](/configuration/data-and-state/)
- [Files and directories](/reference/files/)
- [Updates](/operations/updates/)
- [Troubleshooting](/operations/troubleshooting/)
