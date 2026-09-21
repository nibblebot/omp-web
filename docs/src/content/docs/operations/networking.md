---
title: Networking and browser access
description: Where omp-web binds by default, how to reach the browser UI from another device over SSH, a tailnet, or your own TLS proxy, how host, port, and advertise decide where a session daemon is dialed, and how to diagnose reachability and authorization failures.
---

omp-web listens on loopback by default. The fleet serves the browser UI, the streaming wire API, and its control plane on one loopback port, while a session daemon serves the wire API only on another. The fleet can also bind a different address when browser auth is configured. This page covers that default layout, the ways to reach it from another device, the host, port, and advertise settings that decide where a session daemon can be dialed, and the failures that appear when a route or a credential is wrong.

## Default network layout

| Listener | Default address | Who connects |
| --- | --- | --- |
| Fleet: browser UI, `/events`, `/command`, `/ctl` | `127.0.0.1:4722` | Your browser and the `omp-web` CLI |
| Session daemon: wire API only, no UI | `127.0.0.1:4721` when started by hand; the fleet spawns with `--port 0` and dials the reported port | The fleet, or another direct API client |
| Fleet callback pair (`/callback/*`) | On the fleet's own bind and port | Managed clone daemons, dialing outbound from their sandbox |
| Vite dev server (source checkouts only) | `127.0.0.1:4713` default; the dev runners pick per run | Your browser while running `bun run dev` |

Three properties define the layout:

- **The fleet binds loopback by default, and can bind elsewhere with browser auth.** The browser UI, the `/events` and `/command` endpoints the UI uses, and the `/ctl` routes the CLI uses share one server. The port resolves `--port`, then `OMP_FLEET_PORT`, then the default `4722`. The bind address resolves `--bind`, then `OMP_FLEET_BIND`, then the config-file `bind` key, then `127.0.0.1`. A non-loopback bind without an operator access token is a startup error, and with one configured every non-loopback client needs a browser session. See [Browser auth](/operations/browser-auth/).
- **A session daemon binds `127.0.0.1` by default and may bind elsewhere.** Off loopback it requires a bearer token, and the agent-driving routes check it. See [Security model](/operations/security/) for token minting, storage, and rotation.
- **Browser traffic is same-origin.** The fleet serves the page, `/events`, `/command`, and `/ctl` from one process. omp-web sends no CORS headers, so a page served from one origin cannot call the wire API on another. The session daemon's `/download` route is not proxied by the fleet, so the browser never reaches it.

Connections between the fleet and direct or worktree session daemons are dial-in: the fleet opens the connection, and those daemons never dial out, never learn the fleet's address or state, and need no route back to the fleet. Managed clone workspaces are the deliberate exception: a clone daemon has no inbound service and dials the fleet's callback pair outbound with workspace-scoped enrollment credentials, which is why the callback pair is listed above. See [Clone workspaces](/fleet/clone-workspaces/).

## Run on loopback (the default)

Prerequisites: omp-web installed, and the `omp` CLI with at least one authenticated provider and a default model if you intend to prompt. See [Installation](/getting-started/installation/).

Start the fleet with a bare `omp-web`, or name the command to change the port:

```sh
omp-web                 # fleet UI and control plane on 127.0.0.1:4722
omp-web serve --port 8080
```

Expected result: the banner names the loopback address it bound, the state and config paths, and the UI URL on the same port:

```text
fleet listening on 127.0.0.1:4722
Web UI: http://localhost:4722
```

Open the printed URL and the roster loads with no credential prompt: loopback peers are exempt from the browser-session check, and browser auth is off entirely unless you configure an operator access token. `omp-web --version` is entirely local; every other subcommand talks to the control plane at `http://127.0.0.1:<port>`, so pass the same `--port` when you changed it.

To run a session daemon by hand, for example on a remote host the fleet will dial in:

```sh
omp-web session --cwd /path/to/project
```

