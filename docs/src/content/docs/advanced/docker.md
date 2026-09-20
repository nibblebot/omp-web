---
title: Run session daemons in Docker
description: Spawn containerized session daemons from the fleet with the Docker spawn template, publish a dial-in port on the host, and keep the checkout and agent data on mounted paths.
---

A spawn template can run each session daemon inside a Docker container instead of directly on the fleet host. The fleet owns the lifecycle exactly as it does for a local session daemon, and the connection is still dial-in: the fleet initiates the connection to the containerized session daemon over a published host port, and the container never connects back to the fleet.

This page gives you the wrapper that starts the container, publishes its port, and reports the reachable endpoint, then covers the image contract and the persistence and host path rules that make containerized rows work.

Mode note: this is a fleet setup. The spawn template belongs to the fleet's configuration, and containerized rows appear in the same roster as local ones. Docker does not change sessions, transcripts, or the browser workflow.

## Prerequisites

- A running fleet with at least one registered project. See [First run](/getting-started/first-run/) and [Add your first project](/getting-started/add-first-project/).
- Docker Engine on the fleet host with a CLI that can run containers, stream container logs, and read published ports. The wrapper calls `docker run`, `docker logs -f`, and `docker port`.
- Bash on the fleet host. The wrapper is a Bash script and uses `set -euo pipefail`.
- The wrapper script below saved at an absolute path that will not move, because the spawn template embeds that path.
- An image that can start a session daemon, plus a provider and default model available to the session daemon inside the container. Prompts fail without them, exactly as they do locally; see [Start your first session](/getting-started/start-first-session/).

## What the image must provide

The wrapper runs the container with this command:

```sh
docker run --rm -d --name "$CID" -p "$PORT_SPEC" \
	-v "$CWD:$CWD" -w "$CWD" \
	"$IMAGE" \
	omp-web session --cwd "$CWD" --port "$OMP_SESSION_PORT" --host 0.0.0.0 \
	--token "$TOKEN" --name "$NAME" "$@" >/dev/null
```

That fixes the image contract:

