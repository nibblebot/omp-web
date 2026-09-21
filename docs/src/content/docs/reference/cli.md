---
title: CLI commands and flags
description: "Canonical reference for every omp-web command, subcommand, flag, default, output stream, and exit code, including the fleet control plane, the session daemon, self-update, and the collaboration script."
---

`omp-web` is one installed command that covers three kinds of work:

- **The fleet:** bare `omp-web` or `omp-web serve` starts the fleet (registry, session daemon supervisor, and the web UI on one loopback port).
- **A session daemon:** `omp-web session` runs one session daemon, bound to one directory and serving the wire API for one live agent session. It serves no web UI.
- **Clients:** the fleet verbs are short-lived requests to a running fleet, `preflight` validates a provider profile in its own process, and `update` maintains the installation from the release channel.

Task guides such as [CLI overview](/cli/overview/) explain when to use which verb. This page owns the signatures, flags, defaults, outputs, and exit codes.

## Invocation and dispatch

| First argument | Routes to |
| --- | --- |
| none (bare `omp-web`) | `serve` |
| `serve`, `sessions`, `projects`, `profiles`, `spawn`, `add-repo`, `add`, `provision`, `add-clone`, `start`, `stop`, `remove`, `rm-project`, `add-worktree`, `rm-worktree`, `prompt` | fleet control plane, over the control port |
| `preflight` | fleet control plane, run locally in this process |
| `session` | session daemon |
| `update` | self-update |
| `--version` or `version` | version print |
| anything else, including `--help` and `help` | usage summary on stderr, exit 1 |

The verb must be the first argument; flags follow it. The installed entrypoint has no help command that exits 0: `omp-web --help`, `omp-web help`, and any unknown first argument print the usage summary on stderr and exit 1. In a source checkout, `bun run fleet` or `bun run fleet -- help` prints the fleet usage to stdout and exits 0.

Fleet verbs other than `serve` and `preflight` are loopback clients of the running fleet. They connect to `127.0.0.1` on the control port and exit when the request finishes. The fleet must be running first; there is no auto-start and no queueing. `preflight` is the exception: it reads the config file in its own process and never contacts a fleet, so it works while no fleet is running.

## Output streams

| Command | stdout | stderr |
| --- | --- | --- |
| fleet verbs | result lines (tables or one line per action) | parse errors and control-plane errors |
| `serve` | banner lines, then one line per lifecycle transition | shutdown notice, startup errors |
| `session` | one `OMP_SESSION\|` contract line at bind | all human logs and errors |
| `update` | result lines | failures, prefixed `omp-web:` |

`serve` line 1 is `fleet listening on <bind>:<port>` (the default bind is `127.0.0.1`) and `session` prints its contract line before anything else, because spawners parse both. Nothing is written to stdout before a command is selected.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command completed. This includes `update --check`, version printing, `prompt --wait` even when individual targets failed, and `preflight` with every check passing |
| 1 | Usage or flag error, fleet not running, control-plane error, update failure, session daemon startup error, or a `preflight` check that failed |
| 77 | `serve` refused to start because another fleet holds the state file lock |

`serve` and `session` handle `SIGINT` and `SIGTERM` by shutting down cleanly and exiting 0; `session` also handles `SIGHUP`.

## Ports and shared flags

Every fleet verb accepts `--port <n>`, in `--port n` or `--port=n` form. For `serve` it is the bind port; for client verbs it is the connect port.

