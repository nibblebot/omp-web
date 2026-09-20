---
title: Collaboration rooms
description: Host and join a live, end-to-end encrypted collab room for one session daemon from the CLI or TUI, including writable and read-only links, limits, lifecycle, and risks.
---

Collaboration rooms are hosted and joined through the CLI or TUI. omp-web currently has no browser collaboration surface.

A collab room mirrors one live session to other terminals. The session daemon is the host: it creates the room on its own HTTP port, stays authoritative for the conversation, and streams transcript entries, agent events, state, and dialogs into the room. A guest runs the `omp` TUI against a replica of the same session, so the guest sees the conversation and the agent working, not a transcript dump.

Guests dial in. They connect to the room's relay, and the session daemon never connects back to a guest.

## Prerequisites

- A session daemon running and reachable on loopback at a port you know. The examples use the session daemon default, 4721. Start one with `omp-web session` if needed, and see [Run a standalone session daemon](/cli/standalone/) for its flags.
- The omp-web source checkout for the host CLI. Starting a room is `bun run collab`, the `collab` script in `package.json` that runs `server/collab-cli.ts`. There is no installed `omp-web collab` verb.
- The `omp` CLI on the machine that joins.

The collab CLI talks to one session daemon over loopback, not to the fleet control plane. Session daemons spawned by the fleet use an ephemeral port under the default template, so the default port only reaches a session daemon you started yourself, for example `omp-web session --port 4721`.

## Start a room

From the omp-web checkout:

```sh
bun run collab
```

The command opens the session daemon's event stream, sends `collab_start`, waits up to 10 seconds for the room to go live, and prints:

```text
room: <room id>
omp join <link>
omp join <view link>  # read-only (view)
```

Expected result: the room is live, the command exits 0, and guests can join with either printed link. Running the command again while a room is live prints the same links instead of failing.

Flags, passed to the script after `--`:

| Flag | Effect |
| --- | --- |
| `--port <n>` | Daemon HTTP port to drive. Default 4721; `OMP_SESSION_PORT` supplies the default. |
| `--join` | After the room is live, runs `omp join` for the writable link in the same terminal and exits with the TUI's exit code. |
| `--view` | With `--join`, joins through the read-only link instead. |
| `--stop` | Stops the room instead of starting one. |
| `-h`, `--help` | Prints the usage line. |

Examples:

```sh
bun run collab -- --join            # start, then join as a writer
bun run collab -- --view --join     # start, then join read-only
bun run collab -- --port 4730       # drive a session daemon on another loopback port
```

`bun server/collab-cli.ts` takes the same flags if you prefer the entry point directly. Only one room exists per session at a time.

## Join a room

Join from another terminal with the `omp` CLI:

```sh
omp join "<link>"
omp join "<view link>"     # read-only
```

- `omp join` requires an interactive terminal.
- Inside a running TUI, `/join <link>` does the same thing.
- The guest TUI writes the host's snapshot to a replica session, then applies live updates.
- `/leave` leaves the room and restores the guest's previous local session.

A guest that holds the write token can prompt the session (a prompt that arrives while a turn is streaming steers that turn), interrupt it, chat with or kill the main agent and subagents, revive subagents, and answer the agent's ask dialogs. A read-only guest can watch, browse the transcript, and read subagent transcripts; prompting, interrupting, agent control, and dialog answers are refused. The guest side reports `This collab link is read-only`, and the host answers with `<action> is disabled on a read-only link`, for example `prompting is disabled on a read-only link`.

When at least one writable guest is attached, ask dialogs go to collab first: the guest's answer, including a cancel, settles the request, and only an unavailable collab channel falls through to the browser UI.

