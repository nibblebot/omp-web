---
title: Debug panel and diagnostics
description: Open the Debug panel, read its connection, fleet, and log sections, and collect diagnostic data for a bug report without leaking secrets.
---

The Debug panel is the browser-side view of the connection loops behind omp-web: the `/events` stream between this browser tab and the fleet edge, and the loopback control plane of the fleet. When something misbehaves, the panel shows what the browser believes and what the fleet believes at the same moment, which is exactly the evidence a bug report needs.

Use [Troubleshooting](/operations/troubleshooting/) when you know the symptom and want a repair. Use this page when you need to read the panel in detail or package a report. Both views describe the same facts; the panel is the source, troubleshooting is the symptom index.

## Open the Debug panel

There are two ways in:

- With the Work view active, use **Debug** in the footer of the [fleet sidebar](/fleet/sidebar/), next to **Settings** and after the optional usage panel. Its hover text names the panel as the transport and fleet visibility view.
- Everywhere else, including the Analysis view, the same button sits in the top status bar. See the [Interface tour](/getting-started/interface-tour/) for the surrounding chrome.

The panel opens as a sheet over the app and closes with its close control or Escape. It is read-only: it changes no fleet state. The one exception is the **refresh** button, which re-fetches the fleet section immediately.

## Connection section

The first section describes this browser tab and its downlink. A healthy tab reads `connected`, shows its session and client ids, and reports `none (stream open)`.

| Field | What it shows | Reading it |
| --- | --- | --- |
| `state` | A `connected` or `disconnected` pill. | `connected` means the tab's event stream is open. `disconnected` appears while a retry is pending. |
| `session` | The attached session id, truncated to 8 characters. A dash when nothing is attached. | Hover the value for the full id. |
| `client` | This tab's client id, truncated to 8 characters. | Generated fresh on every page load, so each tab carries a different one. Include it when a report concerns one specific tab or a multi-tab setup. |
| `last frame` | Seconds since the last frame or keepalive ping on the stream, or `never`. | The server pings every 15 seconds, so a healthy connected tab stays in single digits. `never` means no downlink activity arrived since the panel opened. |
| `reconnect` | The pending retry delay in milliseconds, or `none (stream open)`. | A number means a reconnect is scheduled; the delay grows along the client's backoff ladder. |

Any field the client cannot read renders as a dash.

With browser auth enabled, a `401` from the fleet means the browser session is gone (expired, revoked, or ended by an operator token rotation): the client transitions to signed-out and opens its sign-in surface, and no amount of reconnecting fixes it until you sign in again. A rejected command also lands in the client transport log as `command "<type>" rejected (HTTP 401)`.

## Fleet section

This section is fed by the fleet control plane at `/ctl/debug`. The panel fetches it once on open and then polls every 2 seconds while it stays open. The header shows `polling…` while a fetch is in flight and otherwise states the cadence; **refresh** forces an extra fetch. A failed poll keeps the last successful payload on screen and shows the error above it.

While the fleet is still booting or unreachable, the fetch cannot reach the fleet control plane. The panel shows that notice, which is expected and harmless; the connection facts above still describe the live stream.

When browser auth is enabled, `/ctl/debug` is gated like every other `/ctl` route: a non-loopback client needs a live session, so a proxied deployment must be signed in before this section can fill. Loopback clients, including the CLI and the `curl` command in the checklist below, are exempt.

When a fleet payload is present, the facts block reports:

| Field | What it shows |
| --- | --- |
| `port` | The loopback port of the control plane and the browser edge. Default 4722, changed by `--port` or `OMP_FLEET_PORT`. |
| `uptime` | How long the fleet process has been running, in compact form. |
| `since` | Local wall time when the fleet started. |
| `state` | Full path of the fleet state file, the registry the fleet persists. Hover for the full path. |
| `config` | Full path of the loaded configuration file, or a dash when the fleet runs on defaults with no configuration file. |

### Session rows

A table lists every roster entry the fleet knows, in registry order. It renders `no sessions` when the roster is empty.

