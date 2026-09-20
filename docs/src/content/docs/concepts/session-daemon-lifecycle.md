---
title: Session daemon lifecycle
description: "Every state a session daemon moves through, from spawn to ready, sleep, reconnection, and error, and how omp-web starts, wakes, restarts, and stops it."
---

A session daemon is a process with a job: serve one directory and one live session. It is also disposable by design, so omp-web tracks it through a small set of user-visible states and owns the recovery path for each one. This page explains what those states mean, who moves the session daemon between them, and what you see when a transition fails.

The status shown on a roster row is the fleet's record for that entry, not a value reported by the session daemon itself. The fleet derives it from what it observes: the process it started, the connection it holds, and the frames the session daemon sends. That is why a row can be accurate about a process that is not running at all.

## The states

| Status | What it means | How it ends |
| --- | --- | --- |
| spawning | The fleet created the roster entry and launched the local process. | The child prints its listening line, or the spawn fails or times out. |
| connecting | The fleet is opening its connection to the session daemon's endpoint. | The handshake is validated, or the dial fails and the row reconnects. |
| session | The session daemon has created or restored its session. | The first live state arrives and the row moves on. |
| resolving | Provider, model, and authentication are resolving inside the session daemon. | The session daemon reports ready, or it stays here while a provider problem persists. |
| ready | The session daemon accepts prompts and streams responses. | It sleeps, stops, drops its connection, or fails. |
| reconnecting | The connection dropped, or a dial never completed. | A redial succeeds, or the failure is terminal. |
| asleep | No live process (local) or no live connection (remote). The checkout and last session file are kept. | You wake it, or you remove the row. |
| error | A terminal failure that only a wake or a fresh start clears. | A respawn or redial that succeeds. |

The readiness ladder is monotonic. The fleet ranks `connecting`, `session`, `resolving`, and `ready`, and it never moves a row backwards along that ladder, so an out-of-order frame cannot downgrade a session daemon that is already ready. `error` is terminal in the same way: it is never overwritten by a later status, only replaced by a successful respawn or redial.

```text
happy path
  spawning ──▶ connecting ──▶ session ──▶ resolving ──▶ ready

failure and recovery
  spawning    ── spawn failed or endpoint timeout ─────────────▶ error
  connecting  ── bad protocol, wrong directory, or bad token ──▶ error
  connecting  ── dial failed ──▶ reconnecting ── redial ok ────▶ ready
  ready       ── connection dropped ───────────────────────────▶ reconnecting
  ready       ── idle auto-exit or stop ──▶ asleep ── wake ────▶ connecting
  error       ── respawn or redial ────────────────────────────▶ connecting
```

## Starting a session daemon

Starting a local session daemon runs the spawn template for its checkout, which by default executes `omp-web session` with the bound directory, an ephemeral port, a fresh bearer token, the entry name, its labels, and a resume flag when the row has a session to restore. The fleet then waits for the child to report its endpoint, up to 30 seconds.

What happens next, in order:

1. **spawning.** The roster entry exists and the child process is running. The row is not clickable.
2. **connecting.** The child printed its listening line, the fleet resolved a reachable endpoint, and it is dialing. The handshake is checked here: a session daemon that speaks a different wire version, or that reports a different working directory than the row was registered with, fails with a terminal error instead.
3. **session.** The handshake passed and the session daemon created or restored its session.
4. **resolving.** The session daemon is resolving provider credentials and the model for the session. The composer stays gated.
5. **ready.** Prompts work. The row becomes clickable and the attachment can proceed.

Steps that fail before `ready` are visible rather than silent: the row turns red with error details, and the details view shows the captured stderr from the child, which is where the session daemon writes everything except its contract lines.

## Working states

Two things can happen to a ready session daemon that are not lifecycle states:

- **Streaming.** A turn is running. The row's activity dot shows in progress, and the conversation keeps streaming even if you switch to another row or another view.
- **Blocked.** An extension dialog is waiting for your input. The row shows the blocked state, which takes precedence over streaming.

Both are derived by the fleet for every ready session daemon it holds a connection to, not only the one you are viewing, so a detached row can still say in progress. See [The fleet sidebar](/fleet/sidebar/) for how status and activity render together, and [Understand roster status](/fleet/roster-status/) for the precedence rules.

## Sleeping and waking

A local session daemon exits on its own once it has been continuously idle for its idle timeout, 30 minutes by default. Idle means all of the following at once:

- No browser stream is attached.
- The fleet is not holding a connection to it. While you have a browser open on the fleet, the fleet keeps a connection to each ready session daemon, which counts as an attached client.
- No agent turn is running and no follow-ups are queued.
- No bash or eval command is in flight.
- No extension dialog is open.
- No collaboration room is live in that session.

