---
title: Integrate a custom provider
description: Provision session daemons on your own infrastructure with a spawn hook that satisfies the fleet enrollment contract.
---

A provider wrapper is a script the fleet runs to start a session daemon somewhere the built-in spawn templates do not cover, then report a reachable endpoint and the token that gates it. The whole handshake is one JSON object on the last line of the wrapper's stdout.

If the SSH or Docker path already fits, use those guides instead. A custom provider is for topologies such as a cloud VM, a scheduler, or a sandbox service that needs its own API call.

## Prerequisites

- A running fleet: `omp-web` (bare) or `omp-web serve`. `omp-web provision` talks to the fleet control plane on loopback, port 4722 by default.
- A wrapper script that can start a session daemon in the target environment. The target must have `omp-web` installed so `omp-web session` is available, and the agent provider credentials it needs.
- A reachable address for the session daemon. Connection is dial-in: the fleet connects to the session daemon, which never dials out and never learns the fleet's address, state file, or credentials.
- For any non-loopback bind, a token. `omp-web session` refuses to bind a non-loopback address without `--token`, so the wrapper mints one and passes it along.

## How provisioning works

1. You run `omp-web provision <name> [--label k=v]...`. The command posts to `/ctl/provision` on the running fleet.
2. The fleet runs the configured `spawnHook` string through `sh -c`, inheriting the fleet environment plus two variables:
   - `OMP_HOOK_NAME` is the requested session daemon name.
   - `OMP_HOOK_LABELS` is the comma-joined label list (an empty string when you pass no `--label`).
3. The hook may take up to 60 seconds. On timeout the fleet sends `SIGKILL` and provisioning fails.
4. The hook's last non-empty stdout line must be a JSON object: `{ "name"?, "url", "token", "cwd"? }`. Everything else on stdout is ignored; write diagnostics to stderr.
5. The fleet registers the result as a remote roster entry and dials it immediately. The session daemon then appears in the fleet sidebar under its project, with `--label` values attached to the entry. The wrapper can forward `OMP_HOOK_LABELS` to the session daemon as repeated `--label k=v` flags when you want the session daemon itself to carry them.

The fleet stores the token in its state file (default `~/.omp-web/fleet-state.json`, next to the config file) and presents it on every dial. Tokens and endpoints are never serialized into the browser roster.

## Configure the hook

Set `spawnHook` in `~/.omp-web/config.json`:

```json
{
  "spawnHook": "/home/you/providers/sandbox.sh"
}
```

Or set `OMP_FLEET_SPAWN_HOOK`, which wins over the config file value:

```sh
export OMP_FLEET_SPAWN_HOOK=/home/you/providers/sandbox.sh
```

Notes:

- The value is a shell command string, run via `sh -c`. A path is the common case; a leading `~` in the config file value is expanded by the fleet.
- The fleet loads its configuration when it starts, so restart it after changing the hook. If the fleet was started before the config existed, the hook is unset for that process.
- Make the script executable. `sh -c "<path>"` cannot run it otherwise.
- With no hook configured, `omp-web provision` fails with `no spawn hook configured` (HTTP 400).

The hook is a different mechanism from spawn templates: templates run a command line that the fleet fills with `{cwd}`, `{token}`, `{name}`, `{labels}`, and `{resume}` placeholders, and the fleet supervises the child process. A provider hook encapsulates all of that itself and returns a dial-in endpoint instead. See [Configure spawn templates](/configuration/spawn-templates/) for the template path.

## The enrollment contract

The wrapper must satisfy all of the following.

| Requirement | Detail |
| --- | --- |
| Output line | Last non-empty stdout line is one JSON object. Lines after it would replace it, so do not print anything else to stdout after the handshake. |
| `url` | Required, non-empty string. Must be a `ws://` or `wss://` URL. The fleet rejects anything else, including `http://`. |
| `token` | Required, non-empty string. The bearer token that gates this session daemon on every request. |
| `name` | Optional. Overrides the requested name for the roster entry. When omitted, the entry uses the name from `omp-web provision`. |
| `cwd` | Optional. When present it must equal the directory the session daemon was started with. The fleet compares it against the cwd the session daemon reports and parks the entry in `error` with `cwd mismatch: ...` when they differ. When omitted, the fleet adopts the reported cwd. |
| Exit code | Zero. A non-zero exit fails provisioning and the fleet appends the last stderr line to the error. |
| Lifetime | The session daemon must survive the hook's exit; the fleet dials as soon as the hook exits. Detach it (for example with `nohup` or a service manager) instead of running it in the foreground. |
| Secrets | Print the token exactly once, in the final JSON line. Do not echo it to the log you keep for diagnostics. |

