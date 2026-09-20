---
title: Run a remote session daemon over SSH
description: Spawn or register a session daemon on another host over SSH, with prerequisites, template fields, endpoint and token wiring, resume behavior, and failure diagnosis.
---

A session daemon does not have to run on the same machine as the fleet. You can run `omp-web session` on a remote host and supervise it from the fleet exactly like a local row: the fleet learns the endpoint from the session daemon's startup line and dials in.

Remote operation is dial-in. The fleet initiates every connection, and the remote host never connects back: the session daemon has no fleet address, no fleet credentials, and no outbound control channel. The browser keeps talking to the fleet, so a remote endpoint never has to be exposed to browsers. SSH is how the connection is created and, in the recommended shape, how it is protected.

omp-web creates and manages no TLS for session daemons. The traffic between the fleet and a session daemon is plain HTTP; you protect it with an SSH forward, a private network such as a tailnet or VPN, or a TLS terminator you run yourself.

## The two enrollment shapes

| Shape | Who starts the remote process | How the fleet reaches it | Row mode |
| --- | --- | --- | --- |
| Spawn over SSH | the fleet, which runs an `ssh` command from a spawn template | the endpoint derived from the template's `host` and the session daemon's listening port | `spawned` |
| Register an existing session daemon | you, using a service manager, a terminal multiplexer, or a container on the remote host | the endpoint you pass to `omp-web add` | `remote` |

Both shapes produce an ordinary roster row. Choose the template shape when the fleet should own the remote process lifetime, and the registration shape when the remote process must outlive the fleet, for example because a systemd unit or a container keeps it running.

The forwarded shape looks like this. The tunnel is opened by the fleet host, so the listening end is local to the fleet and the far end is the remote loopback:

```text
fleet host                                         remote host
  omp-web (fleet + browser UI)
    │  ssh -L 4721:127.0.0.1:4721  ─────────────────▶  sshd
    │                                                    │
    └── HTTP to ws://127.0.0.1:4721 ──▶ tunnel ──▶  omp-web session (127.0.0.1:4721)
```

## Prerequisites