That exit is clean, and the row becomes **asleep**. Asleep is a normal, expected state, not a failure. The checkout is remembered, a process id and uptime are no longer shown, and the last session file is kept so the conversation can be restored.

The timeout is configurable per session daemon with `--idle-timeout`, and `--idle-timeout 0` disables auto-exit for deployments that want the process to stay up. Fleet-spawned session daemons use the default. The check counts continuous idleness, so any activity, including a browser attaching, restarts the clock.

Waking depends on what kind of row it is:

- **A locally spawned row** is respawned from its template with the resume file, usually its last session, or the file you picked from the session dropdown.
- **A remote row** is redialed instead. There is no child process to restart, so the fleet reconnects to the endpoint it has on record.

Either way the wake is serialized per row, so clicking a sleeping row and attaching to it in quick succession launches one process, not two.

## Reconnecting

A dropped connection is normal and recoverable. The fleet treats a streaming connection as dead when it ends unexpectedly, when no traffic at all arrives within 30 seconds, or when the session daemon terminates it in-band because the client was too slow. It then redials with jittered exponential backoff, starting at about a second and capping at 30 seconds.

Two details matter for what you see:

- A redial resumes from the last event the fleet saw, so frames produced while the connection was down are replayed rather than lost.
- A clean end is not a drop. When a session daemon goes dormant it closes the stream normally, and the row goes asleep instead of reconnecting. A reset frame just before the close marks the opposite case: the session daemon is alive but the client was too slow, so the fleet reconnects rather than sleeping.

The browser stays attached to the same session daemon while this happens: the composer stays gated, the conversation does not reset, and the stream resumes when a redial succeeds. If the redial budget is exhausted, or the session daemon rejects the token or speaks the wrong protocol version, the attachment is reported lost and an error banner appears; clicking the row attaches again.

## Crashes and bounded restarts

If a local session daemon exits unexpectedly, the fleet restarts it with a fresh token and resumes the last session file. Restarts use the same jittered backoff as reconnects, and the restart budget is bounded: after five consecutive exits without ever reaching ready, the row stops restarting and becomes an error that names the exit count.

The budget counts consecutive failures, not lifetime restarts. A session daemon that reaches ready once has its counter reset, so a process that crashes, recovers, and crashes again on a later day is restarted again rather than being abandoned.

## Stopping and removing

- **Stop** terminates a local session daemon gracefully: a termination signal first, then a forced kill if it has not exited after five seconds. The row becomes asleep and stays resumable. Stopping a remote row does not kill anything on the remote host; it drops the fleet's connection and marks the row asleep.
- **Remove** stops the session daemon and drops the roster entry. Ids are never reused, and removal is the only way to make a row disappear. Neither action deletes a transcript; see [Session persistence](/concepts/session-persistence/).

## Error states

| Reported problem | What it means | What to do |
| --- | --- | --- |
| `proto mismatch` | The session daemon speaks a different wire version than the fleet expects. | Update the older side, then respawn the row. |
| `cwd mismatch` | The directory the session daemon reports differs from the directory registered for the row. | Register the correct checkout or respawn with the right directory. |
| `unauthorized (401)` | The session daemon rejected the fleet's token. | Respawn a local row to mint a new token, or fix the token on the remote side. |
| `endpoint timeout` | The local child never reported a listening endpoint within 30 seconds. | Check the spawn template and the captured stderr. |
| `invalid endpoint from child` | The child reported an endpoint that is not a usable URL. | Fix the template or wrapper that prints the contract line. |
| `no endpoint registered` | The row has nothing dialable. | Re-register or respawn it. |
| restart budget exhausted | The child exited five times without reaching ready. | Fix the underlying crash, then respawn. |

Every one of these is cleared by a wake or a respawn, which is also why the row keeps offering those actions. For setup-level causes behind them, including a missing `omp` binary, an unauthenticated provider, or a missing default model, see [Troubleshooting](/operations/troubleshooting/).

## When the fleet restarts

The fleet owns the child processes, so restarting it changes what the rows can claim. On boot it rewrites persisted statuses into something truthful: locally spawned rows are set to asleep, because their processes died with the old fleet, and remote rows are set to connecting and dialed again. Terminal `error` rows and intentional `asleep` rows are left alone. Liveness facts such as process ids and uptimes are cleared on every downgrade, so a row never shows a process that is not there.

## Related

- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) for where a session daemon sits in the model.
- [Session persistence](/concepts/session-persistence/) for what survives each of these transitions.
- [Local and remote sessions](/concepts/local-and-remote/) for the dial-in rows that are woken by redial instead of respawn.
- [The fleet sidebar](/fleet/sidebar/) for how statuses and activity render.
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/) for the actions on a row.
- [Troubleshooting](/operations/troubleshooting/) for the setup failures behind the error states.