Participants are listed with the host first. The host name is `OMP_SESSION_COLLAB_HOSTNAME`, the OS username, or `web`, in that order. Guest names are self-declared by the guest TUI (its `collab.displayName` setting, otherwise the guest's OS username) and are not verified.

## Writable and read-only links

Both links point at the relay room and carry the room key in the URL. The difference is the write token:

- A read-only (view) link carries the 32-byte room key.
- A writable link carries the room key plus a 16-byte write token.
- The secret is base64url encoded after the room id, for example `localhost:4721/r/<roomId>.<secret>`. A view secret is 32 bytes; a writable secret is 48 bytes.
- The host checks the token with a timing-safe comparison. A guest that presents no token, or the wrong token, is read-only.

Treat a writable link as a credential: anyone who holds it can drive the session. Stopping the room invalidates both links; the next start mints a new room id, room key, and write token.

## Stop a room

```sh
bun run collab -- --stop
```

Expected result: `collab stopped` and exit 0. If no room is live, the command prints `collab is not active` and still exits 0. The stop request is given up to 10 seconds.

The stop sends guests a goodbye, then the relay tells every guest `room-closed` and closes its socket with code 4001.

A room also ends when the session daemon shuts down (Ctrl+C, or the fleet stopping the entry) and when the session switches inside the session daemon, for example after new, resume, branch, or fork. The session daemon then sends a `Collab ended: session switched` notice.

A live room counts as activity, so the session daemon's idle auto-exit is suspended and it stays running until the room stops or you shut it down.

## Lifecycle and reconnects

A room starts at `starting` and settles at `live` or `error`; with no room the status is `off`. Rooms are process state, not stored state: a session daemon restart discards the room and both links, and a restart is a new room with new links.

- The host keeps the room alive across a transient relay disconnect: its socket reconnects with exponential backoff, 1 second doubling to 30 seconds, with jitter.
- A room outlives a missing host for 60 seconds. A host reconnect inside that window re-adopts the room with its guests; after 60 seconds the room is destroyed and remaining guests are closed with 4001.
- Guests reconnect with the same backoff and re-sync from a fresh snapshot, which replays the session replica. Up to 256 frames are buffered while a guest is disconnected.
- Fatal closes are terminal and never retried: `4001 room closed`, `4004 no such room` (the guest joined before a host was live), `4009` when a second host connection arrives for a live room, `4028 too many rooms`, and `4029 room is full`. A failed decryption (wrong or corrupt key) also never reconnects.

## Limits

- One room per session daemon session.
- Guests per room: 64. Additional guests are closed with 4029. Restart the session daemon with a different `OMP_SESSION_COLLAB_MAX_GUESTS` to change the cap.
- Rooms per session daemon: 256. A new room past the cap is refused with HTTP 503 before the WebSocket upgrade, with 4028 as the backstop for a race; re-adopting an existing room is always allowed. `OMP_SESSION_COLLAB_MAX_ROOMS` changes the cap and is floored at 1 so the session daemon's own host always has room.
- Guest transcript reads ship at most 4 MiB per reply; guests continue from the byte offset where the previous reply ended.
- The initial snapshot ships in byte-bounded chunks (512 KB soft cap). If the welcome snapshot exceeds 24 MB, images are stripped from the copy guests receive.

## Encryption

Every session frame is sealed with AES-256-GCM before it leaves the host and opened by the guest; the room key exists only in the links. Session content never reaches the relay in cleartext: it forwards opaque envelopes and handles only the room id, the 4-byte peer id header, and the control messages (`peer-joined`, `peer-left`, `room-closed`). The relay runs inside the session daemon process, on the same HTTP port as the web interface.

This protects session content in transit through the relay. It does not protect a guest terminal after decryption, and it does not replace transport security: the session daemon does not terminate TLS. Plain `ws://` relay links are accepted only for localhost; any other host must be `wss://`, which you terminate yourself.

## Token requirements

- The session daemon bearer token (`--token` or `OMP_SESSION_TOKEN`) is required off loopback for the event stream, commands, and relay host upgrades. Loopback peers are exempt, and binding a non-loopback address without a token is refused at startup.
- Hosting a room through the collab CLI needs no bearer token: the CLI and the host adapter both connect over loopback.
- The write token governs guest write access only. It is not the bearer token, and it grants nothing outside its room.
- There are no accounts and no per-guest permissions. Access is possession of a link, and revocation is stopping the room.

## Remote guests

By default links advertise the session daemon's own loopback address, `ws://localhost:<port>`, which only works from the machine that runs the session daemon. To join from another machine, give the guest a path to that relay:

- SSH forwarding keeps the printed link unchanged. On the guest machine, forward the port the link uses: `ssh -L 4721:127.0.0.1:4721 <host>`, then join the printed `localhost:4721/...` link.
- A TLS-terminating front can advertise a public origin: set `OMP_SESSION_COLLAB_URL=wss://collab.example.com` and have the front forward `/r/...` (including the WebSocket upgrade) to the session daemon's loopback port. Links then advertise the front while the host still connects to its local relay; the variable changes only what the links say.

The session daemon does not terminate TLS and issues no certificates. Non-local links must be `wss://`, and the link formatter refuses to produce a plain `ws://` link for anything but localhost.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `timed out connecting to http://127.0.0.1:<port>/events` | Nothing is listening on that loopback port. | Start a session daemon or pass the port it actually bound. |
| `collab_start failed: <reason>` | The session daemon refused to create the room. | Read the reason. A non-local `ws://` value in `OMP_SESSION_COLLAB_URL` is rejected here. |
| `timed out waiting for the collab room (is the daemon on port <port>?)` | The command was accepted but no live status arrived within 10 seconds. | Check the session daemon output for the relay error. |
| `collab is not active` on stop | There was no live room to stop. | Informational; the exit code is 0. |
| A guest is closed with `4004 no such room` | The guest joined before a host was live, or the session daemon restarted and the old room is gone. | Start a room, then join again with a fresh link. |
| A guest is closed with `4029 room is full` | The room reached its 64-guest cap. | Wait for a guest to leave, or restart the session daemon with a higher `OMP_SESSION_COLLAB_MAX_GUESTS`. |
| A guest is closed with `4001 room closed` | The room stopped, the session daemon exited, or the host was gone for more than 60 seconds. | Links belong to one room; join the new room the host starts. |

## Risks and boundaries

Application guarantees:

- Session content is end-to-end encrypted between the host and each guest; the relay only forwards opaque frames.
- The write token is the only thing that separates a writable guest from a read-only one, and stopping the room invalidates every link.

Deployment responsibilities and limits:

- There are no accounts, no approval step, and no per-guest revocation. Anyone holding a link can join while the room is live, and stopping the room is the only way to revoke access.
- A writable link is full control of the session: prompts and steering, interrupts, subagent control, and dialog answers. Because a writable guest answers dialogs first, an attached guest can answer or cancel the agent's questions before the browser sees them.
- A read-only guest still receives the entire conversation, including tool output and the file contents the agent works with. omp-web does not redact collab traffic, so share only with people who may see the project content.
- The session daemon does not idle-exit while a room is live, even if no browser is open.
- Rooms are per session, not per project or fleet. omp-web provides no multi-user accounts, no browser collaboration surface, and no browser fan-out prompting.

## Related pages

- [Remote and advanced](/advanced/)
- [Run a standalone session daemon](/cli/standalone/)
- [CLI overview](/cli/overview/)
- [Runtime modes](/concepts/runtime-modes/)
- [Security model](/operations/security/)
- [Troubleshooting](/operations/troubleshooting/)