Failure handling is uniform: a hook that exits non-zero, times out, prints an unparseable last line, or omits `url` or `token` fails the request with HTTP 502 and a message naming the reason. The CLI renders it as `fleet error (502): <reason>`.

The `cwd` value controls roster grouping: the entry's project is the basename of `cwd`. If your provider should appear under a project name, report the same directory the session daemon runs in.

## Example: a wrapper that starts a session daemon

The wrapper below starts the session daemon, parses its listening line, and prints the enroll handshake:

```sh
#!/usr/bin/env bash
# Providers: start a session daemon for the requested name, then hand the
# fleet { name, url, token, cwd } as the last stdout line.
set -euo pipefail

NAME="${OMP_HOOK_NAME:-}"
LABELS="${OMP_HOOK_LABELS:-}"        # comma-joined k=v; this wrapper does not forward them
CWD="${OMP_PROVIDER_CWD:-$HOME}"     # where the session daemon should run; set per provider

# Mint the bearer token for this session daemon only (32 random bytes, URL-safe base64).
TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
[ -n "$TOKEN" ] || { echo "provision: failed to mint token" >&2; exit 1; }

# Start the session daemon in the background so it outlives this script, and parse
# its OMP_SESSION| listening line for the endpoint.
LOG="$(mktemp)"
nohup omp-web session --cwd "$CWD" --port 0 --host 127.0.0.1 \
  --token "$TOKEN" --name "$NAME" >"$LOG" 2>&1 &

URL=""
for _ in $(seq 1 100); do # up to ~50s; the fleet allows 60s total
  LINE="$(grep '^OMP_SESSION|' "$LOG" | head -n1 || true)"
  if [ -n "$LINE" ]; then
    URL="$(printf '%s' "${LINE#OMP_SESSION|}" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
    [ -n "$URL" ] && break
  fi
  sleep 0.5
done
[ -n "$URL" ] || { echo "provision: daemon never reported an endpoint" >&2; exit 1; }

# JSON-escape a string minimally (skeleton-grade; fine for names and paths).
json_str() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r//g' -e 's/\n/\\n/g'
}

# Last non-empty stdout line: the enrollment contract.
printf '{"name":"%s","url":"%s","token":"%s","cwd":"%s"}\n' \
  "$(json_str "$NAME")" "$(json_str "$URL")" "$(json_str "$TOKEN")" "$(json_str "$CWD")"
```

Then provision and watch the result:

```sh
omp-web provision sandbox
```

The command prints the new session daemon's id and its initial status, and the fleet sidebar shows the entry under the project derived from `cwd`. The entry leaves `connecting` once the handshake and its cwd check pass, and reaches `ready` when the session daemon finishes resolving its provider and model; you can then prompt it like any other session daemon.

To replace the example's local session daemon with a remote one, replace only the start block: run the session daemon over SSH, in a container, or through your provider's API, and keep the JSON handshake unchanged. The endpoint you report must be reachable from the fleet host. See [Run a remote session daemon over SSH](/advanced/ssh/) and [Run session daemons in Docker](/advanced/docker/) for those two setups.

## How the fleet supervises a provisioned session daemon

A provisioned session daemon is registered as a remote entry. The fleet supervises the connection, not the process:

- Immediately after the hook exits, the fleet dials the endpoint and presents the token. A dial that never opens moves the entry to `reconnecting` with jittered exponential backoff (1 second up to 30 seconds) and keeps retrying.
- A stream that ends cleanly after a validated handshake marks the entry `asleep`, which the demo session daemon reaches through its idle auto-exit (`--idle-timeout` defaults to 30 minutes). A stream that ends in error reconnects.
- A rejected token is terminal: the entry moves to `error` with `unauthorized (401): daemon rejected the token`, with no reconnect loop. Provision again to mint a fresh credential, or remove the stale entry.
- Waking a sleeping remote entry from the roster redials it. There is no respawn, because the fleet cannot launch a process on another host, and the hook contract has no resume arguments. Stopping a remote entry disconnects it and marks it `asleep`; removing it drops the registry entry and connection state. Neither action touches the process on the provider side.
- Entries persist in the fleet state file. After a fleet restart, remote entries go back to `connecting` and redial immediately, even while the provider is still down.
- If the remote process exits and nothing restarts it, the entry sits in `reconnecting` forever. Tie the session daemon to a lifecycle that can restart it (a systemd unit, a container with a restart policy, or a service your provider can relaunch), or run it with `--idle-timeout 0` when you want it to stay up.

Because each `omp-web provision` call registers a new entry, provisioning the same name twice leaves two entries. Remove the old one with `omp-web remove <selector>` after the new one is healthy.

## Resume behavior

