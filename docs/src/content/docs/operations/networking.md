---
title: Networking and browser access
description: Where omp-web binds by default, how to reach the browser UI from another device over SSH, a tailnet, or your own TLS proxy, how host, port, and advertise decide where a session daemon is dialed, and how to diagnose reachability and authorization failures.
---

omp-web listens on loopback by default. The fleet serves the browser UI, the streaming wire API, and its control plane on one loopback port, and a standalone session daemon serves its own UI on another. This page covers that default layout, the ways to reach it from another device, the host, port, and advertise settings that decide where a session daemon can be dialed, and the failures that appear when a route or a credential is wrong.

## Default network layout

| Listener | Default address | Who connects |
| --- | --- | --- |
| Fleet: browser UI, `/events`, `/command`, `/ctl` | `127.0.0.1:4722` | Your browser and the `omp-web` CLI |
| Session daemon: single-session UI and wire API | `127.0.0.1:4721` | Your browser (single-session mode) or the fleet |
| Vite dev server (source checkouts only) | `127.0.0.1:4713` default; the dev runners pick per run | Your browser while running `bun run dev` |

Three properties define the layout:

- **The fleet plane is loopback only.** The browser UI, the `/events` and `/command` endpoints the UI uses, and the `/ctl` routes the CLI uses share one server bound to `127.0.0.1`. Only the port is configurable; there is no host flag. The bind is fixed in the source, so no environment variable or flag can move it off loopback.
- **A session daemon binds `127.0.0.1` by default and may bind elsewhere.** Off loopback it requires a bearer token, and the agent-driving routes check it. See [Security model](/operations/security/) for token minting, storage, and rotation.
- **Browser traffic is same-origin.** One process serves the page, `/events`, `/command`, `/ctl`, and `/download`. omp-web sends no CORS headers, so a page served from one origin cannot call the wire API on another.

Connections between the fleet and session daemons are dial-in: the fleet always opens the connection to the session daemon. A session daemon never dials out, never learns the fleet's address or state, and a remote environment needs no route back to the fleet.

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

Open the printed URL and the roster loads with no credential prompt. `omp-web --version` is entirely local; every other subcommand talks to the control plane on this same loopback port, so pass the same `--port` when you changed it.

To run a standalone session daemon without a fleet:

```sh
omp-web session --cwd /path/to/project
```

Expected result: the session daemon prints `omp-session listening on http://localhost:4721` to stderr and reserves stdout for its machine-readable `OMP_SESSION|` line. Open `http://localhost:4721` for the single-session UI.

Safety and persistence in this layout:

- Nothing is reachable from outside the machine, and loopback peers are exempt from the session daemon's bearer check, so no token is needed for local browsing.
- Ports are routing, not storage. Changing a port does not move the fleet state file, config, managed worktrees, or session transcripts. Each roster entry records an endpoint: a fleet-spawned row is resolved again from the child's next listening line, while a registered remote entry keeps the endpoint you registered until you re-register it.
- Starting a second process on a fixed port that is already held fails at startup with `Error: Failed to start server. Is port <n> in use?` and exits 1. Either stop the holder, pass a different `--port`, or pass `--port 0` to let the kernel pick an ephemeral port; the fleet banner, and for a session daemon the `OMP_SESSION|` line, report the real port.

## Reach the browser UI from another device

Prerequisites: the machine running omp-web is reachable from the device you browse from, and you can authenticate to it (SSH, tailnet membership, or a proxy you operate). Keep the fleet on loopback and put a loopback path in front of it; the tunnel or proxy is the login.

### Why direct access does not just work

- The fleet refuses connections on anything but loopback, so browsing to the host's LAN, tailnet, or public address does not reach it at all.
- A session daemon can be bound off loopback, but then every request needs the bearer token, including the script and stylesheet requests that load the UI. A token on the page URL authenticates the document, the stream, and commands, but a browser cannot attach credentials to the asset requests, so the page loads without its bundle. Off-loopback binds exist so the fleet and other API clients can dial in, not as a browser exposure path.

### SSH local forward

Forward the loopback port to the device with the browser:

```sh
ssh -N -L 4722:127.0.0.1:4722 user@fleet-host     # fleet mode: browse http://localhost:4722
ssh -N -L 4721:127.0.0.1:4721 user@session-host  # single-session: browse http://localhost:4721
```

`-N` opens no remote command, so the connection exists only as the forward. Expected result: the same URLs as local use work unchanged, because the forwarded connection arrives at the server from `127.0.0.1` and is treated as loopback.

### Tailnet

Keep the server on loopback and publish that loopback port to the tailnet from the host itself, with a local terminator such as `tailscale serve`:

```sh
tailscale serve --bg 4722     # publish the loopback fleet port on the tailnet with managed TLS
```

Expected result: any device in the tailnet opens the tailnet HTTPS URL and reaches the fleet. The terminator dials `127.0.0.1` from the host, so the fleet still sees a loopback peer, device identity and transport encryption come from the tailnet, and no session daemon token is involved. The fleet cannot be bound to the tailnet address itself, so the terminator has to run on the host.

### Your own TLS proxy

omp-web does not terminate TLS and ships no certificates. To expose the UI over HTTPS, run a reverse proxy on the same host (or on the same machine as a standalone session daemon), terminate TLS there, and forward every path to the loopback port. Requirements that come from the wire protocol:

- **Do not buffer responses.** `/events` is a long-lived SSE stream. The session daemon marks its responses `x-accel-buffering: no` (honored by nginx) and sends an `event: ping` keepalive every 15 seconds. A proxy that accumulates the response or caches it stalls the UI.
- **Do not time out long-lived connections.** A client that sees no event or comment for 30 seconds treats the stream as dead and redials. Keep proxy read timeouts above the keepalive cadence, and do not enable response compression on the stream.
- **Forward the whole origin.** The page, `/events`, `/command`, `/ctl`, and `/download` must reach the same server; splitting them across origins fails because there are no CORS headers.

Minimal nginx shape (certificates, access control, and any authentication in front are yours to configure):

```nginx
server {
	listen 443 ssl;
	server_name omp.example.com;

	location / {
		proxy_pass http://127.0.0.1:4722;   # fleet; use 4721 for a standalone session daemon
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_buffering off;
		proxy_read_timeout 3600s;
	}
}
```

Because the proxy connects from the host, the fleet sees a loopback peer and the browser needs no credential of its own. That also means the proxy is the only access control in place: anyone who can reach it can drive the fleet and every attached session daemon.

### Development-only LAN access

When running from a source checkout, the dev runner can expose only the Vite dev server, leaving the fleet and session daemons on loopback. Vite proxies `/events`, `/command`, `/download`, and `/ctl` to them server-side:

```sh
bun scripts/dev.ts fleet --host                                  # Vite binds 0.0.0.0; backends stay loopback
bun scripts/dev.ts fleet --host --allow-hosts my-box.tailnet.ts.net
```

- `--host` with no address binds `0.0.0.0`; pass an address to bind a specific interface.
- The dev runner picks Vite's port per run (backends bind ephemeral ports), so read the actual URL from the `stack ready` summary.
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

The port resolves as `--port`, then `OMP_FLEET_PORT`, then the default `4722`; `0` selects an ephemeral port. The bind address is always `127.0.0.1`. The CLI reaches the control plane at `http://127.0.0.1:<port>`, so every `omp-web` subcommand must use the same port the fleet is listening on.

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

- The browser holds one SSE stream to the fleet (or, in single-session mode, to the session daemon). Every stream receives an `event: ping` keepalive every 15 seconds.
- A fleet-side connection that sees no event or comment for 30 seconds treats the peer as dead, aborts the stream, and redials with jittered exponential backoff (1 second up to 30 seconds), resuming from the last event id so no frames are lost. Browser reconnection follows the same pattern. See [Process lifecycle and recovery](/operations/lifecycle-and-recovery/) for what the statuses mean while this happens.
- A slow consumer is cut loose with a `stream_reset` frame once its queue passes 4 MiB and reconnects with replay; a reset is not a session daemon crash.
- A session daemon exits after its idle timeout (30 minutes by default) once nothing needs it. While a browser is attached, the fleet keeps a stream open to each ready session daemon, which suspends that auto-exit; when the last browser detaches, unused streams close so the session daemons can sleep again. Session transcripts are durable JSONL files, so sleeping, disconnecting, and reattaching never lose a conversation.

## Common reachability and authorization failures

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `Unauthorized` (HTTP 401), or a page that loads without its bundle, on an off-loopback session daemon URL | The request has no bearer token, or the token is wrong. Static assets are gated too. | Reach the UI through a loopback path: SSH forward, tailnet terminator, or same-host proxy. A `?token=` on the page URL authenticates the document and the wire API, not the asset requests. |
| `refusing to bind non-loopback address "<host>" without a token` | A session daemon was started off loopback with no credential. | Restart it with `--token` or `OMP_SESSION_TOKEN`. |
| Remote `curl http://<host>:4722` is refused, and no other device can open the fleet URL | The fleet is loopback only. | Forward the loopback port (`ssh -L 4722:127.0.0.1:4722 user@host`) or publish it on a tailnet from the host. Never forward it to a shared or public interface. |
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

- The fleet plane binds loopback only, with no host override, and the session daemon requires a token before it will bind off loopback.
- Every off-loopback session daemon route on the agent-driving surface (`/events`, `/command`, `/download`, and the static UI) returns 401 without the exact bearer token, and loopback peers are exempt. Collaboration room guest joins are the deliberate exception; rooms are a CLI and TUI surface with no browser UI.
- Connections are dial-in only, and browser roster frames never carry tokens or endpoints.

Left to the deployment:

- The transport for anything crossing an untrusted network. Use SSH forwarding, a tailnet, or a TLS proxy you operate; omp-web terminates no TLS.
- Access control at the UI origin. The fleet UI has no login, so whoever can reach it can register projects, spawn session daemons, and prompt agents.
- Reverse proxy behavior for streaming: no response buffering, no short read timeouts.
- File permissions on the fleet state file, which stores session daemon endpoints and tokens in plaintext.

## Related

- [Security model](/operations/security/): trust boundaries, token lifecycle, and filesystem protection.
- [Local and remote sessions](/concepts/local-and-remote/): the dial-in model in context.
- [Run a session daemon over SSH](/advanced/ssh/)
- [Process lifecycle and recovery](/operations/lifecycle-and-recovery/): sleep, wake, and reconnect behavior.
- [Debug panel and diagnostics](/operations/diagnostics/): where to read child stderr and connection state.
- [Troubleshooting](/operations/troubleshooting/): the full symptom list.
- [CLI commands and flags](/reference/cli/) and [Environment variables and precedence](/reference/environment/): complete flag and variable tables.