- Precedence: `--port` flag, then `OMP_FLEET_PORT`, then the default `4722`.
- A numeric value must be an integer from 0 to 65535; `0` on `serve` binds an ephemeral port, and the real port appears in banner line 1.
- A numeric `--port` outside that range, or a non-integer, exits 1 with `invalid --port: <value>`. A non-numeric `--port` value is ignored, so the environment or default applies. An invalid `OMP_FLEET_PORT` exits 1 with `invalid OMP_FLEET_PORT: <value>`.
- `--workspace-dir <dir>` is read by `serve` only; the other fleet verbs accept and ignore it.
- `--bind <addr>`, `--browser-access-token <t>`, `--browser-origin <o>`, and `--trusted-proxy <ip-or-cidr>` are read by `serve` only, and each has a matching environment variable and config key. See [serve](#serve).

Fleet flag parsing rules:

- Flags take a value either as `--flag value` or `--flag=value`.
- `--start`, `--no-start`, and `--delete-branch` are booleans. A bare occurrence means true and never consumes the following argument; `--flag=true` and `--flag=false` are also accepted, and any other value exits 1 with `invalid value for --<flag>: <value>`.
- `--label <k=v>` and `--trusted-proxy <ip-or-cidr>` repeat to accumulate values.
- A value-taking flag with no value, or with a following token that starts with `-`, exits 1 with `missing value for --<flag>` or `invalid value for --<flag>: <value>`. The repeatable `--label` and `--trusted-proxy` are the exceptions: a valueless occurrence is accepted and dropped. For `--trusted-proxy` that is deliberate: the security setting degrades to "no trusted proxies" instead of failing the flag parse.
- Flags a command does not read are accepted and ignored when they carry a value. There is no `--` separator.

Source-checkout note: the same verbs run as `bun run fleet -- <verb> ...`.

## serve

```
omp-web                                  # the fleet
omp-web serve [--port <n>] [--workspace-dir <dir>] [--bind <addr>]
              [--browser-access-token <t>] [--browser-origin <o>]
              [--trusted-proxy <ip-or-cidr>]...
```

Starts the fleet: persistent registry, supervisor for spawned session daemons, connector for remote ones, and the browser UI on the same port. It runs in the foreground until a signal arrives.

```sh
omp-web serve --port 4800 --workspace-dir ~/code/worktrees
omp-web serve --bind 0.0.0.0 --browser-access-token "$(cat ~/.omp-web/operator.token)"
```

Managed-worktree root precedence: `--workspace-dir`, then `OMP_FLEET_WORKSPACE_DIR`, then the config file's `workspaceDir` key, then `~/.omp-web/workspaces`. A leading `~` is expanded. The root is created lazily on the first managed worktree, never at boot.

Bind and browser auth, each resolved as flag, then environment variable, then config key:

| Flag | Environment | Config key | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--bind <addr>` | `OMP_FLEET_BIND` | `bind` | `127.0.0.1` | Address the control plane and the browser edge bind |
| `--browser-access-token <t>` | `OMP_FLEET_BROWSER_TOKEN` | `browserAccessToken` | absent (browser auth off) | Operator access token for browser sign-in |
| `--browser-origin <o>` | `OMP_FLEET_BROWSER_ORIGIN` | `browserOrigin` | absent | Origin admitted for browser mutations |
| `--trusted-proxy <ip-or-cidr>` | `OMP_FLEET_TRUSTED_PROXY` (comma-separated) | `trustedProxies` | absent | Reverse proxies whose forwarded headers the fleet honors |

- A non-loopback bind without browser auth configured is a startup error and the fleet exits 1: `refusing to bind non-loopback address "<addr>" without browser auth; set OMP_FLEET_BROWSER_TOKEN (or --browser-access-token / config browserAccessToken)`. The control plane is never opened unauthenticated on a reachable address.
- The access token is kept only as its SHA-256 hex digest. `--browser-access-token` and `OMP_FLEET_BROWSER_TOKEN` accept the plaintext and are hashed at load; the `browserAccessToken` config key must already be that 64-character digest. See [Browser access and sign-in](/operations/browser-auth/).
- `--trusted-proxy` is repeatable and each occurrence may itself be a comma-separated list. Forwarded headers are honored only when the direct socket peer matches a configured entry, so forwarded headers from any other peer are ignored.
- See [Configuration schema](/reference/configuration/) for the key-by-key config semantics and [Environment variables](/reference/environment/) for the full precedence table.

Banner output, in order:

1. `fleet listening on <bind>:<port>` (scripts parse the port from this line; the default bind is `127.0.0.1`).
2. `fleet state: <path>`, the registry file.
3. `fleet config: <path>`, or `(defaults)` when no config file exists.
4. `fleet restored <n> sessions` with a per-status breakdown when the registry was not empty.
5. `Web UI: http://localhost:<port>`.

After the banner, each lifecycle transition prints one `fleet: <id> <name> <message>` line with live registry facts appended.

Behavior notes:

- The config file is read from `OMP_FLEET_CONFIG` or `~/.omp-web/config.json`. The state file lives next to the config (`fleet-state.json`) unless `OMP_FLEET_STATE` overrides it. See [Files and directories](/reference/files/).
- On the first run (no config file, interactive stdin) the fleet offers setup: it checks the `omp` stack (binary, authenticated providers, default-role model), asks for a data home with default `~/.omp-web`, creates the data home and workspace root, and writes `config.json` there. Enter or `y`/`yes` accepts the default, a path overrides it, and `n`/`no` serves with defaults and writes nothing. Non-interactive runs skip the offer. See [First run](/getting-started/first-run/).
- A second fleet over the same state file refuses to start, names the holding pid and lock path, and exits 77.
- Spawned session daemons run the resolved spawn template, by default `omp-web session --cwd {cwd} --port 0 --token {token} --name {name} ...`. See [Configure spawn templates](/configuration/spawn-templates/).

## session

```
omp-web session [options]
```

Runs one session daemon: a single process bound to one directory, holding one live agent session and serving the wire API. It serves no web UI, because the fleet is the only server of the web UI. The directory is bound at spawn and immutable for the process lifetime.

```sh
omp-web session --cwd ~/code/app --port 4721
omp-web session --cwd ~/code/app --port 0 --name app --resume ~/.omp/agent/sessions/app/ab12.jsonl
```

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--cwd <dir>` | `OMP_SESSION_CWD` | current directory | Bound project root |
| `--port <n>` | `OMP_SESSION_PORT` | `4721` | Listen port; 0 picks an ephemeral port |
| `--host <addr>` | `OMP_SESSION_HOST` | `127.0.0.1` | Bind address |
| `--token <t>` | `OMP_SESSION_TOKEN` | none | Bearer credential for off-loopback peers |
| `--advertise <url>` | `OMP_SESSION_ADVERTISE` | none | Reported in the contract line; does not affect the bind |
| `--resume <file>` | `OMP_SESSION_RESUME` | none | Session file to switch into at boot |
| `--idle-timeout <dur>` | `OMP_SESSION_IDLE_TIMEOUT` | `30m` | Idle auto-exit delay; `0` disables |
| `--name <name>` | `OMP_SESSION_NAME` | basename of cwd | Display name in the fleet registry |
| `--label <k=v>` | `OMP_SESSION_LABELS` | none | Selector labels; repeats and combines with the environment list |
| `--callback-url <url>` | `OMP_SESSION_CALLBACK_URL` | none | Fleet callback pair base URL; `http` only for a loopback host with `--callback-allow-http` |
| `--callback-workspace <id>` | `OMP_SESSION_CALLBACK_WORKSPACE` | none | Roster daemon id the pair is bound to; required with `--callback-url` |
| `--callback-generation <n>` | `OMP_SESSION_CALLBACK_GENERATION` | `1` when a callback URL is set | Authorized credential generation; a positive integer |
| `--callback-token <t>` | `OMP_SESSION_CALLBACK_TOKEN` | none | Enrollment credential presented on both halves of the pair |
| `--callback-proxy <url>` | `OMP_SESSION_CALLBACK_PROXY` | none (direct) | Streaming proxy for the pair; `http` or `https` only, with no direct fallback |
| `--callback-allow-http` | `OMP_SESSION_CALLBACK_ALLOW_HTTP` | unset | Bare boolean; opens loopback HTTP for the callback URL (the variable counts only when it is `1`) |

Each flag wins over its environment variable, which wins over the default. `--idle-timeout` accepts `90s`, `30m`, `1h`, or a bare number of milliseconds. Repeated scalar flags keep the first value; `--label` repeats accumulate. Unrecognized flags and positional arguments are ignored, so there is no `session --help`; invalid values exit 1 with an `omp-session:` message.

Output:

- stdout, immediately after bind, one contract line such as `OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}`, with `advertise` added when set. The `url` field keeps a `ws://` prefix for historical reasons; the protocol is HTTP plus SSE.
- stderr, `omp-session listening on http://localhost:<port>`, followed by human logs.