| Column | What it shows |
| --- | --- |
| `name` | The entry name. Hover for its daemon id, the stable `dN` identifier used by the CLI. |
| `status` | The lifecycle status, colored by state. Hover for the error text when the status is `error`. |
| `mode` | `spawned`, `attached`, or `remote`. |
| `pid` | The live child process id for spawned entries. |
| `endpoint` | Host and port of the session daemon's endpoint. Hover for the full endpoint URL. |
| `uptime` | How long the entry has been up, measured from its ready time, or its registration when it never became ready. |
| `connector` | The fleet's transport state for that entry, plus the redial attempt count and the pending retry countdown when a retry is scheduled, for example `streaming`, `reconnecting (4) · 1600ms`, or `dialing`. |

Connector states are the fleet's side of the connection:

- `streaming`: the connector's stream to the session daemon is open.
- `dialing`: a dial is in flight and has not finished the handshake.
- `reconnecting`: a redial is scheduled; the countdown shows when.
- `idle`: no stream is open and nothing is scheduled, typically because the connector released a ready daemon after the last browser detached so the session daemon's own idle timeout can fire.
- `closed`: the connector marked the entry closed during teardown, so it is not expected during normal operation.

Clone workspace rows carry a provider lifecycle stage on top of the status ladder: `preparation`, `runtime`, `callback`, `ready`, or `failed` with the failure text. Roster frames deliver it and the sidebar row renders it in place of the stage label, but this panel table and the raw `/ctl/debug` payload do not include it, so read the stage from the sidebar and the stage transitions from the fleet log.

### Status progression

Status values follow a monotonic ladder, and only a respawn, a wake-up, or a redial moves a row backward. Read the ladder to tell a slow start from a hang: a row that keeps advancing is working, and a row that stops on a transitional status has stalled there.

| Status | Meaning |
| --- | --- |
| `spawning` | The fleet is starting a local session daemon process. |
| `connecting` | The fleet is opening its connection to the session daemon. |
| `session` | The session daemon created or restored its session. |
| `resolving` | Provider, model, and authentication are resolving. |
| `ready` | The session daemon accepts prompts. |
| `reconnecting` | The stream dropped and the fleet is redialing. The process may still be alive. |
| `asleep` | No live process; the entry can be woken from its durable transcript. |
| `error` | Terminal failure. Only a respawn or wake refreshes the entry, and the error text names the reason. |