The hook contract carries no resume information: unlike a spawn template, there is no `{resume}` placeholder and the hook receives only `OMP_HOOK_NAME` and `OMP_HOOK_LABELS`. Two consequences:

- Each provision call starts a fresh session daemon process, and the fleet never passes `--resume` on your behalf.
- Session continuity lives with the session daemon. Transcripts are stored on the provider side, outside the hook, and the fleet records the session daemon's current session file from the handshake. The session daemon lists sessions scoped to its own working directory, and you resume one through the connection to the running session daemon, so restarting it does not lose transcripts. A wrapper that must boot directly into a specific transcript can pass `--resume <file>` to `omp-web session` itself; the fleet then adopts the reported session file.

## Tokens, endpoints, and secrets

Application guarantees:

- `omp-web session` mints nothing by itself: the wrapper (or the fleet, for templates) mints the token, and the session daemon enforces it. Off-loopback peers must present it; a non-loopback bind without any token is a startup hard error.
- Each provisioned session daemon gets its own token that gates only that session daemon. Nothing in the target environment holds another session daemon's token or any fleet credential.
- The fleet keeps the token in the fleet state file and never sends endpoints or tokens to browsers.

Deployment responsibilities:

- Protect the fleet state file. It holds every session daemon credential on the fleet host; restrict it like any other secret store.
- Protect the transport. Connect over SSH forwarding, a private tailnet, or user-managed TLS terminated in front of the session daemon. `wss://` endpoints are accepted so you can front the session daemon with your own TLS terminator; omp-web does not terminate TLS for the session daemon or issue certificates. Prefer a loopback bind with a tunnel over an exposed port.
- Assume that anyone who can reach the endpoint and holds the token can drive the session. On the provider host the token appears in the session daemon's command line and in whatever job or unit definition starts it, so restrict process-list and job inspection access there.
- Treat diagnostics as public. Anything written to the session daemon's log or your wrapper's stderr may end up in shared tooling, so keep tokens out of it.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no spawn hook configured` | The fleet has no `spawnHook` for this process, or the fleet predates the config edit. | Set `spawnHook` or `OMP_FLEET_SPAWN_HOOK`, then restart the fleet. |
| `spawn hook timed out after 60s` | The wrapper did not exit within the deadline; it was killed. | Do not wait for the session daemon to become fully ready in the hook. Start it, read the endpoint line, exit. |
| `spawn hook exited <n>: <last stderr line>` | The script failed. | Run the wrapper by hand with `OMP_HOOK_NAME` set to reproduce, and check that last stderr line. |
| `spawn hook stdout is not valid JSON: <line>` | The last non-empty stdout line is not the JSON object, usually a stray `echo` or an uncaptured subprocess writing to stdout. | Send all diagnostics to stderr and leave stdout for the handshake alone. |
| `spawn hook output missing url or token` | A required field is absent or empty. | Check the final `printf` and that the endpoint line was parsed before it ran. |
| `url must be ws:// or wss://: <url>` | The endpoint used an `http://` or malformed URL. | Report a `ws://` or `wss://` URL. The session daemon's own listening line already is one. |
| Entry parks in `error` with a `cwd mismatch` message naming both directories | The hook's `cwd` does not match the directory the session daemon actually runs in. | Omit `cwd` to let the fleet adopt the session daemon's value, or align the two. |
| Entry stuck in `connecting` or `reconnecting` | The endpoint is not reachable from the fleet host, for example a loopback or container-internal address, or a firewall blocks it. | Parse a reachable URL, bind or publish accordingly, and verify from the fleet host. |
| `unauthorized (401): daemon rejected the token` | The session daemon expects a different token, typically a stale entry from an earlier provision. | Remove the stale entry and provision again so a fresh token and session daemon pair up. |
| Two entries for one session daemon | `omp-web provision` registers a new entry on every call. | Remove the old entry with `omp-web remove <selector>`. |
| The CLI reports that the fleet is not running | No fleet control plane is listening on the CLI's port (4722 by default). | Start the fleet with bare `omp-web` or `omp-web serve`, then retry, or point the CLI at the right port. |

For connection-status meanings across the roster, see [The fleet sidebar](/fleet/sidebar/); for fleet-wide recovery steps, see [Troubleshooting](/operations/troubleshooting/).

## Related pages

- [Run a remote session daemon over SSH](/advanced/ssh/)
- [Run session daemons in Docker](/advanced/docker/)
- [Configure spawn templates](/configuration/spawn-templates/)
- [Security model](/operations/security/)
- [CLI overview](/cli/overview/)
- [Configuration reference](/reference/configuration/)
- [Environment variables and precedence](/reference/environment/)
- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
