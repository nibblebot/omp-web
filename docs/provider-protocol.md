# Provider protocol

How the fleet runs a clone workspace's session runtime on a compute provider, and what a provider has to implement. This document describes what the code enforces; when it and the code disagree, the code wins. The authoritative sources are:

| Concern | File |
| --- | --- |
| Op names, request and response shapes, validators, error codes, capabilities, profile union | [`lib/runtime/provider-protocol.ts`](../lib/runtime/provider-protocol.ts) |
| Fleet-side invocation of an executable provider | [`lib/runtime/provider-exec.ts`](../lib/runtime/provider-exec.ts) |
| Callback env handoff reader, response helpers, stdin entry for executables | [`lib/runtime/provider-callback-env.ts`](../lib/runtime/provider-callback-env.ts) |
| Session runtime environment layout, bwrap argv | [`lib/runtime/bwrap-args.ts`](../lib/runtime/bwrap-args.ts) |
| Secret reference resolution | [`lib/runtime/profile-secrets.ts`](../lib/runtime/profile-secrets.ts) |
| Fleet-side volume preparation | [`lib/runtime/prepare-workspace.ts`](../lib/runtime/prepare-workspace.ts) |
| The only caller: create, start, stop, delete, restart, delete gate | [`apps/fleet/workspace-lifecycle.ts`](../apps/fleet/workspace-lifecycle.ts) |
| Config validation and the public (secret-free) profile | [`apps/fleet/provider-profile.ts`](../apps/fleet/provider-profile.ts) |
| Preflight rows | [`apps/fleet/preflight.ts`](../apps/fleet/preflight.ts) |
| Providers | [`apps/fleet/bwrap-provider.ts`](../apps/fleet/bwrap-provider.ts), [`apps/fleet/kubernetes-provider.ts`](../apps/fleet/kubernetes-provider.ts), [`apps/fleet/host-clone-provider.ts`](../apps/fleet/host-clone-provider.ts) |

## Model

A **provider** manages one runtime per workspace: a process or pod that runs `omp-session` against the workspace's checkout and dials the fleet out over the callback pair (one WebSocket to `GET /callback/ws`, plus plain HTTP `POST /callback/bulk/<id>` for bulk transfers). The fleet never dials a session. The fleet owns every decision (generations, credentials, desired state, restarts, deletion); a provider answers four lifecycle questions about one workspace and keeps whatever it needs to answer them in the workspace's private `stateDir`.

A provider **kind** is one entry of `PROVIDER_KINDS` (`bwrap`, `kubernetes`, `host`). A **profile** is one entry of the fleet config's `providerProfiles` map: it names a kind and carries that kind's settings. A clone is bound to a profile when it is created.

There are two ways to implement a kind:

| | Executable provider | In-process runtime |
| --- | --- | --- |
| Kinds | `bwrap`, `kubernetes` | `host` |
| Where it runs | A one-shot `<executable> <op>` process per op | In the fleet process |
| Selected by | The profile's `executable` | The kind (`host-clone-provider.ts`, chosen in `#runCloneOp`) |
| Speaks | The JSON protocol below, over stdin and stdout | The same request and response objects, as function calls |
| Preflight rows | Its own `preflight` op | Produced in process (`runtime-preflight.ts`) |

Both answer the same request shape with the same response envelope, so the lifecycle drives them identically. The host *session* runtime (`apps/fleet/host-provider.ts`, used for main-checkout and worktree sessions) is a different thing: it has its own request type and is not part of this protocol. The `host` clone kind reuses its process launch mechanic (`spawnDetached`), nothing more.

## Invocation of an executable provider

The fleet runs `<executable> <op>` with an explicit argv (never a shell), writes exactly one JSON request to stdin, and reads exactly one JSON response from stdout. stderr is a human log the fleet never parses.