For the dot rendering of these statuses and the live activity overlay on rows, see [The fleet sidebar](/fleet/sidebar/) and [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

## Fleet log

The **Fleet log** section replays the fleet's in-memory lifecycle ring: session daemon status transitions, spawns, exits, respawns, and control-route failures. Each line carries a wall-clock time, a level (`info`, `warn`, or `error`), the emitting subsystem such as `connector`, `supervisor`, or `server`, the daemon id for session-daemon events, and the message. Entries render oldest first with the newest at the bottom.

Clone activity shares the ring. Creation, prepare, stop, ensure-running, and deletion-completion lines come from the `server` subsystem, boot reconciliation prints `clone boot reconcile: ...` lines (`reattached`, `recreated`, or `inspect failed`), and a deletion the gate refuses logs a `delete <daemonId> blocked: ...` warning naming the reason. The delete dialog shows the same typed refusal in place while the workspace, its volume, and its logs stay retained.

The same events also print as `fleet:` lines in the fleet's terminal, so the two views describe one history; the terminal line adds the live status, endpoint, and pid details the message alone does not carry. The ring holds the most recent 500 events and lives only in the fleet process: page reloads do not clear it, but restarting the fleet does. An empty section with a notice means the control plane could not be reached, not that the fleet has been idle.

## Client transport log

The **Client transport** section is the browser's own ring, and its header shows the current entry count. Entries come from three sources:

- `transport`: stream lifecycle. Examples: `connecting /events`, `stream open`, `transient blip`, `silence deadline hit`, `connection lost` with the retry delay, `proto mismatch`, and `attach ok` or `attach failed`.
- `command`: uplink problems, for example a command the session daemon rejected with its HTTP status.
- `roster`: roster frame and status-frame handling, for example how many session daemons a roster frame carried, a status transition, or an attached session that disappeared.

The ring keeps the most recent 300 entries and exists only in this tab's memory. A page reload clears it, so copy anything you need before navigating or reloading. The two logs timestamp events on their own sides, so comparing them shows which side of a connection moved first.

## What is and is not redacted

The fleet is deliberate about what its debug payload carries:

- Bearer tokens are never part of it. Nothing from the registry's token field reaches `/ctl/debug`, and browser roster frames omit tokens, endpoints, and spawn templates as well. Automated tests pin both behaviors.
- The fleet-private workspace record for clone entries (provider handle, clone source, pinned revision, cleanup and deletion state) is excluded by construction, along with callback enrollment digests and any secret-ref values.
- The browser-auth material is excluded too: the operator access token lives only as a sha-256 digest in the browser-auth store, the `omp_session` cookie value never enters a payload, and the debug payload carries no cookie or CSRF value.
- Endpoint URLs and ports are included on purpose, because diagnosing a connection requires them. The panel softens this by showing only the endpoint host in the table and keeping the full URL in the tooltip.
- Paths appear in the `state` and `config` facts and can appear inside error text, for example in a working-directory mismatch message.

Everything else in the payload, including process ids, restart counts, and session daemon error strings, is local operational detail rather than a credential. The protection for this surface is the fleet's own access rule: loopback callers are trusted, and with browser auth enabled a non-loopback client must hold a live session before any `/ctl` route, including `/ctl/debug`, answers. If you put that port on a network path through a reverse proxy or a forwarded port, every route comes along; keep such paths authenticated and restricted at the transport layer, as described in the [Security model](/operations/security/) and [Networking and browser access](/operations/networking/).

Before posting diagnostics anywhere public, remove or mask:

- Bearer tokens and `?token=` values, including tokens embedded in URLs you copied from a history or address bar.
- The operator access token and anything derived from it, plus any `omp_session` cookie value or `X-Omp-Csrf` header copied out of a browser devtools capture.
- Provider authentication URLs, device codes, and API keys that may appear in terminal output or the session daemon's stderr.
- Private hostnames, tailnet names, and endpoint URLs that map your network.
- Absolute paths that expose usernames, private project names, or customer names.
- Prompt text, transcript content, and session titles, which are not part of the debug payload but are easy to include accidentally in a screenshot or a terminal capture.

The debug payload itself is token-free, so a raw copy of it is the safest artifact to share. Terminal captures, the session daemon's stderr, and screenshots are not, and they need a manual pass.

## Terminal logs

Two process families write logs, and each stores them differently.

### The fleet process

`omp-web` prints a startup banner on stdout, including these lines:

```text
fleet listening on 127.0.0.1:4722
fleet state: /home/you/.omp-web/fleet-state.json
fleet config: /home/you/.omp-web/config.json
fleet restored 3 sessions (ready: 1, asleep: 2)
Web UI: http://localhost:4722
```

The listening line carries the actual control port, which matters when the fleet runs on a non-default port. After the banner, each lifecycle event prints one `fleet:` line, enriched with the live status, endpoint, and pid that the message alone does not carry. A clean stop prints a final line naming the signal, for example `fleet: SIGINT, shutting down`.

A startup refusal prints before the banner and the process exits 1, so there is no fleet log at all for that run. The one you are most likely to meet is the non-loopback bind without browser auth:

```text
refusing to bind non-loopback address "0.0.0.0" without browser auth; set OMP_FLEET_BROWSER_TOKEN (or --browser-access-token / config browserAccessToken)
```

The fleet writes these lines to its own terminal and keeps the last 500 events in memory for the panel; it never writes them to a file. If you need history, capture the terminal where you started `omp-web`, or read the log of the service manager that runs it.

### Session daemon stderr

A session daemon reserves stdout for a single machine-readable startup line and writes everything else, its own logs, warnings, and fatal errors, to stderr. Typical lines name the cause directly, for example a background model refresh failure, a session that failed to start, a resume that fell back to a fresh session, a session file locked by another process, or a refusal to bind off loopback without a token.

For a session daemon the fleet spawned, open the row's `⋯` menu in the sidebar and choose **Daemon details**. The popover's `stderr` section shows the captured tail, meaning the last 64 KB of that child's stderr, with a **refresh** button. Two caveats apply:

- The tail is a rolling in-memory buffer, not a log file. It is lost when the entry is removed or the fleet stops.
- For an asleep or errored row, the popover labels the text as the capture from the last run, because no live process is writing. A row that the fleet does not own, such as a remote or attached entry, has no captured stderr at all and the popover says so.

A session daemon you started by hand writes to the terminal that launched it. That terminal holds the full output, not a 64 KB tail, so prefer it over the popover when you have it.

## Collect a bug report

Work through this checklist and the bug report template fills itself in: it asks for the same items, in the same order, as what happened, how to reproduce it, the version, the environment, and logs or screenshots.

1. Reproduce the problem and write down the smallest reliable sequence of steps, with what you expected and what happened instead.
2. Record the environment. Run `omp-web --version`, or note the commit when running from source. Note your OS and distribution, the Bun version from `bun --version`, how omp-web was installed, and whether the affected session daemon is local or remote.
3. Open the Debug panel and copy its five groups: the connection facts, the fleet facts, the session rows (name or daemon id, status, mode, pid, connector state with attempt count), the fleet log, and the client transport entries. Do this before reloading the page or restarting the browser, because the client log lives only in the tab. If the fleet section shows a fetch notice, copy that text too. For a clone row, also copy the sidebar stage label or its `lifecycle` error text and any `delete <id> blocked: ...` line from the fleet log; for a browser-auth problem, say whether auth is enabled and include the HTTP status the browser saw (401 for a missing or revoked session, 403 for a CSRF or origin rejection).
4. Capture the raw fleet payload while the problem is still visible:

   ```sh
   curl -s http://127.0.0.1:4722/ctl/debug
   ```

   Use the port from the fleet's listening line if it is not the default. The raw document carries fields the panel does not render, including the supervisor restart count and per-entry ready and registration timestamps, which is why it is worth attaching alongside the panel reading. When the browser reaches the fleet through a forward or a proxy, the same document is served at `/ctl/debug` on the UI origin; run the `curl` from the fleet host so it arrives as a loopback client, which stays exempt from browser auth.
5. Capture the affected session daemon's stderr from **Daemon details**, or from its terminal when you started it yourself. If the entry is asleep or errored, say so, since the tail is then from the last run. A clone row's capture is empty, because its daemon is not a fleet child process: use the fleet log's `clone ...` lines and the sandbox's own output on the provider host instead.
6. Capture the fleet terminal output around the failure, including the `fleet:` lines and the banner. The panel's ring is capped at 500 events, so the terminal is the only complete record.
7. Add the roster table from `omp-web sessions`, which maps daemon ids to names, statuses, and checkout paths in text form. See [Operate session daemons from the CLI](/cli/session-daemon-operations/).
8. Redact the artifacts using the checklist above, then attach large captures as files rather than pasting truncated blocks, and crop screenshots to the relevant panel or terminal region.

Recovery steps are intentionally not repeated here. A symptom that reads like a known failure, such as a stuck `resolving` row, a protocol mismatch, or a held lock, has a matching entry in [Troubleshooting](/operations/troubleshooting/) with the fix.

## Related

- [Troubleshooting](/operations/troubleshooting/)
- [Security model](/operations/security/)
- [Networking and browser access](/operations/networking/)
- [Process lifecycle and recovery](/operations/lifecycle-and-recovery/)
- [Browser auth](/operations/browser-auth/): the sign-in surface and session lifetime.
- [Clone workspaces](/fleet/clone-workspaces/): clone stages, stop and wake, and verified deletion.
- [The fleet sidebar](/fleet/sidebar/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