Error behavior:

- An invalid port (`invalid port "<value>" (0-65535; 0 = ephemeral)`) or duration (`invalid duration "<value>" (expected e.g. 90s, 30m, 1h, or bare milliseconds)`) exits 1 at startup.
- Binding a non-loopback address without a token exits 1; the message names `--token` and `OMP_SESSION_TOKEN`.
- `--resume` failure logs `omp-session: --resume <file> ... starting fresh` and boots a new session instead of exiting.
- Callback transport misconfiguration exits 1 at startup, before the bind: `invalid --callback-url "<value>" (not a URL)`, `--callback-url refuses http "<value>" (https required; --callback-allow-http only opens loopback HTTP)`, `--callback-allow-http only honors loopback hosts, got "<host>"`, `--callback-url requires --callback-workspace (the pair is workspace-bound)`, `invalid --callback-generation "<value>" (positive integer)`, and `unsupported --callback-proxy scheme "<scheme>" (<value>); only http/https proxies are supported and there is no direct fallback`.
- A session file already locked by another session daemon exits 1 and names the holding pid.
- Idle auto-exit applies when nothing suppresses it: no attached clients, no streaming turn, no queued messages, no pending dialog, no in-flight tool call, and no live collaboration room. The session daemon checks on a 15 second interval, logs `omp-session: idle for <ms>ms; shutting down`, and exits 0. The session transcript is durable, so the fleet marks the row asleep and can wake it with `--resume`.
- A bind failure aborts startup.