- **Exit status.** Exit 0 means a response was produced; the response envelope carries success or a typed failure (`ok:false` is a successful invocation of a failed operation). A non-zero exit with a valid `ok:false` envelope is reported with that envelope's code. A non-zero exit with no valid envelope, or with `ok:true`, is an `internal` failure.
- **Bounds.** Requests and responses are capped at 1 MiB (`PROVIDER_JSON_MAX_BYTES`); stdout and stderr are each collected up to that cap, and exceeding it kills the child and fails the op as `internal`.
- **Time.** Each lifecycle op has 30 seconds (`PROVIDER_OP_TIMEOUT_MS_DEFAULT`), `preflight` has 120 seconds. On expiry the child is sent SIGTERM and, one second later, SIGKILL, and the op fails as `timeout`.
- **Environment.** The child inherits the fleet's environment. That inheritance is how `env:NAME` secret references reach a provider (see [Secrets](#secrets)).
- **Transport failures** (cannot spawn, timeout, oversize output, a response that does not validate, or an `ok:true` envelope of the wrong shape for the op) are thrown by `runProviderOp` as `ProviderOpError`; a well-formed envelope, successful or not, is returned as is.
- **Entry helper.** `serveProviderRequest` implements the executable side: it reads the request (1 MiB cap), validates it, requires the argv op to equal the request's `op`, runs the handler, and writes the one-line response. A protocol error becomes a typed error envelope; anything else becomes `internal`.

Ops on one workspace are serialized by the fleet (a per-workspace queue), but a provider must not rely on it: bwrap, for example, takes a spawn lock in its `stateDir`.

## Operations

`PROVIDER_OPS` is the closed list. Every op takes the full request below.

