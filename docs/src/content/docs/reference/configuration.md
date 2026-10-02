---
title: Configuration schema
description: Canonical reference for the fleet configuration file, config.json, with every supported key, its default, and the precedence rules the fleet applies.
---

The fleet configuration file is a JSON file named `config.json`. The fleet process (`omp-web` or `omp-web serve`) reads it once at startup and uses it to spawn and connect session daemons and to place managed worktrees. A session daemon started with `omp-web session` never reads this file; its behavior comes from flags and `OMP_SESSION_*` variables (see [What this file does not configure](#what-this-file-does-not-configure)).

The first-run setup offer creates the file (see [First run](/getting-started/first-run/)). After that it is edited by hand. The fleet does not reload it while running, so restart the fleet after every change.

If you are configuring spawn templates rather than looking up a key, start with [Configure spawn templates](/configuration/spawn-templates/); this page is the exhaustive key-by-key reference.

## File location

| Source | Path |
| --- | --- |
| `OMP_FLEET_CONFIG` variable | The value of the variable, with a leading `~` expanded. An empty value is ignored. |
| Default | `~/.omp-web/config.json`, where `~` is your home directory. |

The default fleet state file, `fleet-state.json`, lives in the same directory as the config file, so pointing the variable at another directory moves both. See [Files and directories](/reference/files/) for the full data layout.

## Load and merge behavior

| File state | Result |
| --- | --- |
| Missing | Built-in defaults apply. |
| Unreadable, unparseable, or not a JSON object (for example an array or `null`) | The file is ignored as a whole and the built-in defaults apply. The loader does not report this. |
| JSON object | Keys merge over the defaults one by one. |

Merging an object follows these rules:

- Unknown keys are ignored, so a file may carry extra keys, for example a `_comment` string used for notes.
- A known key with the wrong type is ignored, and that key keeps its default. Two keys are the exceptions, because both are security settings that must never fail open: a `browserAccessToken` that is not a 64-character SHA-256 hex digest, and a `trustedProxies` entry that is not an IP address or CIDR, are hard load errors and the fleet refuses to start.
- `templates` is replaced in full rather than merged template by template. A file that defines any template also replaces the built-in `local` template.
- A `templates` object is accepted only when every value is an object with a string `command`. If any entry fails that check, the whole map falls back to the default. Other fields inside a template object (including `host`) are passed through without validation. An empty `templates` object is accepted and leaves no templates at all, so every spawn fails.
- `providerProfiles` is validated one entry at a time. An entry that fails validation is dropped with a warning on the fleet's standard error naming the key, the reason, and a code, and the fleet boots on the remaining entries. A `providerProfiles` value that is not an object is treated as absent. See [Provider profiles](/configuration/provider-profiles/).

A leading `~` or `~/` is expanded to your home directory in the config path, in `workspaceDir` (from the file, `OMP_FLEET_WORKSPACE_DIR`, or `--workspace-dir`), and in a `spawnHook` value read from the file. The `OMP_FLEET_SPAWN_HOOK` value is used verbatim, without expansion. Relative paths are not resolved, so prefer absolute paths or `~/...`.

`OMP_FLEET_LOCAL_TEMPLATE` and the `--workspace-dir` flag are applied after the merge and win over the file. See [Environment overrides](#environment-overrides).

## Top-level keys

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `templates` | object of template objects | `{ "local": ... }` (the default local template) | Named command templates the fleet runs to spawn session daemons. |
| `defaultTemplate` | string | `"local"` | Template used when a spawn does not name one and no project override matches. |
| `projectTemplates` | object of strings | absent | Template name overrides keyed by the working directory's base name. |
| `spawnHook` | string | absent | Shell command that provisions a remote session daemon for `omp-web provision`. |
| `workspaceDir` | string | `~/.omp-web/workspaces` | Root directory for managed worktrees. |
| `bind` | string | `"127.0.0.1"` | Address the control plane and the browser edge bind. |
| `browserAccessToken` | string | absent (browser auth off) | SHA-256 hex digest of the operator access token that turns on browser sign-in. |
| `browserOrigin` | string | absent | Public origin admitted for browser mutations. |
| `trustedProxies` | array of strings | absent | Reverse proxies whose forwarded headers the fleet honors. |
| `providerProfiles` | object of profile objects | absent | Clone workspace provider profiles, keyed by profile id. |

## templates

A map of template names to templates. The name is arbitrary; it is what the `--template` flag, the Add repo dialog, and `projectTemplates` select, and it is stored on the fleet registry entry so restarts reuse the same template.

Each template object has these fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `command` | string | yes | The command the fleet runs to start the session daemon. |
| `host` | string | no | A reachable host for the session daemon, used when the fleet cannot otherwise resolve a dialable endpoint. See [host and endpoint resolution](#host-and-endpoint-resolution). |

The built-in defaults for `templates` and `defaultTemplate` are:

```json
{
  "templates": {
    "local": {
      "command": "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}"
    }
  },
  "defaultTemplate": "local"
}
```

Template names appear in the template selector of the Add repo dialog, which reads `GET /ctl/templates`. The `command` strings are never sent to browsers.

### Placeholders

The fleet substitutes these placeholders inside `command`:

| Placeholder | Expands to |
| --- | --- |
| `{cwd}` | The session daemon's working directory: the project or worktree path the session binds to. |
| `{token}` | A fresh bearer token for this spawn attempt (32 random bytes, base64url-encoded). |
| `{name}` | The roster name. When a spawn does not pass one, it is the base name of the working directory. |
| `{labels}` | Zero or more `--label 'k=v'` arguments, or an empty string when the session daemon has no labels. |
| `{resume}` | `--resume '<file>'` when the fleet restarts or wakes a session daemon with a known session file, otherwise an empty string. |

Substitution rules:

- Substitution is plain text. Any other `{word}` is left in the command unchanged.
- Each value is shell-quoted before it is inserted: wrapped in single quotes, with embedded single quotes escaped. Place each placeholder as a bare word and do not wrap it in quotes of your own. Extra quotes become part of the value the session daemon receives.
- The filled command runs through `sh -c`, so a template can use shell syntax, pipes, and wrapper scripts.
- The fleet parses the child's stdout for `OMP_SESSION|` contract lines and keeps stderr in a rolling buffer shown in the session daemon's log view. A child that prints no `listening` line within 30 seconds is marked `error` with `endpoint timeout: no OMP_SESSION| listening line within 30s` and killed.
- A fresh template spawn passes no `--resume`, so a template that omits `{resume}` always starts a new session on restart.

### host and endpoint resolution

When a template sets `host`, the fleet can dial a session daemon whose own listening line names an address it cannot reach, which is the usual case for a remote or containerized session daemon. Resolution runs in this order and the first match wins:

1. The last `{"event":"endpoint", ...}` contract line printed by the command (a wrapper that publishes a port).
2. `host` plus the port from the last `listening` line, as `ws://<host>:<port>`.
3. The `advertise` URL from the last `listening` line.
4. Loopback: `ws://127.0.0.1:<port>`.

Use a bare host name or IP address without a scheme. A resolved URL that is not a valid `ws://` or `wss://` URL fails the spawn with `invalid endpoint from child: <url>`.

### Example: keep the local template and add a remote one

Because `templates` replaces the default map, repeat the `local` entry when you add templates, or point `defaultTemplate` at one of the new names.

```json
{
  "templates": {
    "local": {
      "command": "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}"
    },
    "ssh-remote": {
      "host": "box.example.com",
      "command": "ssh box.example.com omp-web session --cwd {cwd} --port 4721 --host 0.0.0.0 --token {token} --name {name} {labels} {resume}"
    }
  },
  "defaultTemplate": "local"
}
```

See [Run a remote session daemon over SSH](/advanced/ssh/) for remote template shapes.

## defaultTemplate and projectTemplates

The template for a spawn is resolved in this order, first match wins:

1. An explicit name in the spawn request: `--template` on `omp-web spawn` or `omp-web add-repo`, or the template selector in the Add repo dialog.
2. `projectTemplates[base name of the working directory]`.
3. `defaultTemplate`.

A resolved name that is not a key in `templates` fails the spawn with `unknown spawn template: <name>`, and no roster entry is created. Template names are not validated when the file loads, so a typo or a dangling `defaultTemplate` is only reported at the first spawn.

`projectTemplates` maps a working directory base name to a template name:

```json
{
  "projectTemplates": {
    "omp-web": "ssh-remote"
  }
}
```

The key is the base name of the directory the session daemon is spawned on. A main checkout matches the repository directory name; a managed worktree matches its worktree slug, which is its last path segment under `workspaceDir`. The sidebar's start action sends no explicit template, so it always resolves through this table and `defaultTemplate`.

The resolved name is stored on the fleet registry entry and reused for restarts and wakes. Editing `defaultTemplate` or `projectTemplates` affects later spawns, not existing entries.

## spawnHook

`spawnHook` is a shell command the fleet runs when you provision a remote session daemon with `omp-web provision <name> [--label k=v]...`. It is a different mechanism from a spawn template: the hook starts the daemon itself and returns a dial-in endpoint, and the fleet supervises the connection rather than a child process.

```json
{
  "spawnHook": "~/providers/sandbox.sh"
}
```

Behavior:

- The hook runs through `sh -c`, inheriting the fleet environment plus `OMP_HOOK_NAME` (the requested name) and `OMP_HOOK_LABELS` (comma-joined labels, an empty string when there are none).
- It has 60 seconds. On timeout the fleet sends `SIGKILL` and provisioning fails.
- Its last non-empty stdout line must be a JSON object: `url` and `token` are required non-empty strings, with `url` a `ws://` or `wss://` URL, and `name` and `cwd` are optional.
- The result is registered as a remote roster entry and dialed immediately.
- With no hook configured, `omp-web provision` fails immediately with `no spawn hook configured`. A hook that times out, exits non-zero, or prints something other than the required JSON fails the request with a 502 error naming the reason.

`OMP_FLEET_SPAWN_HOOK` wins over the file value. A leading `~` is expanded in the file value only; environment values are used verbatim. The full enrollment contract, a wrapper example, and the failure catalog are in [Integrate a custom provider](/advanced/custom-provider/).

## workspaceDir

`workspaceDir` is the root for managed worktrees, the checkouts the fleet creates with `omp-web add-worktree` or the worktree dialogs. The layout is `<workspaceDir>/<repo base name>/<worktree slug>`, and the root is created lazily on the first worktree, never at fleet boot.

Precedence, highest first:

1. The `--workspace-dir` flag on `omp-web serve`.
2. `OMP_FLEET_WORKSPACE_DIR`.
3. The `workspaceDir` key in the config file.
4. `~/.omp-web/workspaces`.

The fleet marks a roster entry `managed` when its working directory resolves under this root, and that mark is what enables worktree deletion in the UI. Changing the root does not move existing worktrees, and worktrees left under the old root stop being treated as managed. See [Create and adopt worktrees](/fleet/worktrees/) and [Safely delete managed worktrees](/fleet/delete-worktrees/).

The same root holds clone workspace volumes, one directory per roster id, plus the provider supervision state under `<workspaceDir>/.provider-state/`. See [Files and directories](/reference/files/) for the volume layout.

## bind

`bind` is the address the control plane and the browser edge listen on. Precedence, highest first: `--bind` on `omp-web serve`, `OMP_FLEET_BIND`, the `bind` key in this file, then `127.0.0.1`.

```json
{
  "bind": "0.0.0.0"
}
```

A non-loopback bind without browser auth configured is a startup error, and the fleet exits 1 with `refusing to bind non-loopback address "<addr>" without browser auth; set OMP_FLEET_BROWSER_TOKEN (or --browser-access-token / config browserAccessToken)`. Set a token in the same run, or keep the bind on loopback and reach the fleet through a tunnel. See [Networking and browser access](/operations/networking/) and [Browser access and sign-in](/operations/browser-auth/).

## browserAccessToken, browserOrigin, and trustedProxies

These three keys configure the browser surface behind a non-loopback bind.

| Key | Precedence, highest first | Notes |
| --- | --- | --- |
| `browserAccessToken` | `--browser-access-token`, `OMP_FLEET_BROWSER_TOKEN`, then this key | Must be the 64-character SHA-256 hex digest of the operator access token, not the token itself. |
| `browserOrigin` | `--browser-origin`, `OMP_FLEET_BROWSER_ORIGIN`, then this key | The public origin admitted for browser mutations, alongside the loopback development exception. |
| `trustedProxies` | `--trusted-proxy`, `OMP_FLEET_TRUSTED_PROXY` (comma-separated), then this key | An array of IP address or CIDR literals. |

```json
{
  "bind": "0.0.0.0",
  "browserAccessToken": "9f2a1c4b7d8e0f3a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c",
  "browserOrigin": "https://omp.example.com",
  "trustedProxies": ["10.0.0.0/8", "192.168.1.7"]
}
```

Behavior:

- The flag and the environment variable carry the plaintext token, and the fleet hashes it during the config load. This key must already hold the digest, because the plaintext is never stored anywhere: hash it once with `sha256sum` and put the result here. A value that is not 64 hex characters is a hard load error, not a silent fallback to "browser auth off", with the message `invalid config browserAccessToken: expected the 64-char sha-256 hex digest of the access token (hash it once with \`sha256sum\` and configure that; the plaintext is never stored)`.
- Leaving all three token sources unset disables browser auth entirely, and every route behaves as it did before the key existed. That is only safe on loopback, which is why a non-loopback `bind` then refuses to start.
- Trusted proxies are about forwarded headers, not about access. `X-Forwarded-For` and `X-Forwarded-Proto` shape the client-address and loopback decisions only when the direct socket peer matches a configured literal. Forwarded headers from any other peer are ignored, so the fail-closed default needs no configuration. A literal that is neither an IP address nor a CIDR block is a hard load error naming every bad entry.
- `--trusted-proxy` is repeatable and each occurrence may itself be a comma-separated list, so `--trusted-proxy 10.0.0.0/8,192.168.1.7` and `--trusted-proxy 10.0.0.0/8 --trusted-proxy 192.168.1.7` are equivalent.

See [Browser access and sign-in](/operations/browser-auth/) for the sign-in flow, the session cookie, and what the Origin check protects.

## providerProfiles

`providerProfiles` declares the providers that can run a clone workspace, keyed by profile id. Every profile is validated at load; a malformed entry is dropped with a warning naming the key, the reason, and a code, and the fleet boots on the remaining entries.

```json
{
  "providerProfiles": {
    "bwrap-dev": {
      "provider": "bwrap",
      "executable": "~/bin/bwrap-provider.sh",
      "tools": ["/usr/bin/git"],
      "resources": { "cpu": "2", "memory": "4Gi" },
      "secretRefs": { "ANTHROPIC_API_KEY": "env:ANTHROPIC_API_KEY" }
    }
  }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `provider` | `"bwrap"` or `"kubernetes"` | yes | Which provider runs the workspace. |
| `executable` | string | yes | The provider executable. A leading `~` is expanded at load; a bare name is resolved on `PATH`. |
| `tools` | array of strings | yes | Extra tools to make available inside the workspace. Each entry must be a non-empty string, and it should be an absolute path: a bare name cannot be bound read-only, so preflight fails on one. |
| `resources` | `{ "cpu"?: string, "memory"?: string }` | no | Operator-declared limits, for example `500m` and `512Mi`. |
| `storage` | `{ "class"?: string, "size"?: string }` | no | Kubernetes storage class and volume size. |
| `secretRefs` | object of strings | no | Secret name to external reference. Values never leave the provider process; the reference is what travels. |
| `image` | string | no | Kubernetes only: the session runtime image. |
| `namespace` | string | no | Kubernetes only: the operator-approved namespace. |
| `context` | string | no | Kubernetes only: the kubeconfig context. It is never inferred from the ambient current-context. |
| `network` | `"host"` or `"isolated"` | no | bwrap only. Absent means `isolated`; `host` shares the host network namespace and is a development-only concession. |

The map key is the profile id; a profile that also carries an `id` field must match its key. Nothing about a profile is inferred: what you declare is what is used.

The secret-free view of each profile is what leaves the fleet: `GET /ctl/profiles`, `omp-web profiles`, and the browser's profile picker see the id, the provider, the declared resources, the storage class name, the sorted secret reference names, and the network mode. The executable, the secret reference values, and the image and namespace details never cross that boundary.

Before a workspace uses a profile, validate it on the host that will run it:

```sh
omp-web preflight --profile bwrap-dev
```

`preflight` reads this file in its own process and probes the profile: the provider executable, the callback reachability, the durable state directories, the declared tools, the deny roots, and the secret references. Kubernetes profiles report the context, namespace, image, and storage requirements instead of the host sandbox checks. It exits 1 when any check fails and prints a `fix:` line per failure. See [Provider profiles](/configuration/provider-profiles/), [Clone workspaces](/fleet/clone-workspaces/), and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## Environment overrides

These variables act directly on this file's domain. The complete variable list, including the session daemon's `OMP_SESSION_*` surface, is in [Environment variables and precedence](/reference/environment/).

| Variable | Effect |
| --- | --- |
| `OMP_FLEET_CONFIG` | Path to the configuration file, replacing the default `~/.omp-web/config.json`. |
| `OMP_FLEET_LOCAL_TEMPLATE` | Replaces the `local` template's `command` outright while keeping the name `local`. Applied whether or not a config file exists. Its `host` field, if the file had one, is dropped. |
| `OMP_FLEET_WORKSPACE_DIR` | Overrides `workspaceDir`. Has no effect while the `--workspace-dir` flag is set. |
| `OMP_FLEET_SPAWN_HOOK` | Overrides `spawnHook`. Used verbatim, without `~` expansion. |
| `OMP_FLEET_BIND` | Overrides `bind`. Loses to the `--bind` flag. |
| `OMP_FLEET_BROWSER_TOKEN` | Supplies the browser access token in plaintext and replaces `browserAccessToken` for that process. Loses to the `--browser-access-token` flag, which is hashed the same way. |
| `OMP_FLEET_BROWSER_ORIGIN` | Overrides `browserOrigin`. Loses to the `--browser-origin` flag. |
| `OMP_FLEET_TRUSTED_PROXY` | Comma-separated proxies replacing `trustedProxies`. Loses to the `--trusted-proxy` flag. |

Two details, because they trip people up. First, `OMP_FLEET_WORKSPACE_DIR` and `OMP_FLEET_SPAWN_HOOK` are applied after the file is merged, so they win over the file value and also apply when there is no config file at all; only the `--workspace-dir` flag outranks `OMP_FLEET_WORKSPACE_DIR`. Second, `OMP_FLEET_CONFIG`, `OMP_FLEET_LOCAL_TEMPLATE`, and the `--workspace-dir` flag are independent of the file and always apply. Every variable in the table above is resolved per process at startup, so restart the fleet after changing one.

The development runner `bun run dev` sets `OMP_FLEET_LOCAL_TEMPLATE` so sidebar spawns run the source entry instead of an unbuilt production binary. If you run the fleet from source yourself, the same variable is how you point the `local` template at `bun apps/session/index.ts`.

## What the first-run offer writes

When no config file exists at the resolved path and stdin is a terminal, `omp-web` offers to choose a data home. Accepting writes exactly one key:

```json
{
  "workspaceDir": "/home/you/.omp-web/workspaces"
}
```

The absolute path is the chosen data home joined with `workspaces`, unless `--workspace-dir` was passed to the same `serve` command. Declining writes nothing and serves with defaults. The first-run offer is the only code path that writes this file; every other key starts at its default until you edit the file by hand.

The fleet startup banner reports which file is in use: `fleet config: <path>`, or `fleet config: (defaults)` when none exists. The browser receives the same resolved path, and the sidebar shows its first-run welcome panel while the path is null and the fleet is empty.

## Full example

A file that keeps the default local template, adds a remote template, pins one project to it, and configures a spawn hook:

```json
{
  "workspaceDir": "~/.omp-web/workspaces",
  "defaultTemplate": "local",
  "projectTemplates": {
    "omp-web": "ssh-remote"
  },
  "spawnHook": "~/providers/sandbox.sh",
  "templates": {
    "local": {
      "command": "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}"
    },
    "ssh-remote": {
      "host": "box.example.com",
      "command": "ssh box.example.com omp-web session --cwd {cwd} --port 4721 --host 0.0.0.0 --token {token} --name {name} {labels} {resume}"
    }
  }
}
```

## Failure modes

| Message | Cause |
| --- | --- |
| `unknown spawn template: <name>` | The resolved template name is not a key in `templates`. Nothing is added to the roster. |
| `endpoint timeout: no OMP_SESSION\| listening line within 30s` | The command printed no `listening` contract line in time; the child is killed and the entry marked `error`. |
| `invalid endpoint from child: <url>` | The resolved endpoint (from a wrapper line, `host` plus port, or `advertise`) is not a valid `ws://` or `wss://` URL. |
| `no spawn hook configured` | `omp-web provision` ran with neither `spawnHook` nor `OMP_FLEET_SPAWN_HOOK` set. |
| `spawn hook timed out after 60s`, `spawn hook exited <n>: ...`, `spawn hook stdout ...` | The hook exceeded its deadline, exited non-zero, or its last stdout line was not the required JSON object. |
| `refusing to bind non-loopback address "<addr>" without browser auth; ...` | The `bind` key names a reachable address, but no access token is configured. |
| `invalid config browserAccessToken: expected the 64-char sha-256 hex digest of the access token ...` | The key holds something other than a SHA-256 hex digest, which is almost always the plaintext token pasted by mistake. |
| `invalid trusted proxy literal(s): "<value>" (expected IP or CIDR, ...)` | A `trustedProxies` entry, or an environment or flag value that replaced it, is not an IP address or CIDR block. |
| `fleet: config: dropped providerProfiles."<id>": <message> (<code>)` on stderr | One profile failed validation and was skipped. The rest of the map still loads; fix the entry and restart. |
| A template ignores a value, or `--resume` never appears | The template omitted the corresponding placeholder, such as `{resume}`. |
| Everything runs on defaults after an edit | The file failed to parse and was ignored as a whole. Check the file with a JSON parser, then restart the fleet. |

## What this file does not configure

| Surface | Where it is configured | Reference |
| --- | --- | --- |
| Fleet process flags: `--port`, `--workspace-dir`, `--bind`, `--browser-access-token`, `--browser-origin`, `--trusted-proxy` | The `omp-web` or `omp-web serve` command line, with `OMP_FLEET_PORT` and the other `OMP_FLEET_*` variables as environment fallbacks. Flags always outrank the keys on this page. | [CLI commands and flags](/reference/cli/) |
| Session daemon flags: `--cwd`, `--port`, `--host`, `--advertise`, `--token`, `--resume`, `--idle-timeout`, `--name`, `--label`, and the `--callback-*` transport flags | The spawned command line, as written in a spawn template or wrapper script, or `OMP_SESSION_*` variables when you start a daemon yourself. | [CLI commands and flags](/reference/cli/), [Environment variables and precedence](/reference/environment/) |
| Agent settings: models, roles, providers, and authentication | The `omp` CLI and its `/settings`. | [Models and provider authentication](/configuration/models-and-auth/) |
| Browser preferences: theme, font size, notifications, sidebar usage, prompt history | Browser localStorage. | [Web interface preferences](/configuration/web-preferences/) |
| Fleet state, the log store, and session transcripts | `fleet-state.json`, `logs/`, and the agent's session directory. These are data, not configuration. | [Files and directories](/reference/files/) |

## Related pages

- [First run](/getting-started/first-run/) covers the setup offer that creates the file.
- [Configure spawn templates](/configuration/spawn-templates/) walks through writing a template.
- [Integrate a custom provider](/advanced/custom-provider/) owns the spawn hook contract.
- [Run a remote session daemon over SSH](/advanced/ssh/) uses a template from this file.
- [Provider profiles](/configuration/provider-profiles/) walks through the clone provider profiles key.
- [Environment variables and precedence](/reference/environment/) lists every variable the product reads.
- [Troubleshooting](/operations/troubleshooting/) covers failed spawns and fleet startup problems.