In a source checkout the same session daemon runs as `bun server/index.ts` or `bun run dev:server`. See [CLI overview](/cli/overview/) and [Run a session daemon](/cli/session-daemon/).

## Fleet control verbs

The verbs below require a running fleet. Each prints its result on stdout and exits 0, or prints `fleet error (<status>): <message>` on stderr and exits 1. A refused connection prints `fleet not running. Start it: omp-fleet serve` (`omp-fleet` is the fleet's internal process name) and exits 1. `preflight` is the one verb in this section that needs no running fleet.

```sh
omp-web sessions
omp-web profiles
omp-web add-repo ~/code/app --start
omp-web spawn ~/code/app --name review --label role=review
omp-web add review-box ws://review-box.example.com:4721 --token "$TOKEN"
omp-web add-clone app sandbox-1 --profile bwrap-dev --remote ssh://host/srv/app
omp-web start d7
omp-web prompt project:app summarize the open TODOs --wait 120000
omp-web stop label:role=review
omp-web rm-worktree d4 --delete-branch
omp-web preflight --profile bwrap-dev
```

### sessions

```
omp-web sessions [--port <n>]
```

Prints the roster table with columns `id`, `name`, `mode` (`spawned` or `remote`), `status`, `project`, `cwd`, and `labels`. An empty roster prints the header row only.

### projects

```
omp-web projects [--port <n>]
```

Prints columns `name`, `path`, `branch`, and `worktreeOf`. Rows are each registered project's linked worktrees that no roster row uses yet, so every row is a candidate for adoption with `omp-web add-worktree --existing`. Registered projects themselves are not listed; the `project` column of `omp-web sessions` names the project behind a roster row. See [Manage projects and worktrees](/cli/projects-and-worktrees/).

### profiles

```
omp-web profiles [--port <n>]
```

Prints the provider profile catalog the fleet loaded from the config file's `providerProfiles` key: the secret-free view of each profile, with columns `id`, `provider`, `cpu`, `memory`, `storage`, `secrets`, and `network`. Secret values are never in this output, because they never leave the fleet; `secrets` lists reference names only.

With no profiles configured the command prints exactly `no provider profiles configured (set providerProfiles in the fleet config)` and exits 0. A profile that failed validation at load was dropped with a warning on the fleet's stderr, so it is absent here as well. See [Provider profiles](/configuration/provider-profiles/).

### spawn

```
omp-web spawn <path> [--template <name>] [--name <name>] [--label <k=v>]... [--port <n>]
```

Starts a local session daemon on an existing directory. The path is realpath-resolved and `~` is expanded; a missing or non-directory path fails with `not a directory: <path>`. The name defaults to the directory basename; `--label` repeats. `--template` selects a spawn template by name; an unknown name fails the spawn instead of falling back. Without `--template`, the configuration's `defaultTemplate` applies, with per-project overrides. See [Configure spawn templates](/configuration/spawn-templates/).

Output: `spawned <daemonId> (<name>)` followed by the current status. The row then advances to `ready` on its own.

### add-repo

```
omp-web add-repo <path> [--start] [--template <name>] [--labels <k=v,...>] [--port <n>]
```

Registers a Git repository project. Registration stores the realpath and dedups on it; a path that is missing or not a repository exits 1 with the validation message, and an already registered realpath exits 1 naming the existing project id. Registration also creates the project's default workspace row for the main checkout, asleep by default.

- `--start` spawns that row immediately, using `--template` and the labels.
- `--labels` is one comma-separated flag. Repeated `--label` flags are not read by this verb; that spelling belongs to `spawn`, `add`, and `provision`.

Output: `registered <projectId> (<path>)`, with the spawned session daemon id appended when `--start` is used. A spawn failure still leaves the project registered.

### add

```
omp-web add <name> <url> [--token <token>] [--label <k=v>]... [--cwd <dir>] [--port <n>]
```

Registers a remote session daemon. The URL must be `ws://` or `wss://` shaped; another scheme exits 1. `--cwd` records a display and grouping path without managing it. `--token` supplies the bearer credential the fleet presents; it is needed for any session daemon that requires authentication, such as one bound off loopback.

Output: `added <daemonId> (<name>)` followed by the initial status (`connecting`). The fleet dials the endpoint and the row advances on its own. See [Run a remote session daemon over SSH](/advanced/ssh/).

### provision

```
omp-web provision <name> [--label <k=v>]... [--port <n>]
```

Starts a session daemon through the configured spawn hook (`spawnHook` or `OMP_FLEET_SPAWN_HOOK`), which runs through `sh -c` with `OMP_HOOK_NAME` and `OMP_HOOK_LABELS` and a 60 second deadline. The hook's last non-empty stdout line must be JSON with `url` and `token`, optionally `name` and `cwd`.

Output: `provisioned <daemonId> (<name>)` followed by the status. Exits 1 when no hook is configured or the hook fails, times out, or returns unusable output.

### add-worktree

```
omp-web add-worktree <project> <name> [--base <ref>] [--branch <existing>] [--no-start] [--port <n>]
omp-web add-worktree <project> --existing <path> [--no-start] [--port <n>]
```

Creates a managed worktree, or registers an existing linked worktree. `<project>` accepts id, path, or name. A session daemon is spawned by default; `--no-start` registers the row asleep instead. `--base` chooses the base ref for a new branch; `--branch` attaches an existing local branch, refused when it does not exist or is checked out elsewhere.

Output: `created worktree <path> (<daemonId>)` with either the status or `not started`; the `--existing` form prints `registered worktree` instead of `created worktree`.

### add-clone

```
omp-web add-clone <project> <name> --profile <id> [--local <path> | --remote <url>]
                  [--revision <rev>] [--branch <b>] [--no-start] [--port <n>]
```

Creates a clone workspace: an independent checkout on a provider-managed volume, run by the profile named by `--profile`. `<project>` accepts the same id, path, or name selector forms as `rm-project`.

- `--profile <id>` is required and must name a key in the config file's `providerProfiles` map. `omp-web profiles` lists the loaded ones.
- At most one source may be given: `--local <path>` clones a path on the fleet host, `--remote <url>` clones a reachable Git URL. With neither, the server falls back to the registered project's local path. A `kubernetes` profile cannot read a fleet-host path, so it refuses a local source with `source.local is a fleet-host filesystem path and cannot initialize a kubernetes volume; use source.remote for kubernetes profiles`; pass `--remote` for those profiles.
- `--revision <rev>` pins the initial commit; `--branch <b>` chooses the branch. Revision input is always `--revision`, never `--base` (which belongs to `add-worktree`).
- The session daemon is started by default; `--no-start` registers the row without compute. `start` defaults on, exactly as with `add-worktree`.

Output: `created clone <path> (<daemonId>)` with either `, status <status>` plus the lifecycle stage when the server reports one, or `, not started`. A fleet with no provider profiles configured has no clone route to call: the request fails with a typed `unavailable` error. See [Clone workspaces](/fleet/clone-workspaces/) and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

### start

```
omp-web start <selector> [--port <n>]
```

Ensures one clone workspace is running, the fleet-side counterpart of waking a row. The selector is resolved client-side against the roster and matches a session daemon id or an exact roster name; a selector that matches nothing exits 1 with `no session matches selector: <selector>`, and one that matches several distinct rows exits 1 with `selector <selector> matches multiple daemons; use a daemon id`.

The route behind it only ever runs provider-managed clone entries. A worktree or direct session daemon refuses with `daemon <daemonId> is not a clone workspace (kind <kind>); start a worktree/direct session through /ctl/spawn`; use `omp-web spawn` for those.

Output: `started <daemonId>, observed <observed>`, with ` (pid <n>)` appended when the provider reports a process id. See [Clone workspaces](/fleet/clone-workspaces/).

### stop, remove

```
omp-web stop <selector> [--port <n>]
omp-web remove <selector> [--port <n>]
```

`stop` terminates every matching session daemon and leaves the roster rows asleep; `remove` drops the matching rows from the registry entirely. A spawned row is terminated gracefully (SIGTERM, then SIGKILL after a short grace period); a remote row is disconnected. A clone workspace stops its provider-managed compute and keeps the volume, so a later `start` or wake resumes rather than reclones. Selector matching happens on the fleet side; a selector that matches nothing exits 1 and changes nothing.

Output: `stopped <id>, <id>...` or `removed <id>, <id>...`.

### rm-project

```
omp-web rm-project <selector> [--port <n>]
```

Deregisters a project without touching disk. The selector resolves client-side in this order: exact project id (`p1`), exact registered path, project name, then realpath of the given path. A selector that matches nothing exits 1 with `no registered project matches selector: <selector>`.

Removal is refused while roster entries still reference the project, with the blocking session daemon ids in the message; the project's never-started default workspace row is dropped with it. Output: `removed <projectId>`.

### rm-worktree

```
omp-web rm-worktree <daemon-id> [--delete-branch] [--port <n>]
```

Takes one session daemon id, not a selector. The same route serves both row kinds and dispatches on the entry's kind:

- A Git worktree: guards run before anything is mutated. Only worktrees under the workspace root are owned and deletable, and a dirty worktree is refused; there is no force option. On success the session daemon is stopped, the row is evicted, and Git removes the worktree. `--delete-branch` additionally tries `git branch -d`; a branch Git refuses to delete is left in place while the worktree is still removed. Output: `removed worktree daemon <daemonId> (<path>, branch <branch>)`.
- A clone workspace: deletion runs the verify-at-deletion gate (quiesce, Git guard, store completeness, read-only flip) before any provider or volume deletion. A blocked deletion keeps the workspace, its volume, and its logs. Output: `removed clone workspace daemon <daemonId> (verified <n> sessions)`.

### prompt

```
omp-web prompt <selector> <text...> [--wait <ms>] [--port <n>]
```

Sends one prompt to every matching session daemon. Asleep targets are woken first; different session daemons run in parallel; prompts to the same session daemon are serialized. `<text...>` is the remaining positional words joined with single spaces.

- Without `--wait` the call is fire-and-forget: output is `submitted to <id>, <id>...` and the command returns as soon as the fleet accepts the work.
- With `--wait <ms>` the fleet waits for each turn, up to that many milliseconds per result, and prints one block per target: `== <daemonId> ==` followed by the final assistant text or `error: <message>`. The exit code stays 0 even when a target reports an error or `timeout`. A value of 0 returns immediately, before any turn can finish.

See [Fan-out prompting](/cli/fanout/).

### preflight

```
omp-web preflight --profile <id> [--port <n>]
```

Validates one provider profile on this host before any clone workspace uses it. It is the only fleet verb that runs entirely in the calling process: it resolves the config file exactly as `serve` does (`OMP_FLEET_CONFIG`, then `~/.omp-web/config.json`), loads `providerProfiles`, and runs the profile checks locally. No fleet needs to be running, and `--port` is parsed but unused.

- `--profile <id>` is required. Without it the command exits 1 with `usage: omp-fleet preflight --profile <id>`.
- An id that is not a configured profile exits 1 with `no provider profile "<id>" in <configPath>: configure providerProfiles."<id>" first`.

Output starts with `profile <id>: ready` or `profile <id>: NOT ready`, followed by one line per check:

```text
profile bwrap-dev: ready
  [ok] bwrap-binary: bwrap <version> at <path>
  [ok] durable-logs-root: writable: /home/you/.omp-web/logs
```

Each line is `  [ok] <name>: <detail>` or `  [FAIL] <name>: <detail>`, and a failed check adds an indented `      fix: <remediation>` line naming the concrete repair. The command exits 0 when every check passes and 1 when any check fails, so it is usable as a pre-launch gate in scripts.

Checks are host-generic plus provider-specific. A bwrap profile first probes the `bwrap` binary and user namespaces, then the session runtime entrypoint and binary, then the provider executable, callback reachability, the durable state directories, declared tool paths, denied bind roots, secret references, and stray Kubernetes-only fields. A Kubernetes profile skips the host sandbox checks (the daemon runs in a pod image) and instead reports the real API prerequisites: context, namespace, image, and storage. Nothing is ever provisioned and nothing is written: the callback check resolves DNS and opens a TCP connection only, and a profile with no callback URL reports the check as `not configured`.

See [Provider profiles](/configuration/provider-profiles/) and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

### Selectors

| Form | Matches |
| --- | --- |
| `all` | every roster entry |
| `d3` | exact session daemon id (checked before glob interpretation) |
| `label:k=v`, alias `tag:k=v` | entries whose labels contain exactly `k=v` |
| `project:name` | entries whose project label equals `name` |
| `review*`, `box?` | name glob, anchored at both ends |
| any other text | name glob interpretation of the literal text |

`stop`, `remove`, and `prompt` accept these forms. `rm-project`, `add-worktree`, and `add-clone` take project selectors (id, path, or name). `start` takes a narrower selector: a session daemon id or an exact roster name, and it refuses a value that matches several rows. See [Select multiple session daemons](/cli/selectors/).

## update

```
omp-web update [--check] [--force] [--version <x.y.z>]
```

Self-updates the installation from the release channel, the GitHub Releases asset base at `https://github.com/nibblebot/omp-web/releases/latest/download` unless `OMP_WEB_UPDATE_URL` overrides it.

| Flag | Effect |
| --- | --- |
| `--check` | Fetches the manifest and compares versions; never downloads or installs |
| `--force` | Skips the version comparison and reinstalls the manifest version |
| `--version <x.y.z>` | Pins a release tag by rewriting the base to its `download/v<x.y.z>` asset path |

```sh
omp-web update --check
omp-web update
```

Flow and output:

- `--check` prints the manifest version when it is newer, or `omp-web is up to date (<current>)`; both exit 0.
- A normal run downloads the tarball, verifies its SHA-256 against the manifest before anything is installed, reinstalls into the pinned install directory, and prints `omp-web updated to <version>`. The verified temp file is removed afterwards.
- After a successful update, if anything answers on `http://127.0.0.1:4722/ctl/sessions`, the command advises restarting the running fleet.
- Running from source resolves the version to `dev` and refuses to update unless both `--force` and `--version` are given.
- An installation that is not the pinned layout managed by the installer fails with a reinstall hint, exit 1.
- Failures (fetch, manifest, checksum mismatch, install) print `omp-web: <message>` on stderr and exit 1. The update never restarts the fleet or session daemons for you.

## version

```
omp-web --version
omp-web version
```

Prints the resolved version and exits 0. Resolution order: the build-time stamp, then the installed `package.json`, then `dev` for a source checkout.

## Collaboration script

Collaboration rooms are operated outside the browser. The collaboration CLI is a repository script, not part of the installed `omp-web` command surface; there is no `omp-web collab`. In a checkout:

```
bun server/collab-cli.ts [--join] [--view] [--stop] [--port <n>]
bun run collab -- [--join] [--view] [--stop] [--port <n>]
```

| Flag | Effect |
| --- | --- |
| `--join` | After printing the links, runs `omp join <link>` in the foreground and exits with its status |
| `--view` | Joins with the read-only view link instead of the writable link |
| `--stop` | Stops the collab room of the session daemon instead of starting one |
| `--port <n>` | Session daemon HTTP port; defaults to `OMP_SESSION_PORT` or 4721 |
| `-h`, `--help` | Prints the usage line and exits 0 |

Behavior:

- The session daemon must already be running on a loopback port; connecting times out after 5 seconds with a hint to start it. Loopback is exempt from the token requirement.
- Starting prints `room: <roomId>`, the writable `omp join <link>`, and the read-only `omp join <viewLink>`; a room that is already live prints immediately. Waiting for a room times out after 10 seconds.
- `--stop` prints `collab stopped`, or `collab is not active` when no room was running, and exits 0 in both cases.
- Errors (unknown flag, unreachable session daemon, collab failure, timeout) print a message and exit 1.

See [Collaboration rooms](/advanced/collaboration/).

## Related

- [CLI overview](/cli/overview/)
- [Manage projects and worktrees](/cli/projects-and-worktrees/)
- [Operate session daemons](/cli/session-daemon-operations/)
- [Select multiple session daemons](/cli/selectors/)
- [Fan-out prompting](/cli/fanout/)
- [Environment variables and precedence](/reference/environment/)
- [Configuration schema](/reference/configuration/)
- [Updates](/operations/updates/)