| Op | Purpose | Success response |
| --- | --- | --- |
| `ensure-running` | Make the workspace's runtime for `generation` run. Idempotent: if it already runs at that generation, report it and start nothing. | `{ok:true, handle, observed:"running", pid?, startedAt?}` |
| `inspect` | Read-only observation of the runtime. | `{ok:true, handle, observed, pid?, startedAt?}` |
| `stop` | Terminate the runtime and prove it. Idempotent. Keeps the volume. | `{ok:true, handle, observed:"stopped"}` once termination is proven |
| `delete` | Stop if needed, then remove everything the provider created for the workspace, including its `stateDir`. Idempotent. | `{ok:true, handle, observed:"missing"}` |
| `list-sessions` | Inventory of the session files on a volume the fleet cannot read (see [Capabilities](#capabilities)). | `{ok:true, handle, observed, sessions, complete}` |
| `preflight` | Environment checks for the request's profile. Not about a workspace. | `{ok:true, checks}` |

`observed` is `running`, `stopped` or `missing`. `running` implies a live runtime for the current generation. `stopped` means a runtime existed and is proven gone. `missing` means no runtime or resource exists (never created, or deleted).

How the fleet uses each op:

- **Start** (`ensure-running` under the lifecycle's inspect-before-act rule): it inspects first when it has a persisted generation or handle, so a live runtime is never blindly recreated. A running runtime with a recoverable binding is reattached at the same generation. A running runtime without one is stopped, the stop must report not `running`, and only then does the generation increase. A stopped or missing runtime starts at `previous generation + 1` (a first start is generation 1). If `inspect` fails, the start fails: an unknown predecessor blocks replacement.
- **Stop**: a successful response whose `observed` is `running` is treated as unproven termination and refused as a `conflict`.
- **Delete**: only after the delete gate (proven stop, Git guard, transcript-store verification, read-only flip). Provider `delete` runs before the fleet removes the volume.
- **Boot reconcile and the runtime watch** call `inspect`. A desired-running clone whose runtime is proven dead after its pair came up restarts at the next generation. A failing `inspect` is logged and leaves the clone as it is (boot reconcile), or is retried on the next watch tick.
- **`list-sessions`** is called only by the delete gate (below). **`preflight`** is called only by `omp-web preflight --profile <id>`.

### `list-sessions`

Used when the volume is not readable on the fleet host (`volumeFleetVisible: false`). The provider lists every regular file (symlinks excluded) under the volume's agent sessions directory: `sessions: [{path, size, sha256?}]`, where `path` is relative to that directory (`<sessionId>/<file under the session>`, POSIX separators), `size` is the byte length and `sha256` the lowercase hex digest of those bytes. `complete:true` means the list is the whole inventory; `false` means it was truncated at the export bounds and proves nothing. The fleet then requires every file to match its stored copy byte for byte (size and digest). It refuses the deletion when the inventory is truncated, when a file has no digest, when a file differs from the store, when the op fails, and when the provider does not implement it (`invalid_request`, or an `ok` response without `sessions`). An empty complete inventory deletes. A provider whose volume is fleet-visible answers `list-sessions` with `invalid_request`; the fleet walks the volume itself and never asks.

## Request

One JSON object. Every field is validated by `validateProviderRequest`, which rejects unknown keys at every nesting level, so secret-shaped material cannot be smuggled in. Strings are non-empty and contain no NUL.

| Field | Type | Meaning |
| --- | --- | --- |
| `op` | one of `PROVIDER_OPS` | The operation. |
| `workspaceId` | string | The id of the clone workspace the operation acts on. Stable for the workspace's life and never reused; it is the roster row's id. |
| `generation` | positive safe integer | The desired runtime generation. Monotonic per workspace, never reused. |
| `workspaceDir` | string | The workspace's checkout directory (`<volume>/.checkout`). |
| `homeDir` | string | The workspace's private writable home (`<volume>/.home`). |
| `profile` | `ProviderProfile` | The profile, strict per kind (below). |
| `stateDir` | string | The provider-private per-workspace directory. |
| `handle` | string, at most 4096 | The opaque handle from an earlier response. Absent until the resource exists. |
| `source` | `{local}` or `{remote}` | The clone source, exactly one member, at most 4096 characters. For providers that prepare the volume themselves. |
| `revision` | string, at most 512 | The pinned full commit. The fleet resolves it once. |
| `branch` | string, at most 512 | The workspace branch created at the pin. |

The fleet sends `source`, `revision` and `branch` on every op for a workspace that has them. Fleet-prepared kinds ignore them.

**`preflight`** keeps the same shape. The fleet sends a placeholder identity (`workspaceId: "preflight"`, `generation: 1`) and puts the fleet's workspace volume root in `workspaceDir`, `homeDir` and `stateDir` (`buildPreflightRequest`). A provider handles it read-only: it never creates, writes or removes anything at those paths.

## Response

One JSON object, validated by `parseProviderResponse` (unknown keys rejected, 1 MiB cap). Three shapes:

```text
success:   {ok:true, handle, observed, pid?, startedAt?, sessions?, complete?}
preflight: {ok:true, checks:[{name, ok, detail, remediation?}]}
failure:   {ok:false, error:{code, message, retryable}}
```

- `handle` is required and non-empty on a lifecycle success.
- `pid` and `startedAt` are diagnostics. The fleet never keys state or decisions on them, and a pid alone is never proof of liveness or termination.
- `sessions` and `complete` appear only on `list-sessions`.
- A `preflight` success has `checks` and no `handle` or `observed`. The invocation layer rejects a lifecycle response to `preflight`, and a preflight response to any other op.
- A check's `remediation` is present on failure when an operator action can fix it.

### Error codes

`PROVIDER_ERROR_CODES`:

| Code | Use | Default retryable |
| --- | --- | --- |
| `invalid_request` | The request or profile is malformed, or the op is unknown or unsupported by this provider. | no |
| `unavailable` | A prerequisite is missing or temporarily unusable (cannot create a resource, a secret variable is unset, a runtime died during launch). | yes |
| `conflict` | A resource or generation conflicts: the runtime runs under another generation, a stale callback handoff, a foreign resource on a deterministic name, or termination could not be proven. | no |
| `internal` | The provider failed in a way that is not the request's fault. | no |
| `timeout` | Raised by the fleet's invocation layer when an op exceeds its budget. A provider does not emit it. | yes |

The provider writes `retryable` itself, per error. The fleet branches on `code`, not on `retryable`. The lifecycle surfaces a provider failure to the caller as `invalid_request`, `conflict`, `unavailable`, or `provider_failed` for anything else (`internal`, `timeout`, transport failures).

## Generation and handle

**Generation** is the fencing token. The fleet increases it for every new runtime of a workspace, revokes the old generation's callback credential first, and sends the new one on every op. A provider must:

- treat `generation` as the runtime it is asked about: `ensure-running` for a generation that already runs reports it and starts nothing; `ensure-running` for another generation while a runtime is live is a `conflict` (bwrap and host both do this); a stopped runtime of an older generation is replaced;
- refuse to start a generation whose callback handoff targets a different generation (`readCallbackEnv` throws `conflict`).

**Handle** is the provider's durable name for the resource it manages for the workspace. The fleet treats it as an opaque token: it stores it as the workspace's `providerHandle` after `ensure-running`, sends it back on later ops, and never parses it, logs it to browsers, or puts it in roster frames or `/ctl/debug`. For a given workspace and generation the handle names the same resource, and a provider must be able to find that resource again from durable identity alone, never from the handle's contents or a pid. Handles are non-empty and at most 4096 characters. Formats are the provider's: bwrap uses `bwrap:<workspaceId>:<generation>:<pid>:<procStartTime>`, host uses `host:...` likewise, kubernetes its own.

## Identity

Identity is provider-private. Each provider keeps whatever record it needs in its `stateDir`; the fleet never reads it. The rule the protocol imposes:

> Liveness and `stop` must prove that the requested generation terminated. A reusable identifier alone (a bare pid, a resource name) is never proof.

How the shipped kinds meet it:

| Kind | Record | Liveness |
| --- | --- | --- |
| `bwrap` | `<stateDir>/provider.pid.json` (`apps/fleet/bwrap-identity.ts`): pid, process start time, generation, launch token, start time | The pid is alive and not a zombie, its start time (`/proc/<pid>/stat` field 22) matches, and its command line still contains the launch token |
| `host` | The same record and the same check | The same |
| `kubernetes` | `<stateDir>/provider.k8s.json`: pod name and uid, generation, launch token | The pod exists, its uid and identity annotations (including the token) match, and it is not terminating |

The launch token travels in the runtime's argv as `--omp-workspace-token=<token>`. `stop` signals the runtime, escalates SIGTERM then SIGKILL, and reports `stopped` only after the identity no longer matches. If it cannot prove termination it answers `conflict`, and the fleet then refuses to start a second writer on the volume.

## Capabilities

Static per kind (`PROVIDER_CAPABILITIES`), answered by the fleet without running the provider:

| Capability | Values | Effect |
| --- | --- | --- |
| `preparation` | `fleet` or `provider` | Who prepares a new volume. `fleet`: the fleet clones at the pin and seeds the baseline before the first start, from a local path or a remote. `provider`: the provider prepares in place from a remote (the request carries `source.remote`, `revision`, `branch`), so a fleet-host path is not a valid source and an omitted source defaults to the project's `origin` at the main checkout's HEAD. |
| `volumeFleetVisible` | boolean | The volume is readable at the same path on the fleet host. When true: wake resume points at the host path and materializes missing transcripts, the delete gate walks the volume and cross-checks it against the store, and Fetch into project is offered for local-source clones. When false: resume uses the path the session last reported, deletion needs `list-sessions`, and the volume's work leaves through its remote. |
| `secretResolution` | `fleet-env` or `provider` | `fleet-env`: `secretRefs` values are `env:NAME` references resolved from the fleet's environment. `provider`: references are resolved by the provider or cluster API-side. |

| Kind | `preparation` | `volumeFleetVisible` | `secretResolution` |
| --- | --- | --- | --- |
| `bwrap` | `fleet` | `true` | `fleet-env` |
| `kubernetes` | `provider` | `false` | `provider` |
| `host` | `fleet` | `true` | `fleet-env` |

The public profile sent to browsers carries `preparation` so the UI offers a local source only where the fleet prepares the volume.

## Profiles

`providerProfiles` in the fleet config maps a profile id to a profile. `validateProfiles` validates each entry at load; a malformed entry is dropped with a warning and the fleet still boots. The `provider` field selects the member of the union; a key owned by another kind is a validation error on config load and an `invalid_request` on the protocol.

| Field | `bwrap` | `kubernetes` | `host` |
| --- | --- | --- | --- |
| `id` | required (the map key) | required | required |
| `provider` | `"bwrap"` | `"kubernetes"` | `"host"` |
| `executable` | required | required | not allowed |
| `resources` (`cpu`, `memory`) | allowed | allowed, applied as requests and limits | not allowed |
| `storage` (`class`, `size`) | allowed | allowed | not allowed |
| `secretRefs` | optional | optional | optional |
| `tools` | required: absolute tool paths ro-bound into the sandbox | not allowed | not allowed |
| `network` | optional: `host` or `isolated` (default) | not allowed | not allowed |
| `image`, `namespace`, `context` | not allowed | optional in config, required by the provider; `context` falls back only to the fleet's `OMP_KUBE_CONTEXT`, never to the ambient current context | not allowed |

`secretRefs` values are references only: in a request they must match `^[A-Za-z0-9._~:/@+-]+$` and be at most 512 characters, and the map may not be empty. `host` has no `executable` because the runtime is in process, and no `resources` or `storage` because the runtime enforces no limits; accepting them silently would claim an isolation it does not provide. `ExecutableProfile` (the type) is the union of the kinds that have an executable; `isExecutableProfile` narrows to it.

The public view (`toPublicProfile`, wire type `PublicProviderProfile`) crosses trust boundaries (roster frames, `/ctl/debug`): it carries the id, kind, `preparation`, `resources`, the storage class name, the `network` mode and the secret reference *names* only, never the executable, image, namespace, context or reference values.

## Preparation layout

Every clone has a private **volume** at `<clones>/<workspaceId>/` (the `clones/` directory beside the fleet's state file) and a provider-private **stateDir** at `<clones>/.provider-state/<workspaceId>/`. The request maps them: `workspaceDir` is `<volume>/.checkout`, `homeDir` is `<volume>/.home`.

```text
<volume>/
  .omp-workspace-init.json   the pin, written before the clone; the verified marker after it
  .checkout/                 the working clone, with an independent object store
  .home/                     the runtime's HOME
    agent/                   PI_CODING_AGENT_DIR; config.yml seeded at preparation
      sessions/<sessionId>/<sessionId>.jsonl     transcripts (and their companion files)
<stateDir>/
  callback-env.json          the callback env handoff (0600), rewritten before each ensure-running
  provider.pid.json          bwrap and host identity; provider.k8s.json for kubernetes
  session.log, session.log.1 bwrap and host: the runtime's combined stdout and stderr, rotated at the 1 MiB cap
                             (readers fall back to daemon.log for clones created before the rename)
```

**Fleet preparation** (`preparation: "fleet"`): the fleet resolves the source to a full commit once and persists it, clones into `.checkout` with `--no-hardlinks` (committed history only; the source repo is never shared), verifies the checkout, writes the marker, and seeds a sanitized subset of the operator's agent config into `.home/agent`. A retry reuses the persisted pin. The provider only needs the directories to exist: `ensure-running` creates `homeDir/agent` if missing.

**Provider preparation** (`preparation: "provider"`): the fleet resolves the pin and passes `source.remote`, `revision` and `branch`; the provider initializes a *new* volume once (kubernetes does it in the pod before the session starts, guarded by the verified marker so a replacement pod never re-clones), at the same pin on every retry. The kubernetes in-pod volume uses the fixed paths in `KUBERNETES_POD_LAYOUT` (`/workspace`, `.checkout`, `.home`, `.home/agent/sessions`); the fleet uses them only to recognize session file paths the runtime reports.

Stopping keeps the volume and logs. `delete` removes the provider's resources and `stateDir`; the fleet removes the volume afterwards and only after the delete gate passed.

## Callback env handoff

Before every `ensure-running` the fleet writes `<stateDir>/callback-env.json`, mode 0600:

```json
{ "version": 1, "workspaceId": "d3", "generation": 2, "env": { "OMP_SESSION_CALLBACK_URL": "...", "OMP_SESSION_CALLBACK_WORKSPACE": "d3", "OMP_SESSION_CALLBACK_GENERATION": "2", "OMP_SESSION_CALLBACK_TOKEN": "..." } }
```

`readCallbackEnv` is the reader every provider uses. It enforces:

- the file is absent: the runtime starts without a pair (stop-only management must keep working);
- `version` is 1, `workspaceId` and `generation` equal the request's; a mismatch is `conflict` ("a new generation must not start under a stale enrollment"); a corrupt file is `unavailable`;
- `env` holds only the callback keys (`OMP_SESSION_CALLBACK_URL`, `_WORKSPACE`, `_GENERATION`, `_TOKEN`, `_PROXY`, `_ALLOW_HTTP`) and the wake-resume hint keys (`OMP_SESSION_RESUME`, `OMP_SESSION_RESUME_UNWRITTEN`); any other key is rejected; every value is a non-empty string of at most 4096 characters;
- a partial callback pair is rejected, so a half-configured session never starts.

The pair reaches the session **only on stdin**, as one JSON payload read by `--fleet-stdin` (`buildFleetStdinPayload`). It never enters the runtime's argv or environment. A provider with no stdin (a pod) renders the handoff into its own spec and converts it back at the last hop: the kubernetes image entrypoint turns the pod env into the stdin payload and unsets it before `exec`. The wake-resume hint is the exception that does enter the environment: the session reads `OMP_SESSION_RESUME` (and `OMP_SESSION_RESUME_UNWRITTEN=1` for a file not known to be written) at boot, strictly, and exits 78 when the file is missing.

## The session runtime a provider launches

A provider starts the same `omp-session` entry for every kind: `<bin> <entry> [fixed args] --port 0 [--fleet-stdin] --omp-workspace-token=<token>`, resolved by `defaultRuntimeLaunch` (`OMP_RUNTIME_ENTRY` and `OMP_RUNTIME_BIN` override it; `--port 0` is added unless the operator pinned a port, because a session dials out and nobody dials in). Its working directory is `workspaceDir`.

Its environment is built by `buildSessionEnv` and is the same for every kind that runs it on the fleet host: the ambient variables in `ENV_ALLOW_KEYS` (locale, `PATH`, `TERM`, `TZ`, the `OMP_*` selection keys and the resume hint), then `HOME=<homeDir>`, `PI_CODING_AGENT_DIR=<homeDir>/agent`, `OMP_PROVIDER_PROTO=1`, `OMP_WORKSPACE_DIR=<workspaceDir>`, then resolved secrets merged last. Nothing else from the fleet's environment reaches the runtime. Because `HOME` and the agent dir live in the volume, transcripts land under `<volume>/.home/agent/sessions`, which is where wake resume, the log mirror and the delete gate look for them.

### Secrets

No secret ever travels in a request. `secretRefs` maps an environment variable name for the runtime to a reference. With `secretResolution: "fleet-env"`, the reference is `env:NAME`: the provider reads `NAME` from its own environment (the fleet's), and the value goes into the runtime's environment under the secret's key. An unknown scheme or a malformed variable name is `invalid_request`; an unset variable is `unavailable`. Reserved names (anything in `ENV_ALLOW_KEYS` or the callback keys) cannot be overridden by a secret. With `secretResolution: "provider"` (kubernetes) the reference is `<secretName>/<key>`, injected by the cluster as `secretKeyRef`; the secret must already exist and preflight verifies it.

## Security

- **Requests carry no secrets**, only reference names, and every nesting level rejects unknown keys.
- **All JSON I/O is bounded** (1 MiB), and child output is collected with a hard cap.
- **Sandboxes never mount operator state.** The bwrap provider masks the operator's home and credentials, the SSH agent, container sockets and the fleet's own state (`deriveDenyRoots`), binds only read-only system roots, the volume, the runtime package and the profile's `tools`, and by default does not share the network.
- **`host` is not a sandbox.** The session runs as the fleet user on the fleet host with that user's filesystem, network and credentials. The environment allowlist and the per-volume `HOME` are a layout, not containment: the process can still read the operator's home by absolute path. Choose the `host` kind only for work you would run directly on that machine. The fleet makes it an explicit operator choice (a profile with `"provider": "host"`) and preflight always prints a `host-isolation` row saying so.
- **The callback pair stays off argv and the environment** (stdin only); kubernetes exposes the token in the pod spec to anyone allowed to `get pods` in the namespace, so that namespace must be scoped accordingly.
- **Stop is proven**, and a second writer on a volume is never admitted while a predecessor's termination is uncertain.

## Preflight

`omp-web preflight --profile <id>` runs the fleet's host-generic rows and merges the provider's:

- Fleet rows: `profile-executable` (the executable exists and has an execute bit; for `host`, an always-passing row that says the runtime is in process), `callback-url` and `callback-ws` (with `OMP_FLEET_CALLBACK_URL` set: a DNS and TCP check, skipped when the session would dial through the `HTTP(S)_PROXY` of the fleet's environment; then a real credential-less WebSocket upgrade to `<url>/callback/ws`, bounded to 5 s with no retry, that passes when the fleet answers with its typed refusal and fails when the upgrade is refused, never answered, or answered by a non-fleet endpoint, such as a proxy or ingress that does not pass the upgrade), `durable-workspace-root`, `durable-logs-root`, `profile-secrets` (shape and resolvability per `secretResolution`).
- Provider rows, from the executable's `preflight` op: for bwrap the binary, user namespaces, runtime entry and binary, tools and denied binds; for kubernetes the kubectl binary, context, API reachability, namespace, RBAC, StorageClass, Secrets and image. For `host` there is no executable to ask, so the fleet produces `runtime-entry`, `runtime-bin` and `host-isolation` itself.
- A provider that rejects the op (an older executable answers `invalid_request`), fails to run, or returns no checks yields a failing `provider-preflight` row with remediation, never success. All rows run; the overall result is their AND.

## Versioning

`OMP_PROVIDER_PROTO` is `1`. The request has no version field; the constant is exported to the session runtime's environment (`OMP_PROVIDER_PROTO=1`) by the providers that set it. The protocol evolves additively:

- A new op or a new optional field does not bump the version. `preflight` and `list-sessions` were added this way.
- Because the request and response validators reject unknown keys, a new request field reaches only providers built with the new validator, and a provider may not add response keys the fleet's parser does not know. A change that cannot be additive has to bump the version.
- A provider that does not know an op rejects it as `invalid_request` (`validateProviderRequest` lists the known ops). The fleet fails safe in every case: `ensure-running` fails and the workspace does not start; a failing `inspect` blocks replacement of a predecessor and leaves boot reconcile as it is; `list-sessions` proves nothing and refuses the deletion; `preflight` reports a failing row.

## Writing a provider

An executable provider needs:

1. An entry that reads one op from argv and one request from stdin (`serveProviderRequest` does this and the bounds), validates it with `parseProviderRequest`, and writes one JSON response. Narrow `request.profile` to your kind and reject another kind as `invalid_request`.
2. A per-workspace identity record in `stateDir` and a liveness check that cannot be fooled by identifier reuse. Embed the launch token in the runtime's argv and verify it.
3. `ensure-running`: create `homeDir/agent`, read the handoff with `readCallbackEnv`, resolve secrets, build the runtime env with `buildSessionEnv` (or the equivalent for a remote runtime), start the runtime with the pair on stdin, wait until the identity is live, and return `observed:"running"` with a handle. Same generation again: return the running handle without starting a second runtime. Another generation while live: `conflict`.
4. `inspect`: read the identity and report `running`, `stopped` (a record whose process is gone) or `missing` (no record).
5. `stop`: signal, escalate, prove, then report `stopped`; `conflict` if proof is impossible. Idempotent.
6. `delete`: stop with proof first, remove the resources and the `stateDir`, report `missing`. Idempotent.
7. `list-sessions` if the volume is not fleet-visible, honoring the bounds and returning digests; otherwise reject it with `invalid_request`.
8. `preflight`: return rows for what only your provider can check, read-only, with a remediation on each failure.
9. A kind entry: add it to `PROVIDER_KINDS`, give it a member of `ProviderProfile` and its keys in `PROVIDER_PROFILE_KEYS`, a row in `PROVIDER_CAPABILITIES`, and the validators in `provider-profile.ts` and `parseProfile`. For an in-process kind, also select it in `#runCloneOp` and give preflight its rows.

Test an implementation against the fleet through `apps/fleet/test/` (`workspace-lifecycle.test.ts` and `clone-recovery.test.ts` drive a scripted provider through the real lifecycle).