- The fleet is running (`omp-web`), because every enrollment command talks to its loopback control plane.
- An SSH login to the remote host that works without interaction. The fleet runs `ssh` with no terminal, so key authentication is required: authorize a key, and use `ssh-agent` or a passphrase-less key for it.
- The remote host key is already known. Connect once by hand (`ssh <ssh-target> true`) so the first connection does not wait on a confirmation prompt that nobody can answer.
- `omp-web` is installed on the remote host and is on the `PATH` of a non-interactive SSH command. The installer links the binary into `~/.bun/bin`, which a non-interactive login shell may not include, so use the absolute path (for example `/home/you/.bun/bin/omp-web`) when unsure.
- `omp` is configured on the remote host with at least one provider and a default model. A session daemon that cannot resolve them never becomes ready.
- The remote and fleet installs speak the same protocol. Run compatible releases on both sides.
- For the template shape, the working directory exists on the fleet host and at the same absolute path on the remote host. See [Spawn over SSH](#spawn-over-ssh) for why both sides matter.

## Spawn over SSH

This shape runs the remote session daemon as a child of the fleet, through the `ssh` client. The fleet then dials the endpoint that the session daemon reports.

### 1. Add a spawn template to the fleet configuration

The fleet reads `~/.omp-web/config.json` at startup, or the file named by the `OMP_FLEET_CONFIG` environment variable. The `templates` object in that file replaces the built-in defaults, so keep a `local` entry alongside the remote one, and restart `omp-web` after editing the file. See [Configure spawn templates](/configuration/spawn-templates/) and the [configuration reference](/reference/configuration/).

The forwarded template below is the recommended starting point. The remote session daemon binds loopback, and the SSH forward makes it reachable on the fleet host's loopback at the same port:

```json
{
  "templates": {
    "local": {
      "command": "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}"
    },
    "ssh-remote": {
      "host": "127.0.0.1",
      "command": "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -L 4721:127.0.0.1:4721 <ssh-target> omp-web session --cwd {cwd} --port 4721 --host 127.0.0.1 --token {token} --name {name} {labels} {resume}"
    }
  },
  "defaultTemplate": "local"
}
```

Replace `<ssh-target>` with the SSH destination, such as `user@box.example.com`. The two template fields and the placeholders work like this:

| Item | Meaning |
| --- | --- |
| `command` | The shell command the fleet runs on the fleet host through `sh -c`. It must start the remote session daemon and let the session daemon's stdout reach the fleet, because that stream carries the startup line. The `ssh` client's own messages and the session daemon's logs go to stderr and are captured for diagnosis. |
| `host` | The reachable host the fleet dials. The endpoint becomes `ws://<host>:<listening port>` unless the wrapper prints an endpoint line of its own. |
| `{cwd}` | The working directory resolved on the fleet host. The fleet spawns the process with it and passes it to this template, so the remote host must have the same directory at the same absolute path. |
| `{token}` | The per-spawn bearer token, minted when the process is launched. |
| `{name}` | The display name of the row. |
| `{labels}` | Repeated `--label k=v` arguments, empty when the row has no labels. |
| `{resume}` | `--resume <last session file>` when the row has one, empty otherwise. On the first spawn it is empty. |

Write placeholders bare, as in the example. The fleet shell-quotes every substituted value itself (paths with spaces, quotes in names, and label values stay one argument); adding your own quotes around a placeholder breaks the value, because the substitution happens before the shell parses the command. Unknown placeholder names are left in the command verbatim, so a typo becomes a visible template bug instead of silent data loss.

The startup contract is one or more lines shaped like this on the session daemon's stdout:

```text
OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}
```

The fleet ignores other stdout lines, but at least one valid line must arrive within 30 seconds, or the spawn fails with `endpoint timeout: no OMP_SESSION| listening line within 30s` and the child is killed. A template may run any shell command, including a wrapper script, as long as the line reaches stdout.

The port is fixed in the template because the fleet derives the endpoint from it. One template therefore serves one remote session daemon at a time; to run a second row on the same host, add a second template with different ports for the forward, the remote bind, and the fleet-side listen.

### 2. Choose how the endpoint is reached

The example above keeps the session daemon on the remote loopback and reaches it through the SSH forward. To dial the session daemon directly instead, bind it to all interfaces and name a host the fleet host can resolve and route. Add an entry like this to the `templates` object:

```json
{
  "ssh-direct": {
    "host": "box.example.com",
    "command": "ssh -o BatchMode=yes -o ConnectTimeout=10 user@box.example.com omp-web session --cwd {cwd} --port 4721 --host 0.0.0.0 --token {token} --name {name} {labels} {resume}"
  }
}
```

- The fleet host must be able to open a TCP connection to `box.example.com:4721`. Open that path in the remote firewall, and do not use this shape over an untrusted network: the bearer token is the only credential and the traffic is plain HTTP unless you terminate TLS in front of the session daemon yourself.
- A non-loopback bind without a token is a startup hard error, which is why `--token {token}` is required here. The fleet always substitutes a fresh value.
- The template `host` must be a name the fleet host resolves. An SSH alias that only your SSH client configuration understands does not resolve, and the endpoint becomes undialable. The `ssh` command's target and the `host` field are independent, so they may differ: `ssh user@box.example.com` with `"host": "box.example.com"`.

When the local forward port cannot equal the remote port, for example because port 4721 is already in use on the fleet host, omit the `host` field and let the session daemon advertise the reachable URL instead:

```json
{
  "ssh-remote-alt": {
    "command": "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -L 14721:127.0.0.1:4721 <ssh-target> omp-web session --cwd {cwd} --port 4721 --host 127.0.0.1 --advertise ws://127.0.0.1:14721 --token {token} --name {name} {labels} {resume}"
  }
}
```

The template's `host` field wins over the session daemon's `--advertise` value, so this variant has none: the fleet dials the advertised `ws://127.0.0.1:14721`, which enters the tunnel and reaches the session daemon on the remote loopback port.

Two options in the `ssh` command are worth keeping. `BatchMode=yes` turns a password or passphrase prompt into an immediate failure instead of a hang, and `ExitOnForwardFailure=yes` stops the command when the forward cannot bind, so the fleet fails loudly instead of dialing whatever else is listening on that local port. `ConnectTimeout=10` fails an unreachable host before the fleet's 30 second endpoint timeout kills the child.

### 3. Spawn the row

```sh
omp-web spawn ~/code/app --template ssh-remote
```

The command prints the new id, name, and status. The row then advances on its own from `connecting` through `session` and `resolving` to `ready`, exactly like a local row; the composer stays gated until the remote session daemon reports that its provider, model, and authentication resolved. See [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) and [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/).

The path must be an existing directory on the fleet host: the control plane validates it and records its real path. That same absolute path is passed to the remote command as `{cwd}`, so the remote host needs a directory at that path, and the session daemon reports it back for the working-directory check. Symlinked paths resolve before the check, so use the same canonical path on both hosts.

To make a project's rows remote by default without passing `--template` each time, add a per-project mapping. The key is the project directory's basename, and spawns that do not name a template (including the sidebar's start action) consult it before the default:

```json
{
  "projectTemplates": { "app": "ssh-remote" }
}
```

The same two-host path rule applies, because the sidebar starts a row on the local project path.

## Register an existing remote session daemon

This shape keeps the remote process independent of the fleet. The fleet never spawns or signals it; waking a row only redials the endpoint.

1. Start the session daemon on the remote host, kept alive by whatever supervises remote processes there, such as a systemd user unit, a container, or a terminal multiplexer:

   ```sh
   omp-web session --cwd /srv/app --port 4721 --host 127.0.0.1 --token "$TOKEN" --name app-remote
   ```

   A loopback bind does not require a token. Set one if the session daemon may ever be reached off loopback, where it becomes mandatory.

2. Keep a forward from the fleet host to the session daemon open, for example:

   ```sh
   ssh -N -L 4721:127.0.0.1:4721 <ssh-target>
   ```

   `-N` opens the forward without running a remote command. The tunnel listens on the fleet host's loopback.

3. Register the endpoint with the running fleet:

   ```sh
   omp-web add app-remote ws://127.0.0.1:4721
   ```

   The URL must be `ws://` or `wss://`; another scheme is rejected. When the session daemon is reached through the tunnel it sees a loopback peer, so no token is needed and passing one is harmless. When you dial an off-loopback session daemon directly, pass `--token` with the same value the session daemon was started with. Omit `--cwd` so the row adopts the directory the session daemon reports; a `--cwd` that does not match the session daemon's reported directory fails the connection with a working-directory mismatch.

A registered row tracks the remote process instead of owning it. Wake, fan-out, and browser attach all redial the endpoint, and the fleet keeps retrying with backoff while the process is down, so a row can sit in `reconnecting` until the remote session daemon starts again. Stop marks the row asleep; the remote process is untouched.

## Endpoint and token configuration

For a spawned session daemon, the fleet resolves the endpoint in this order:

1. The last wrapper `endpoint` line, when the session daemon or its wrapper prints one.
2. The template's `host` field with the session daemon's listening port, as `ws://<host>:<port>`.
3. The session daemon's advertised URL from `--advertise` or `OMP_SESSION_ADVERTISE`.
4. Loopback, `ws://127.0.0.1:<port>`.

The order matters: a template `host` beats the session daemon's advertised URL, so omit `host` when you want the session daemon to name its own reachable address, as in the alternate forward example above. Endpoints are `ws://` or `wss://` shaped; the fleet maps them to `http` or `https` when it dials, and another scheme is rejected when you register an endpoint. Whatever is resolved must be reachable from the fleet host and must land on the session daemon, which is why `ExitOnForwardFailure=yes` is worth keeping in the SSH command.

The bearer token is minted when a process is launched, from 32 random bytes, and it is scoped to that one session daemon:

- A wake or a crash restart gets a fresh token, so a token captured from an earlier process stops working.
- The token is stored in the fleet's state file, and it is never serialized into browser roster frames or the fleet's debug payload. The browser cannot see it.
- It rides the `ssh` command line in the template shape, so it is visible briefly in the remote process list and to anything that can read process state on that host.
- It is the credential of one session daemon, not of the fleet: it opens that one session daemon and nothing else, and each remote session daemon holds only its own token.

For a registered session daemon you supply the token yourself with `omp-web add --token`, and it must match the session daemon's `--token` or `OMP_SESSION_TOKEN` when the session daemon is reachable off loopback. Through an SSH forward the session daemon sees a loopback peer and does not require one.

## Startup, resume, and stop behavior

- **First spawn.** `{resume}` is empty, so the session daemon starts a fresh session in `{cwd}` on the remote host. All session files, including the one created here, live on the remote host under the remote user's agent directory, which is `~/.omp/agent` by default.
- **Wake.** A row click, an attach, or a fan-out prompt wakes an asleep row. A template row runs the same template again with a fresh token and `--resume <last session file>` filled in from the session daemon's last report. Because the command runs on the remote host, that path is the remote host's path and resume works even though the fleet host cannot see the file.
- **Crash and exit.** An unexpected remote exit is restarted a bounded number of times, up to five, with jittered backoff, and each attempt is a new SSH connection with a fresh token. Reaching `ready` resets the budget; exhausting it leaves the row in `error`.
- **Idle exit.** A remote session daemon with nothing attached and nothing running exits by itself after `--idle-timeout`, default 30 minutes; `0` disables it. The fleet marks the row asleep and the next wake resumes.
- **Fleet restart.** Template rows come back asleep, because their `ssh` children died with the fleet, and a wake respawns them over SSH. Registered rows come back `connecting` and are redialed; the fleet never starts the remote process itself.
- **Stop.** Stop terminates the local `ssh` child, first with SIGTERM and then with SIGKILL after five seconds, and marks the row asleep. It sends no signal to the remote process, and the remote session daemon can outlive the connection teardown. It keeps holding its session file lock until it exits, so a wake during that window can collide with it. If you need the remote process to end with the SSH connection, give it a remote-side lifecycle, such as a systemd unit you stop yourself or a wrapper, or use a shorter `--idle-timeout` in the template. A long-lived process under a service manager is usually better served by the [registration shape](#register-an-existing-remote-session-daemon).
- **What the roster reads.** The row's Git facts and the transcript picker read the fleet host's disk. A template row points at a directory that exists on both hosts, so those details describe the fleet host's copy, and the picker does not list the remote host's sessions. Wake the row, which resumes the transcript the session daemon itself last reported, instead of choosing a different transcript from that list.

## Security: what omp-web enforces and what is yours

omp-web enforces the connection model:

- The fleet is always the dialing side. A session daemon never connects out, holds no fleet address, and has no fleet credentials.
- A session daemon refuses to start on a non-loopback address without a token, so an off-loopback session daemon is never unauthenticated.
- Tokens are per launch and per session daemon, and they never appear in browser roster frames or the debug payload.
- A remote session daemon holds only its own token, so one leaked credential cannot be used against another session daemon or the fleet's control plane.

Deployment responsibilities stay with you:

- **SSH access control.** Your keys, `authorized_keys`, host key verification, and any `sshd` restrictions decide who may run the command on the remote host. That is sshd configuration, not omp-web behavior. The fleet only supplies a command to run with your credentials.
- **Transport protection.** omp-web terminates no TLS and manages no certificates. Protect the path with the forward, a private network, or a terminator you run. If you dial a session daemon port directly, the bearer token is the only credential on plain HTTP.
- **Secret hygiene.** The token appears on the remote command line for the life of the process, and the fleet persists it in its state file next to its configuration (`~/.omp-web/fleet-state.json` by default). Treat process state on the remote host and the fleet's data home as sensitive.
- **The remote host's own data.** Provider credentials, the agent directory, and the session transcripts live on the remote host. Back them up and protect them there; the fleet holds no agent state for any row.

## Failure diagnosis

Start by running the SSH command yourself, outside the fleet, with the placeholders filled in:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 user@box.example.com \
  omp-web session --cwd /home/you/code/app --port 4721 --host 127.0.0.1 \
  --token test-token --name app-manual
```

A working run prints the `OMP_SESSION|` line on stdout and `omp-session listening on http://localhost:4721` on stderr, then keeps running until you stop it with Ctrl+C. Any prompt, `command not found`, bind error, or lock error appears there instead of in the browser.

Then use the surfaces that carry the row's details:

- **Daemon details** in the sidebar shows the status reason and captured stderr for a row the fleet spawned. That capture includes the `ssh` client's own errors and the remote session daemon's stderr, because both flow back over the SSH channel. A registered row has no captured output.
- `omp-web sessions` lists every row with its mode and status, and the fleet's terminal prints lifecycle lines such as the spawn template, endpoint, exit code, and restart attempts.
- The Debug panel shows the connector state, attempt count, and endpoint host per row, plus the fleet log. See [Troubleshooting](/operations/troubleshooting/).

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Error `endpoint timeout: no OMP_SESSION\| listening line within 30s` | The command never produced a valid startup line within 30 seconds: SSH is waiting on a prompt, `omp-web` is not on the remote non-interactive `PATH`, the command writes its output elsewhere, or the remote port is already in use. | Run the command by hand and fix what stderr reports. Keep stdout for the startup line. |
| The row stays in `connecting` or `reconnecting` | The fleet cannot reach the endpoint: a forward is missing or dead, a firewall blocks the direct port, or the template `host` does not resolve from the fleet host. | Test from the fleet host. A direct-dial session daemon reached without a token answers `401 Unauthorized`, for example `curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://box.example.com:4721/events`; a refusal or timeout means the path is blocked. For the forward shape, run the same check against `127.0.0.1:4721`: the tunnel is up when it reaches the session daemon and refused when it is not. |
| Error `unauthorized (401): daemon rejected the token` | The session daemon holds a different token than the fleet, usually because the template hardcodes a literal value instead of `{token}`. | Use the `{token}` placeholder, restart the fleet if you edited the template, then stop and wake the row so a fresh token is minted. A 401 is terminal; the connector stops redialing until the credential changes. |
| Error `cwd mismatch: omp-session reports <remote path>, registered <local path>` | The directory reported by the session daemon differs from the path the fleet recorded, for example through different symlinks or a different layout. | Use the same canonical path on both hosts, or register the session daemon with `omp-web add` and no `--cwd` so the reported directory is adopted. |
| Spawn fails with `not a directory: <path>` | The control plane validates the path on the fleet host and it does not exist there. | Create the directory on the fleet host, or use the registration shape when only the remote host has the checkout. |
| The row stays on `resolving provider/model` | The remote host has no usable provider or default model. | Configure `omp` on the remote host, then stop and wake the row. |
| Error `proto mismatch: daemon speaks OMP_PROTO <n>, expected <m>` | The remote install is a different protocol version than the fleet. | Update both sides with `omp-web update`, then restart or wake the row. Retrying cannot fix a version mismatch. |
| Wake errors with `omp-session: session file <file> is locked by another omp-session (pid <pid>)` | The previous remote session daemon can still be running: a stop or a dropped connection ends the local `ssh` client, and the remote process can outlive it. The new process refuses to resume a transcript that is still locked. | Terminate the old process on the remote host, or let it idle out, then wake the row again. |
| The remote session daemon exits with `omp-session: refusing to bind non-loopback address "0.0.0.0" without a token` | The template dropped `--token {token}` on an off-loopback bind. | Put the placeholder back. |
| A template edit appears to do nothing | The fleet reads its configuration once at startup. | Restart `omp-web`. |
| Spawn fails with `unknown spawn template: <name>` | The name is not in the loaded configuration, often because the file's `templates` object replaced the defaults and the name you rely on was not carried over. | Keep every template name you use in the file, then restart the fleet. |

## Related

- [Remote and advanced](/advanced/)
- [Configure spawn templates](/configuration/spawn-templates/)
- [Local and remote sessions](/concepts/local-and-remote/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [Operate session daemons from the CLI](/cli/session-daemon-operations/)
- [Run session daemons in Docker](/advanced/docker/)
- [Security model](/operations/security/)
- [Troubleshooting](/operations/troubleshooting/)
