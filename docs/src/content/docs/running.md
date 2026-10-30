---
title: Running omp-web
description: "Start the fleet with omp-web, choose its port and binding, set the browser origin behind a reverse proxy, and how sessions dial out, resume and run standalone."
---

`omp-web` runs the fleet in one process: registry, session lifecycle, and the web UI, on one port. The split form runs the two halves as separate processes: the control plane alone, and a UI process that serves the web UI and proxies its API calls to the control plane.

```sh
omp-web [--port n] [--no-open]                       # control plane + UI on http://localhost:4722
omp-web control [--port n]                           # split: control plane only, no UI (default 4722)
omp-web ui [--port n] [--control-port n] [--no-open] # split: UI on 4723, proxying to the control plane on 4722
```

Everything binds loopback (127.0.0.1) by default; expose the UI port through your own reverse proxy (for example `tailscale serve` or NetBird). Bare `omp-web` and `omp-web ui` open the UI in your browser once it is up, but only when run from an interactive local terminal (stdin and stdout TTYs, none of the agent or CI variables `CI`, `CLAUDECODE`, `OMPCODE`, `GEMINI_CLI`, `CODEX_SANDBOX` set, and a display on Linux); scripts, agents (even under a PTY), and service managers never open one, and `--no-open` opts out. `--port` selects the listen port; `OMP_FLEET_PORT` selects the default control-plane port. Startup prints one line, `omp-web listening on http://localhost:<port> (<N> sessions)` (`omp-web control listening on …` and `omp-web ui listening on … (control :<port>)` for the split form), then only warnings and errors; `--verbose` adds the state and config paths and every lifecycle event.

## Browser origin

Behind a reverse proxy, the proxy must set the browser origin: the public origin browsers use, passed as `--browser-origin`, env `OMP_FLEET_BROWSER_ORIGIN`, or the config `browserOrigin` key. Set the same value on `omp-web` (or `omp-web control`) and on `omp-web ui`. Without it the fleet refuses a browser Origin that is neither loopback nor that origin, so the UI's mutations fail. Clients that send a request body must set `Content-Type: application/json`; any other media type is refused with 415, so scripts and other HTTP clients need to set it explicitly.

## Trusted proxies

A proxy listed in `trustedProxies` must append the connecting client to `X-Forwarded-For` (or overwrite the header); the fleet reads the header right to left and takes the first hop that is not a trusted proxy. A proxy that forwards a client-supplied `X-Forwarded-For` unchanged lets that client claim any address, including loopback, which skips sign-in.

## Sessions dial out

Sessions dial out: each session process connects to the control plane over the callback pair (one WebSocket, `/callback/ws`; a reverse proxy in front of the control plane must pass the WebSocket upgrade), and the control plane never opens a connection into a session. Sessions behind NAT, in a sandbox, or in a Kubernetes pod with no inbound traffic work the same way. Ctrl+C on `omp-web` or `omp-web control` stops the control plane only; sessions keep running, including a turn in progress, and redial the next control plane with the same credential. Restart the control plane on the same port: a session keeps dialing the address it was given. After a restart, entries show `reconnecting`, then `ready` once their session redials; one that has not redialed within 45 seconds is shown `asleep`. A session with no control plane for 10 minutes (`--control-grace`, or `OMP_SESSION_CONTROL_GRACE`; `0` disables) shuts itself down gracefully, and one whose credential the fleet rejects (revoked, or superseded by a newer generation) shuts down at once. A spawned session that is asleep wakes on attach or prompt, resuming its last transcript; if the previous process is still alive somewhere (for example dialing an old port), the wake fails with "locked by another omp-session" until that process exits or is stopped. `omp-web stop <selector>` asks a session to shut down, terminates a local one, and revokes its credential.

## Resuming a session file

A `--resume` session file that is missing exits 78 before bind (`omp-session: --resume <file>: session file not found`) and is never created. The fleet passes plain `--resume` only for a file the session has reported persisted, so a transcript that was written and later deleted fails with 78 and its row parks asleep with that reason. A file the fleet never saw persisted (a session that had no messages yet) relaunches with `--resume <file> --resume-unwritten`, which adopts that path as the same not-yet-written session. An explicitly picked file always resumes strictly. A transcript that exists but cannot be restored exits 78 instead of starting empty; its row stays asleep with the session's reason and is never restarted. A provider-managed clone wake resumes the same way through `OMP_SESSION_RESUME` (strict; `OMP_SESSION_RESUME_UNWRITTEN=1` for a file not known to be written): a bwrap clone gets the host path of the newest session, a Kubernetes clone the in-pod path of the session its runtime last reported (or an explicitly picked stored session), and a first start gets none.

## The session process

`omp-web session` runs one session process (one process, one bound directory, one live agent session, wire API only, no web UI). The fleet spawns sessions with the default local template. Callback URLs must be https, except loopback http, which the fleet enables for its own loopback bind (the session reads `callback.allowHttp` from its `--fleet-stdin` payload). Non-loopback fleet service requires browser authentication. A standalone session (started without `--fleet-stdin`) also serves the browser socket itself on `GET /ws` for direct clients: loopback peers need no token but a cross-site dial (foreign `Host`, `Origin` or `Sec-Fetch-Site`) is closed 4403, and an off-loopback client passes the token as the `token` query parameter or an `Authorization: Bearer` header. A fleet-managed session binds no listener.

Local sessions are not mirrored: their transcripts stay on this host (`OMP_SESSION_LOG_MIRROR=0`).

Session processes are disposable; the durable truth is the session `.jsonl` transcript on disk.