Expected result: the session daemon prints `omp-session listening on http://localhost:4721` to stderr and reserves stdout for its machine-readable `OMP_SESSION|` line. It serves the wire API only, with no browser UI; register it with the fleet as described under [Register an already running session daemon](#register-an-already-running-session-daemon) and browse through the fleet.

Safety and persistence in this layout:

- Nothing is reachable from outside the machine, and loopback peers are exempt from the session daemon's bearer check and the fleet's browser-session check, so no token or login is needed for local API calls and local browser use.
- Ports are routing, not storage. Changing a port does not move the fleet state file, config, managed worktrees, clone workspaces, or session transcripts. Each roster entry records an endpoint: a fleet-spawned row is resolved again from the child's next listening line, while a registered remote entry keeps the endpoint you registered until you re-register it.
- Starting a second process on a fixed port that is already held fails at startup with `Error: Failed to start server. Is port <n> in use?` and exits 1. Either stop the holder, pass a different `--port`, or pass `--port 0` to let the kernel pick an ephemeral port; the fleet banner, and for a session daemon the `OMP_SESSION|` line, report the real port.

## Reach the browser UI from another device

Prerequisites: the machine running omp-web is reachable from the device you browse from, and you can authenticate to it (SSH, tailnet membership, browser auth, or a proxy you operate). There are two supported shapes: keep the fleet on loopback and put a loopback path in front of it, where the tunnel or proxy is the only access control, or bind the fleet off loopback with browser auth configured and terminate TLS in front of it.

### Why direct access does not just work

- A default fleet refuses connections on anything but loopback, so browsing to the host's LAN, tailnet, or public address does not reach it at all. Moving the bind off loopback is possible, but only together with browser auth: a non-loopback bind without an operator access token is a startup error.
- A session daemon can be bound off loopback, but that is a dial-in surface for the fleet and other API clients, not a browser exposure path: the daemon serves no UI, and every wire API request needs the bearer token.

### SSH local forward

Forward the loopback port to the device with the browser:

```sh
ssh -N -L 4722:127.0.0.1:4722 user@fleet-host     # browse http://localhost:4722
```

`-N` opens no remote command, so the connection exists only as the forward. Expected result: the same URLs as local use work unchanged, because the forwarded connection arrives at the server from `127.0.0.1` and is treated as loopback.

### Tailnet

Keep the server on loopback and publish that loopback port to the tailnet from the host itself, with a local terminator such as `tailscale serve`:

```sh
tailscale serve --bg 4722     # publish the loopback fleet port on the tailnet with managed TLS
```

Expected result: any device in the tailnet opens the tailnet HTTPS URL and reaches the fleet. The terminator dials `127.0.0.1` from the host, so the fleet still sees a loopback peer, device identity and transport encryption come from the tailnet, and neither a session daemon token nor a browser login is involved. You can also bind the fleet to the tailnet address directly when browser auth is configured, in which case tailnet devices sign in at the fleet's login surface; terminating on the host keeps the fleet loopback-only.

### Your own TLS proxy

omp-web does not terminate TLS for the browser edge and ships no certificates for it. To expose the UI over HTTPS, run a reverse proxy on the same host as the fleet, terminate TLS there, and forward every path to the fleet's bind and port. Requirements that come from the wire protocol:

- **Do not buffer responses.** `/events` is a long-lived SSE stream. The server marks its responses `x-accel-buffering: no` (honored by nginx) and sends an `event: ping` keepalive every 15 seconds. A proxy that accumulates the response or caches it stalls the UI.
- **Do not time out long-lived connections.** A client that sees no event or comment for 30 seconds treats the stream as dead and redials. Keep proxy read timeouts above the keepalive cadence, and do not enable response compression on the stream.
- **Forward the whole origin.** The page, `/events`, `/command`, and `/ctl` must reach the same server; splitting them across origins fails because there are no CORS headers.
- **Declare the proxy and the public origin if you forward client headers.** When the proxy adds `X-Forwarded-For` or `X-Forwarded-Proto`, list its address in `trustedProxies` (`--trusted-proxy 127.0.0.1`, `OMP_FLEET_TRUSTED_PROXY`, or the config key) so the fleet honors those headers; a loopback peer that carries forwarded headers without being listed is treated as an undeclared proxy and resolves its clients as remote, which fails closed. Set `browserOrigin` to the public origin you serve so browser mutations pass the origin check.

Minimal nginx shape (certificates, access control, and any authentication in front are yours to configure):

```nginx
server {
	listen 443 ssl;
	server_name omp.example.com;

	location / {
		proxy_pass http://127.0.0.1:4722;   # the fleet edge
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_buffering off;
		proxy_read_timeout 3600s;
	}
}
```

Two access-control shapes follow from this:

- **No forwarded headers.** The proxy is a plain loopback client, so the fleet sees a loopback peer and no browser login is required even when browser auth is enabled. The proxy is then the only access control: anyone who can reach it can drive the fleet and every attached session daemon.
- **Forwarded headers, proxy listed in `trustedProxies`.** The fleet resolves each real client address, so off-loopback clients need a browser login: configure the operator access token and `browserOrigin` for the public origin. Loopback clients keep the exemption, and the proxy's own TLS and reach rules sit in front. Prefer this shape when the port can be reached from outside the machine. One caveat: when the fleet's own bind is loopback, the session cookie is issued without the `Secure` flag (the loopback-dev exception), so the browser-to-proxy leg relies on the proxy's TLS while the fleet sees plain HTTP on its side.

### Development-only LAN access

When running from a source checkout, the dev runner can expose only the Vite dev server, leaving the fleet on loopback. Vite proxies `/events`, `/command`, and `/ctl` to the fleet edge server-side:

```sh
bun scripts/dev.ts fleet --host                                  # Vite binds 0.0.0.0; the fleet stays loopback
bun scripts/dev.ts fleet --host --allow-hosts my-box.tailnet.ts.net
```

- `--host` with no address binds `0.0.0.0`; pass an address to bind a specific interface.
- The dev runner picks Vite's port per run (the fleet binds an ephemeral port), so read the actual URL from the `stack ready` summary.
- `--allow-hosts` sets Vite's allowed-host list (`*` allows every `Host` header, otherwise a comma-separated list). Unset, Vite's own default applies (localhost and `.local` names); a request with a Host outside the list is refused with Vite's blocked-request message.
- The dev server has no authentication. Anyone who can reach it can control agents, so use it on trusted networks only, and stop the runner when you are done.

## Host, port, and advertise behavior

### Session daemon

| Flag | Environment | Default | Effect |
| --- | --- | --- | --- |
| `--host` | `OMP_SESSION_HOST` | `127.0.0.1` | Bind address. Anything off loopback requires a token. |
| `--port` | `OMP_SESSION_PORT` | `4721` | Listen port. `0` asks for an ephemeral port. |
| `--token` | `OMP_SESSION_TOKEN` | none | Bearer token for every off-loopback request. |
| `--advertise` | `OMP_SESSION_ADVERTISE` | none | Reachable URL to report to a spawner. Does not change the bind. |
| `--idle-timeout` | `OMP_SESSION_IDLE_TIMEOUT` | `30m` | Idle auto-exit; `0` disables it. |

Loopback is resolved strictly: `localhost`, `::1`, and numeric `127.0.0.0/8` addresses. A name such as `127.a.b.c` resolves off loopback and triggers the token requirement. Binding a non-loopback address without a token is a startup error and exits 1:

```text
omp-session: refusing to bind non-loopback address "0.0.0.0" without a token; pass --token or set OMP_SESSION_TOKEN
```

`--advertise` covers the case where the bind address is not the address a fleet can dial, for example a session daemon behind a tunnel or a port mapping. The value is reported verbatim as the `advertise` field of the `OMP_SESSION|` listening line and must itself be a `ws://` or `wss://` URL; a value that is not makes the whole listening line unparseable, which surfaces as the spawn timeout below.

```sh
omp-web session --cwd /srv/project --host 0.0.0.0 \
  --token "$TOKEN" --advertise ws://build-box.internal:4721
```

### Fleet

| Flag | Environment | Default | Effect |
| --- | --- | --- | --- |
| `--port` | `OMP_FLEET_PORT` | `4722` | Listen port for the control plane and browser edge. `0` asks for an ephemeral port. |
| `--bind` | `OMP_FLEET_BIND` | `127.0.0.1` | Bind address. A non-loopback address requires browser auth or the fleet refuses to start. The config-file `bind` key sits below env, and the flag wins over both. |
| `--browser-access-token` | `OMP_FLEET_BROWSER_TOKEN` | none | Operator access token for browser auth; only its sha-256 digest is kept. The config-file `browserAccessToken` key must hold the pre-hashed digest. |
| `--browser-origin` | `OMP_FLEET_BROWSER_ORIGIN` | none | Public browser origin admitted for mutations, alongside the loopback-dev exception. |
| `--trusted-proxy` | `OMP_FLEET_TRUSTED_PROXY` (csv) | none | Reverse proxies whose `X-Forwarded-For` / `X-Forwarded-Proto` headers are honored. Repeatable, and each value may itself be a comma-separated list. Malformed literals are a hard load error. The config-file `trustedProxies` key sits below env. |

A non-loopback bind without an operator access token exits 1 before the banner:

```text
refusing to bind non-loopback address "0.0.0.0" without browser auth; set OMP_FLEET_BROWSER_TOKEN (or --browser-access-token / config browserAccessToken)
```

The CLI reaches the control plane at `http://127.0.0.1:<port>` with no host flag of its own, so every `omp-web` subcommand must use the same port the fleet is listening on and the bind must include loopback (the default, or `0.0.0.0`). A fleet bound only to a specific off-loopback literal address answers the CLI with `fleet not running`, even though remote browsers can still reach it.

### How a spawned session daemon's endpoint is resolved

For a session daemon the fleet starts from a spawn template, the reachable endpoint is resolved from the child's stdout in this order, first match wins:

1. an `endpoint` line printed by a wrapper (for example a container script that publishes a random host port),
2. the template's `host` plus the port from the session daemon's `listening` line,
3. the `advertise` URL from the `listening` line,
4. loopback `ws://127.0.0.1:<port>`.

If no usable `listening` line appears within 30 seconds, the spawn fails with `endpoint timeout: no OMP_SESSION| listening line within 30s` and the child is killed. If the resolved URL is not a `ws://` or `wss://` URL, the spawn fails with `invalid endpoint from child: <url>`.

The remote template shapes combine these pieces: an SSH template sets the template `host` to the SSH target and starts the session daemon with `--host 0.0.0.0 --token {token}`, while a wrapper can publish a port and print an `endpoint` line for it. See [Run a session daemon over SSH](/advanced/ssh/).

### Register an already running session daemon

`omp-web add` registers a session daemon the fleet did not start, including one on another host:

```sh
omp-web add build-box ws://build-box.internal:4721 --token "$TOKEN" --cwd /srv/project
```

- The URL must be `ws://` or `wss://`. Anything else is refused with `url must be ws:// or wss://: <url>` (HTTP 400). A `wss://` URL is dialed as HTTPS.
- `--cwd` is optional. When set, the directory the session daemon reports during the handshake must match it or the row fails with `cwd mismatch: omp-session reports <reported>, registered <registered>`. When omitted, the fleet adopts the directory the session daemon reports.
- The entry stores the endpoint and the token you pass, and the fleet dials that endpoint for as long as the entry exists. The remote session daemon must be reachable from the fleet host at that URL; nothing is probed or tunneled for you.
- To point an existing entry at a new endpoint or a rotated token, remove it and register it again (`omp-web remove <selector>`, then `omp-web add ...`). Fleet-spawned rows get a fresh token on every spawn and never need this.

## Connection liveness

- The browser holds one SSE stream to the fleet. Every stream receives an `event: ping` keepalive every 15 seconds.
- A fleet-side connection that sees no event or comment for 30 seconds treats the peer as dead, aborts the stream, and redials with jittered exponential backoff (1 second up to 30 seconds), resuming from the last event id so no frames are lost. Browser reconnection follows the same pattern. See [Process lifecycle and recovery](/operations/lifecycle-and-recovery/) for what the statuses mean while this happens.
- A slow consumer is cut loose with a `stream_reset` frame once its queue passes 4 MiB and reconnects with replay; a reset is not a session daemon crash.
- A session daemon exits after its idle timeout (30 minutes by default) once nothing needs it. While a browser is attached, the fleet keeps a stream open to each ready session daemon, which suspends that auto-exit; when the last browser detaches, unused streams close so the session daemons can sleep again. Session transcripts are durable JSONL files, so sleeping, disconnecting, and reattaching never lose a conversation.

## Common reachability and authorization failures

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `Unauthorized` (HTTP 401) on an off-loopback session daemon URL | The request has no bearer token, or the token is wrong. | Add the exact `?token=`, or reach the session daemon through the fleet instead |
| `refusing to bind non-loopback address "<host>" without a token` | A session daemon was started off loopback with no credential. | Restart it with `--token` or `OMP_SESSION_TOKEN`. |
| `refusing to bind non-loopback address "<bind>" without browser auth` at fleet startup | The fleet was told to bind an off-loopback address with no operator access token configured. | Set `--browser-access-token`, `OMP_FLEET_BROWSER_TOKEN`, or the config `browserAccessToken` digest, or keep the loopback bind. |
| Remote `curl http://<host>:4722` is refused, and no other device can open the fleet URL | The fleet is on its default loopback bind. | Forward the loopback port (`ssh -L 4722:127.0.0.1:4722 user@host`) or publish it on a tailnet from the host. Only bind off loopback with browser auth configured. |
| Browser at a non-loopback address gets `unauthorized` (HTTP 401) | Browser auth is enabled and the browser has no live session, or the session expired or was revoked. | Sign in with the operator access token; rotating the token revokes every session. See [Browser auth](/operations/browser-auth/). |
| A browser mutation gets `forbidden` (HTTP 403) | The request lacks `X-Omp-Csrf`, or its `Origin` is not the configured `browserOrigin` (or a loopback origin under the loopback-dev exception). | Serve the UI from the configured origin, and make sure the request carries the session's CSRF header. |
| Browsers behind a reverse proxy are asked to log in, or mutations keep failing after login | The proxy forwards client headers without being listed, so its clients resolve as remote; or it is listed but `browserOrigin` is unset, so `Origin` never matches. | Add the proxy to `trustedProxies` and set `browserOrigin` to the public origin. |
| Spawn ends in `endpoint timeout` with no listening line | A spawned child never produced a parseable `OMP_SESSION` listening line: the command failed, the remote binary or SSH path is wrong, or `--advertise` is not a `ws://`/`wss://` URL so the line was discarded. | Read the child's stderr in the Debug panel, verify the template command runs by hand, and check the advertise value. See [Debug panel and diagnostics](/operations/diagnostics/). |
| `invalid endpoint from child: <url>` | The resolved endpoint is not a `ws://` or `wss://` URL, usually a malformed template `host`. | Fix the template `host` in the fleet config. |
| `unauthorized (401): daemon rejected the token` | The stored token no longer matches the session daemon, for example after a restart with a new token. | Stop and wake a fleet-spawned row so a fresh token is minted, or remove and re-add a remote registration with the current token. |
| `cwd mismatch: omp-session reports <reported>, registered <registered>` | A registered entry's `--cwd` differs from the directory the session daemon is bound to. | Re-add the entry with the correct `--cwd`, or omit it so the reported directory is adopted. |
| `proto mismatch: daemon speaks OMP_PROTO <n>, expected <n>` | The fleet and the session daemon come from different builds. | Update and restart both sides; see [Updates](/operations/updates/). |
| The UI stalls or a row flips to `reconnecting` behind a proxy | The proxy buffers SSE responses or times out long-lived requests. | Disable response buffering for the proxied origin and raise read timeouts above the 15 second keepalive cadence. |
| A curl request with the token succeeds but the browser keeps reconnecting | The page is served from a different origin than the wire API. | Serve the page and the API from one origin; omp-web sends no CORS headers. |
| The dev server refuses a LAN or tailnet hostname | Vite's host check rejected the `Host` header. | Pass `--allow-hosts <host>` to the dev runner. |

## What omp-web enforces, and what stays yours

Enforced by the application:

- The fleet binds loopback by default and refuses a non-loopback bind unless browser auth is configured; the session daemon requires a token before it will bind off loopback.
- With browser auth enabled, every non-loopback client needs a live session for the browser data routes (`/events`, `/command`, and `/ctl/*`), and mutations additionally need the CSRF header and an allowed origin. Loopback peers are exempt on both planes.
- Every off-loopback session daemon route on the agent-driving surface (`/events`, `/command`, and `/download`) returns 401 without the exact bearer token, and loopback peers are exempt. Collaboration room guest joins are the deliberate exception; rooms are a CLI and TUI surface with no browser UI.
- Connections are dial-in only for direct and worktree session daemons, and browser roster frames never carry tokens or endpoints. Managed clone daemons are the direction exception: they dial the fleet's callback pair outbound with workspace-scoped enrollment credentials.

Left to the deployment:

- The transport for anything crossing an untrusted network. Use SSH forwarding, a tailnet, or a TLS proxy you operate; omp-web terminates no TLS for the browser edge.
- Access control at the UI origin. With the default loopback bind and browser auth disabled the fleet UI has no login, so whoever can reach it can register projects, spawn session daemons, and prompt agents. Configure browser auth before you move the bind off loopback.
- Reverse proxy behavior for streaming: no response buffering, no short read timeouts, and the proxy listed in `trustedProxies` when it forwards client headers.
- File permissions on the fleet state file and the browser-auth store, which hold session daemon endpoints and tokens in plaintext, and the access-token digest and session records respectively.

## Related

- [Security model](/operations/security/): trust boundaries, token lifecycle, and filesystem protection.
- [Browser auth](/operations/browser-auth/): the login surface, sessions, and token rotation.
- [Local and remote sessions](/concepts/local-and-remote/): the dial-in model in context.
- [Clone workspaces](/fleet/clone-workspaces/): the outbound callback pair and sandbox networking.
- [Run a session daemon over SSH](/advanced/ssh/)
- [Process lifecycle and recovery](/operations/lifecycle-and-recovery/): sleep, wake, and reconnect behavior.
- [Debug panel and diagnostics](/operations/diagnostics/): where to read child stderr and connection state.
- [Troubleshooting](/operations/troubleshooting/): the full symptom list.
- [CLI commands and flags](/reference/cli/) and [Environment variables and precedence](/reference/environment/): complete flag and variable tables.