- **The container command must exist.** The wrapper invokes `omp-web session` inside the image, so the image must put the installed CLI on the container `PATH` (an `ENV PATH="/root/.bun/bin:$PATH"` line for the default install location) or the wrapper must call it by absolute path. A `docker run` container reads no shell startup files, so the installer's `PATH` export does not apply there. A plain `omp-session` symlink to `omp-web` is not a drop-in either: `omp-web` classifies its first argument, and a bare invocation starts a fleet, so such an alias has to be a wrapper script that runs `omp-web session "$@"`. See [Installation](/getting-started/installation/) and [Run a standalone session daemon](/cli/standalone/).
- **The session daemon must run in the foreground and log to the container stdout.** The wrapper streams container output with `docker logs -f` and expects the `OMP_SESSION|` contract lines on that stream. An image whose entrypoint daemonizes the process, redirects its stdout elsewhere, or exits immediately breaks endpoint resolution.
- **The image needs the runtime and the agent's tooling.** The installed bundle runs under Bun, and the agent's Bash, edit, and eval tools execute inside the container, so git, editors, and the project's own toolchain must exist there.
- **The container needs network egress to the model provider.** The agent runs in-process in the session daemon, so provider calls originate from the container, not from the fleet host. A container without egress reaches a row that cannot complete prompts.
- **Provider authentication and the default model must resolve inside the container.** The wrapper forwards no host environment variables and mounts only the workspace. The session daemon reads its agent directory inside the container (the SDK default is `~/.omp/agent` for the container user; `PI_CODING_AGENT_DIR` moves it). Bake that state into the image, or mount it from the host as shown under [Persistence and resume](#persistence-and-resume).
- **The image reference is configurable.** The wrapper below defaults to the placeholder `your-registry/omp-session:latest` and reads `OMP_SESSION_IMAGE` first, so either publish under that environment variable or edit the `IMAGE` default. `docker run` pulls the image when it is not present locally.

There is no Dockerfile in the repository; building and publishing the image is your step.

## The wrapper

The wrapper below starts one container per session daemon, streams the container's stdout so the fleet sees its `OMP_SESSION|` lines, and reports the published host port as an endpoint line:

```sh
#!/usr/bin/env bash
# One container per session daemon. The fleet runs this script from a spawn
# template as: docker-omp-session.sh <cwd> <token> <name> [args...]
set -euo pipefail

CWD="$1"
TOKEN="$2"
NAME="$3"
shift 3

# Point OMP_SESSION_IMAGE at your image; it must have the omp-web CLI on PATH.
IMAGE="${OMP_SESSION_IMAGE:-your-registry/omp-session:latest}"
OMP_SESSION_PORT=4721                  # container-internal port (fixed)
HOST_PORT="${OMP_SESSION_HOST_PORT:-}" # optional explicit published host port

CID="omp-session-$(printf '%s' "$NAME" | tr -c 'a-zA-Z0-9_.-' '_')-$OMP_SESSION_PORT-$$"

cleanup() {
	docker rm -f "$CID" >/dev/null 2>&1 || true
}
trap cleanup EXIT TERM INT

if [ -n "$HOST_PORT" ]; then
	PORT_SPEC="127.0.0.1:$HOST_PORT:$OMP_SESSION_PORT"
else
	# Let docker pick a free host port, then discover it below.
	PORT_SPEC="127.0.0.1::$OMP_SESSION_PORT"
fi

docker run --rm -d --name "$CID" -p "$PORT_SPEC" \
	-v "$CWD:$CWD" -w "$CWD" \
	"$IMAGE" \
	omp-web session --cwd "$CWD" --port "$OMP_SESSION_PORT" --host 0.0.0.0 \
	--token "$TOKEN" --name "$NAME" "$@" >/dev/null

if [ -z "$HOST_PORT" ]; then
	# `|| true`: without it, set -e plus pipefail aborts here before the guard
	# below can name the failure (docker port fails once the container is gone).
	HOST_PORT="$(docker port "$CID" "$OMP_SESSION_PORT/tcp" | sed 's/.*://' || true)"
	[ -n "$HOST_PORT" ] || { echo "docker: no published port for $CID" >&2; exit 1; }
fi

# Stream the container's stdout so its listening line reaches the fleet.
docker logs -f "$CID" &
LOGS_PID=$!

# The container's own url (ws://0.0.0.0:4721) is not dialable from the host,
# so report the published port. The fleet prefers this endpoint line.
printf 'OMP_SESSION|%s\n' "{\"event\":\"endpoint\",\"url\":\"ws://127.0.0.1:$HOST_PORT\"}"

wait "$LOGS_PID"
```

It receives `<cwd> <token> <name>` from the spawn template and passes every trailing argument, which is where the fleet inserts `{labels}` and `{resume}`, verbatim to the session daemon inside the container.

1. **Container.** `docker run --rm -d` starts a detached container named `omp-session-<name>-4721-<pid>`. `--rm` and a cleanup trap on `EXIT`, `TERM`, and `INT` remove the container when the wrapper exits.
2. **Ports.** `--port 4721` is the fixed container-internal port. The default publish spec is `127.0.0.1::4721`, which asks Docker for a free host port bound to host loopback. Setting `OMP_SESSION_HOST_PORT` pins an explicit host port instead. The wrapper discovers the assigned port with `docker port`.
3. **Endpoint.** `docker logs -f` streams the container's stdout, including the session daemon's `OMP_SESSION|{"event":"listening",...}` line. Alongside that stream, the wrapper prints its own line:

   ```text
   OMP_SESSION|{"event":"endpoint","url":"ws://127.0.0.1:<published port>"}
   ```

   The fleet's endpoint resolution requires a `listening` line and prefers the last wrapper `endpoint` line, so it dials the published host port rather than the container-internal `ws://0.0.0.0:4721` from the listening line. That is the whole point of the wrapper: the container cannot know the host port it was published on.
4. **Quiet stdout.** `docker run -d` prints the container id, which is redirected to `/dev/null` so only contract lines reach the fleet's stdout parser.

## Configure the spawn template

### 1. Save the wrapper and pick the image

Save the script above at an absolute path that will not move, for example `/opt/omp-web/docker-omp-session.sh`, make it executable, and export the image it runs:

```sh
chmod 755 /opt/omp-web/docker-omp-session.sh
export OMP_SESSION_IMAGE=registry.example.com/you/omp-session:latest
```

The wrapper reads `OMP_SESSION_IMAGE` and `OMP_SESSION_HOST_PORT` from its environment, and the fleet passes its own environment to spawn commands, so export these in the shell that starts the fleet. A fleet that is already running keeps the environment it was started with.

### 2. Add the template to the fleet config

The `docker` entry points at the script's absolute path:

```json
{
	"templates": {
		"docker": {
			"command": "/opt/omp-web/docker-omp-session.sh {cwd} {token} {name} {labels} {resume}"
		}
	},
	"defaultTemplate": "local"
}
```

Placeholders stay bare. The fleet shell-quotes each substituted value before the command runs, so wrapping a placeholder in quotes of your own passes the quote characters through to the wrapper as part of the argument.

Merge that `templates.docker` object into the fleet config (by default `~/.omp-web/config.json`; `OMP_FLEET_CONFIG` points elsewhere). A working merged file looks like this:

```json
{
	"templates": {
		"local": {
			"command": "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}"
		},
		"docker": {
			"command": "/opt/omp-web/docker-omp-session.sh {cwd} {token} {name} {labels} {resume}"
		}
	},
	"defaultTemplate": "local"
}
```

Rules that the merge must respect:

- The config file is shallow-merged over the built-in defaults, and a file `templates` object replaces the whole built-in map. A file that defines only `docker` removes the built-in `local` template, and a `"defaultTemplate": "local"` then resolves to nothing. Keep a `local` entry as above, or point `defaultTemplate` at `docker`. A `templates` object that fails validation, such as a template without a `command` string, makes the loader fall back to the built-in map instead, which also leaves `docker` undefined.
- Keep the `workspaceDir` key if your file already has one. First run writes it when you choose a data home, and dropping it falls back to `~/.omp-web/workspaces`.
- The config is read once at fleet start. Restart the fleet after editing it (`Ctrl+C`, then run `omp-web` again).

### 3. Know the placeholders

The template is filled per spawn. The Docker-relevant behavior:

- `{cwd}` is the realpath of the spawned directory after the fleet validates it, and it is the path the container must mount and pass to `--cwd`.
- `{token}` is a fresh bearer token minted for this spawn attempt.
- `{name}` is the roster name, which defaults to the directory's basename.
- `{labels}` expands to zero or more `--label k=v` arguments, empty when the entry has no labels.
- `{resume}` expands to `--resume <session file>` on a wake or resume spawn, and is empty on a first spawn.

The fleet shell-quotes every value before substitution, so every placeholder is written bare: `{cwd}`, `{token}`, and `{name}` arrive as single-quoted shell words, and `{labels}` and `{resume}` expand to complete, already-quoted shell arguments. Adding your own quotes around any placeholder passes the quote characters through to the wrapper as part of the value. An unknown placeholder is left verbatim, which is a template bug rather than a silent empty value. [Configure spawn templates](/configuration/spawn-templates/) owns the full placeholder table and resolution rules.

The optional `host` template field exists for templates whose reachable address differs from the bind; the Docker wrapper above does not use it because it prints an endpoint line.

### 4. Choose the template per spawn

Template resolution is first match wins: an explicit `--template` flag, then `projectTemplates[basename(cwd)]`, then `defaultTemplate`.

- `omp-web spawn <path> --template docker` and `omp-web add-repo <path> --start --template docker` select Docker explicitly. `omp-web add-worktree` has no template flag, so linked worktrees follow the other two tiers.
- `projectTemplates` maps a spawned directory's basename to a template name. For a main checkout that is the repository directory name; for a managed worktree it is the worktree directory name.
- Set `"defaultTemplate": "docker"` to make every spawn containerized.

[Configure spawn templates](/configuration/spawn-templates/) keeps the full config schema, and [CLI commands and flags](/reference/cli/) lists the exact flags.

## Start a containerized session daemon

```sh
omp-web spawn /home/you/repos/example --template docker
```

To register the project and start it in one step:

```sh
omp-web add-repo /home/you/repos/example --start --template docker
```

Expected result:

- The command prints the new daemon id, name, and starting status. The fleet is contacted over its loopback control port (`4722` unless `--port` or `OMP_FLEET_PORT` says otherwise).
- A container named `omp-session-example-4721-<pid>` appears in `docker ps`, and the wrapper is streaming its logs.
- A row appears in the fleet sidebar and climbs through spawning, connecting, and resolving to ready. Click it to attach the browser and prompt as usual; [Start your first session](/getting-started/start-first-session/) describes the sequence.
- `omp-web sessions` lists the row from the terminal with its id, name, mode, status, project, cwd, and labels. `omp-web prompt dN "..."` wakes and prompts it.

If the fleet is not running, the CLI reports that and exits nonzero; start `omp-web` (a bare invocation runs the fleet) and retry.

## Run a long-lived container instead

If you would rather manage the container yourself (Compose, systemd, or a host that is always up), start it with a published port and a token of your choosing, then register it as an external entry:

```sh
omp-web add my-container ws://127.0.0.1:49153 --token <token> --cwd /home/you/repos/example
```

The fleet dials an external entry but never spawns, restarts, or removes its container, and waking redials the endpoint instead of running the wrapper, so a stopped container stays unreachable. If you want the session daemon to keep serving prompts around the clock, disable its idle auto-exit (`--idle-timeout 0`, or `OMP_SESSION_IDLE_TIMEOUT=0` in the container environment) and mount the agent directory so transcripts survive a container replacement. [Run a remote session daemon over SSH](/advanced/ssh/) covers the same registration for a remote host.

## Ports, tokens, and reachability

What omp-web guarantees:

- The fleet mints a fresh bearer token per spawn attempt and passes it to the wrapper. The token gates only that one session daemon.
- A non-loopback bind without a token is a startup error inside the session daemon (`omp-session: refusing to bind non-loopback address "0.0.0.0" without a token; pass --token or set OMP_SESSION_TOKEN`), so the container command as written cannot expose an unauthenticated endpoint.
- The fleet keeps tokens and endpoints out of browser roster frames and debug snapshots.
- The fleet always sends the token when it dials the session daemon, so the check passes regardless of how Docker presents the connection's source address. Direct local processes on the loopback interface are exempt from the token check; the token is what matters as soon as the port is reachable from anywhere else.

What remains your responsibility:

- **Docker socket access is privileged.** The token is part of the container's command line, so `docker inspect` shows it for the container's lifetime, and the wrapper process keeps it in its own command line while it runs. Restrict Docker socket access to operators you would trust with the host.
- **Publishing is your choice.** To reach the container from another machine, change the `127.0.0.1` bind address in the wrapper's `PORT_SPEC` to `0.0.0.0`. The port then accepts off-loopback connections, which must present the token; protect that path with SSH forwarding, a private tailnet, or TLS that you terminate yourself. omp-web has no built-in TLS and no user accounts, so the transport is a deployment decision. See [Security model](/operations/security/) and [Networking and browser access](/operations/networking/).
- **Host filesystem protection still matters.** The fleet state file records endpoints and per-spawn tokens on the host, so protect the data home as you would any credential store. See [Files and directories](/reference/files/) and [Data and state management](/configuration/data-and-state/).

## Persistence and resume

A session daemon is disposable and its transcript is durable, but in this setup durability depends on mounts, because the container filesystem is discarded with the container.

- **The checkout survives** because the wrapper bind-mounts it (`-v "$CWD:$CWD"`), so file edits made by the agent are ordinary host file edits.
- **The container does not outlive its session daemon.** When the session daemon exits (idle auto-exit after the default 30 minutes, **Stop daemon** from the row menu, or a fleet stop), `docker logs -f` ends, the wrapper exits, and the trap plus `--rm` remove the container. The fleet marks the row asleep and keeps the working directory and last session file.
- **A wake runs the wrapper again** with `{resume}` filled in when the row has a recorded session file, so the new container starts with `--resume <session file>`. The recorded file is the one the previous container reported in its `hello_ok` handshake.
- **Agent data is not mounted by default.** Transcripts and provider state live in the session daemon's agent directory, which defaults to `~/.omp/agent` inside the container, with session transcripts under its `sessions` directory. Nothing writes those to the host, so a wake cannot read the recorded resume file and the session daemon logs `omp-session: --resume <file> failed (...); starting fresh`. The fleet's session picker reads the fleet host's agent directory, so it can also list transcripts the container cannot open.

To keep resume working, extend the wrapper's `docker run` with an agent directory mount and point the session daemon at it:

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"

docker run --rm -d --name "$CID" -p "$PORT_SPEC" \
	-v "$CWD:$CWD" -w "$CWD" \
	-v "$AGENT_DIR:$AGENT_DIR" \
	-e PI_CODING_AGENT_DIR="$AGENT_DIR" \
	"$IMAGE" \
	omp-web session --cwd "$CWD" --port "$OMP_SESSION_PORT" --host 0.0.0.0 \
	--token "$TOKEN" --name "$NAME" "$@" >/dev/null
```

The mount uses the same absolute path on both sides so the recorded session file path stays valid inside the next container and matches what the fleet host sees. When the fleet itself runs without `PI_CODING_AGENT_DIR`, both sides default to `~/.omp/agent`, so the paths line up without further configuration. If the container runs as a different user than the mount owner, make sure that user can write the agent directory, or the session daemon cannot save transcripts.

Unexpected exits are handled like any other session daemon: up to five consecutive restarts with jittered exponential backoff between about 1 and 30 seconds, each with a fresh token, and after that the row shows an error. Reaching ready resets the restart counter. See [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/) for the full lifecycle.

## Host path implications

The wrapper mounts the spawned directory at its host path inside the container and passes the same value as `--cwd`. That matters because the fleet compares the session daemon's reported working directory with the registered one during the connection handshake: a mismatch fails the row with `cwd mismatch: omp-session reports <container path>, registered <host path>`.

- The fleet validates and realpath-normalizes the spawn path before storing it, so symlinked paths are already resolved when the wrapper receives `{cwd}`.
- If Docker cannot bind the exact host path (for example, a host path that is not shared with the Docker virtual machine), change the mount and `--cwd` together in the wrapper. Changing only one produces the mismatch above, and changing only the mount leaves the session daemon operating on a path the fleet never registered.
- The sidebar's branch name and dirty-file counts come from the fleet's own git probe of the host path, not from container state.
- Managed worktrees live under the workspace directory on the host (`~/.omp-web/workspaces` by default), so they are ordinary host paths and can be mounted the same way. Session transcripts live under the agent directory, never inside a worktree, so deleting a worktree never removes transcripts; see [Safely delete managed worktrees](/fleet/delete-worktrees/).

## Common failures

- `unknown spawn template: docker`: the config file the fleet loaded does not define `docker`, or the fleet was not restarted after the edit. Check the path in use (`~/.omp-web/config.json` unless `OMP_FLEET_CONFIG` overrides it).
- `unknown spawn template: local`: the `templates` object replaced the built-in map and dropped the `local` entry while `defaultTemplate` still points at it. Add `local` back or change `defaultTemplate`.
- `endpoint timeout: no OMP_SESSION| listening line within 30s`: the session daemon never produced a contract line within the fleet's resolution window. Open the row's **Daemon details** for the captured wrapper output, then check the container itself with `docker ps -a` and `docker logs <container>`. Typical causes are an image that cannot run `omp-web session`, an image pull failure, or a container that exits immediately.
- `child exited N times (5 restarts allowed)`: the wrapper keeps failing before a session daemon exists. The captured output in **Daemon details** names the cause, such as `docker: command not found`, a refused connection to the Docker daemon, or `docker: no published port for <container>`.
- A non-loopback bind refusal in the container logs: the `--token` argument was dropped from the container command, usually while editing the wrapper.
- `cwd mismatch: omp-session reports <path>, registered <path>`: the mount path and `--cwd` in the wrapper differ from the registered cwd. Make them equal and wake the row again.
- A wake starts a new session instead of resuming: the wrapped container cannot read the recorded `--resume` path. Confirm the agent directory mount described under [Persistence and resume](#persistence-and-resume); the warning lines appear in **Daemon details** and in `docker logs`.
- `port is already allocated` at spawn time: a pinned `OMP_SESSION_HOST_PORT` is in use. Pick another port or unset the variable so Docker chooses one.
- `session file <file> is locked by another omp-session (pid <pid>)`: two session daemons are resuming the same transcript, for example a local session daemon and a containerized one for the same checkout. A project cannot run both at once on the same session file; stop one row.
- Row ready but prompts fail: the container has no provider or default model, or no egress to the provider. Fix the agent state inside the image or mount, then stop and wake the row. [Troubleshooting](/operations/troubleshooting/) covers the shared symptoms.

## Related

- [Run a remote session daemon over SSH](/advanced/ssh/): the same dial-in model with a remote host instead of a container.
- [Remote and advanced](/advanced/): the connection model and mode boundaries.
- [Configure spawn templates](/configuration/spawn-templates/): the full template schema and resolution order.
- [Security model](/operations/security/): tokens, loopback exemptions, and transport responsibilities.
- [Files and directories](/reference/files/): the agent directory, session transcripts, and the fleet data home.
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/): spawn, ready, idle exit, and recovery states.
