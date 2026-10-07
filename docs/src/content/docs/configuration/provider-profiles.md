---
title: Provider profiles
description: "Declare the sandboxed bwrap or Kubernetes environments that manage clone workspaces under the fleet config's providerProfiles key."
---

A provider profile is a declarative description of the external provider executable that manages [clone workspaces](/fleet/clone-workspaces/). Profiles live in the fleet config file under the `providerProfiles` key, keyed by profile id. Each profile carries the provider kind, the executable the fleet spawns, the tools and limits the sandbox receives, and the secret references the runtime may resolve. The sandbox itself, including its mount policy and seeded home, is described in [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## The config file

The fleet reads `~/.omp-web/config.json` by default, or the file named by `OMP_FLEET_CONFIG`. The first-run offer is the only writer; hand edits are read at the next start, and unknown keys are tolerated. Profiles are boot-static: edit the file and restart the fleet to load a change.

```json
{
  "providerProfiles": {
    "bwrap-dev": {
      "provider": "bwrap",
      "executable": "~/.omp-web/install/node_modules/omp-web/dist-bundle/providers/bwrap-provider.js",
      "tools": ["/usr/bin/git"],
      "network": "host",
      "secretRefs": { "ANTHROPIC_API_KEY": "env:ANTHROPIC_API_KEY" }
    },
    "k8s-prod": {
      "provider": "kubernetes",
      "executable": "~/.omp-web/install/node_modules/omp-web/dist-bundle/providers/kubernetes-provider.js",
      "tools": [],
      "context": "prod-cluster",
      "namespace": "omp-clones",
      "image": "registry.example.com/omp-session-runtime:1.4.0",
      "resources": { "cpu": "2", "memory": "4Gi" },
      "storage": { "class": "fast-ssd", "size": "20Gi" },
      "secretRefs": { "ANTHROPIC_API_KEY": "omp-model-keys/anthropic" }
    }
  }
}
```

## Fields

| Key | Required | Meaning |
| --- | --- | --- |
| (map key) | yes | The profile id. A profile's optional `id` field must equal it. |
| `provider` | yes | `"bwrap"` or `"kubernetes"`. |
| `executable` | yes | The provider executable the fleet spawns as `<executable> <op>`, with one JSON request on stdin (`ensure-running`, `inspect`, `stop`, `delete`). Absolute, a name on `PATH`, or `~`-prefixed; a leading `~` expands to your home directory. The installed bundle ships both providers under `dist-bundle/providers/`. |
| `tools` | yes | Absolute tool paths the sandbox receives as read-only binds (bwrap). Bare names cannot be bound, and every path must exist on the fleet host. |
| `resources` | no | `cpu` and `memory` strings such as `"500m"` and `"512Mi"`. Kubernetes applies them as both requests and limits. |
| `storage` | no | `class` (a StorageClass name; the cluster default when omitted) and `size` (PVC size, default `10Gi`). Kubernetes only. |
| `secretRefs` | no | Map of sandbox environment variable name to an external secret reference, described below. |
| `image` | k8s | The session-runtime image for the pods. |
| `namespace` | k8s | The operator-prepared namespace the pod and PVC live in. |
| `context` | k8s | The explicit kubeconfig context. The ambient kubectl current-context is never used; `OMP_KUBE_CONTEXT` in the fleet environment is the fallback. |
| `network` | no | bwrap only: `"host"` shares the host network namespace, a dev-only mode so a loopback callback URL is reachable from inside the sandbox. `"isolated"` or absent keeps a fresh netns and needs an HTTPS callback URL routable from the sandbox. |

A field that only applies to the other provider is inert, and preflight reports it as informational instead of failing.

## Validation

Validation is shape-level and total. Every entry is checked at load, a malformed entry is dropped with one warning on the fleet's stderr, and the fleet still boots on the valid remainder:

```
fleet: config: dropped providerProfiles."bwrap-dev": executable is required: a non-empty path (absolute, on PATH, or ~/ prefixed) (invalid_request)
```

- `invalid_request` reports a shape problem: an unknown `provider`, a missing `executable`, a `tools` entry that is not a non-empty string, a bad `network` value, and similar.
- `invalid_identity` reports a key problem: an empty or unusable key (`__proto__`), or an `id` field that does not equal its map key.
- If `providerProfiles` itself is not an object, the whole key is ignored with one warning.
- Unknown keys inside a profile are tolerated.

A dropped profile does not exist for clone creation: creating against its id fails typed `unavailable`, and it is absent from the catalog below.

## Secret references

`secretRefs` maps the environment variable name the sandbox should carry to an external reference. Only names cross the fleet's requests and state files; values are resolved outside that path.

| Provider | Reference | Resolution |
| --- | --- | --- |
| bwrap | `env:NAME` | The provider reads `NAME` from its own process environment at launch. Its supervisor receives key names only and pulls the values from its own environment, so values never touch the request JSON, the argv, or the provider state directory. A variable that is not set fails the launch as `unavailable` and names the variable. |
| kubernetes | `<secretName>/<key>` | The provider injects a native `secretKeyRef` pod environment entry in the profile namespace. The Secret must already exist; omp-web never creates Secrets. |

Secret values merge after the sandbox's ambient environment allowlist and cannot override a reserved key (the callback enrollment keys, `HOME`, `PATH`, workspace identity, and the rest of the allowlist). The full key policy is in [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## The secret-free public view

The browser and the CLI never see a profile's executable, image or namespace details, or secret values. The projection keeps the id, provider, resource limits, storage class name, network mode, and secret reference names.

- `omp-web profiles` prints the catalog as a table with columns `id`, `provider`, `cpu`, `memory`, `storage`, `secrets`, and `network`. With no profiles configured it prints exactly `no provider profiles configured (set providerProfiles in the fleet config)` and exits 0.
- The browser receives the same list on the `registered_projects.providerProfiles` frame, absent on older fleets, which implies an empty catalog. The Clone tab's profile dropdown renders that list.

## Development auth broker

Default `bun run dev` starts the fleet and Vite without broker token creation, authenticated probing, adoption, spawning, restarting, or automatic broker environment export. To make a broker available before the fleet child starts, explicitly opt in with:

```sh
bun run dev --auth-broker
```

With that flag:

- It first probes for a broker already running on the default bind (`http://127.0.0.1:8765`) with the operator's bearer token and adopts it. The credential store is global, so one broker serves every worktree.
- Otherwise it spawns `omp auth-broker serve` as a restartable child and waits for readiness. Whether adopted or spawned, its `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` are exported into the environment the fleet and its providers inherit.
- A missing `omp` CLI, an unreadable token, or a start timeout logs a warning and lets the stack continue. Sandboxes that need broker-borrowed credentials cannot resolve them without another explicit credential source.

Production `omp-web` never manages broker startup. Local sessions use the user's ordinary SDK credentials. Isolated clone sandboxes need explicitly configured credentials through `secretRefs`, or an operator-run broker (`omp auth-broker serve`) whose URL and token their profile injects. Explicitly supplied `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` and existing profile `secretRefs` remain opt-in configuration; default dev inherits them without replacement or automatic broker work.

Sandboxes borrow OAuth-based provider credentials from the broker at runtime; refresh tokens stay on the broker. A bwrap sandbox reaches a loopback broker only under `network: "host"`. In a sandbox, an OAuth provider counts as resolvable exactly when both broker variables are injected, and seeded model-role entries for such providers survive only then.

## Preflight

`omp-web preflight --profile <id>` loads the config exactly as `serve` does (honoring `OMP_FLEET_CONFIG`), runs a check battery against the named profile, prints `profile <id>: ready` or `profile <id>: NOT ready` with one line per check, and exits non-zero when any check fails. A failing check carries a `fix:` line. Nothing is auto-provisioned: no check installs a tool, creates a cluster, namespace, Secret, or credential.

| Check | What it proves |
| --- | --- |
| `profile-executable` | The executable exists and carries an execute bit. |
| `profile-tools` | Every tool path is absolute and present. |
| `denied-binds` | The workspace root and the profile tools sit outside operator home and ssh state, container sockets, and fleet/provider state. |
| `profile-secrets` | bwrap: every `env:` variable is set on the fleet host. Kubernetes: informational, because values resolve API-side. |
| `durable-workspace-root`, `durable-logs-root` | The workspace root and the log store root are writable, or can be created by the fleet. |
| `callback-url` | When a callback URL is supplied, DNS resolves and a TCP connect succeeds; nothing is ever written to the socket. The CLI runs without one, so the row passes as `not configured` today. |
| `bwrap-binary`, `bwrap-userns` | bwrap profiles only: the binary runs, and a real mount/namespace probe succeeds. |
| `runtime-entry`, `runtime-bin` | bwrap profiles only: the session runtime entry and the bun binary resolve on the host. |
| `k8s-context`, `k8s-namespace`, `k8s-image` | Kubernetes only: the required explicit context, namespace, and image are configured. `k8s-storage` reports the declared class and size when set. |
| `k8s-fields` | Informational: k8s-only fields configured on another provider are inert. |

Kubernetes API reachability, namespace-scoped RBAC, the StorageClass, and each Secret are cluster-side prerequisites that stay with the operator. The local battery reports the profile's declarations, not the cluster state; see [Sandboxed session runtime](/advanced/sandbox-runtimes/) for the full list.

## Related

- [Clone workspaces](/fleet/clone-workspaces/)
- [Sandboxed session runtime](/advanced/sandbox-runtimes/)
- [Configuration schema](/reference/configuration/)
- [Environment variables and precedence](/reference/environment/)
- [CLI commands and flags](/reference/cli/)
