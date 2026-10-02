---
title: Sandboxed session runtime
description: "What runs inside a clone workspace sandbox: the session daemon, the bwrap mount allowlist and seeded private home, the session-runtime image for Kubernetes, and the honest isolation limits."
---

A [clone workspace](/fleet/clone-workspaces/) runs the same session daemon every other workspace runs, except that its process lives inside a provider sandbox. This page describes what executes there, what the sandbox can see, how the private home is seeded, and where the isolation limits actually are.

## What runs in a clone

- **The session daemon.** The provider launches the runtime entry under bun with `--omp-workspace-token=<token>` as the last argv word: `apps/session/index.ts` in a development checkout, or the installed bundle's `session` mode. `OMP_RUNTIME_ENTRY` and `OMP_RUNTIME_BIN` override the resolved entry and binary.
- **A daemon with no inbound service.** Nothing dials a clone. It binds an ephemeral port (the bwrap provider appends `--port 0` unless a port is pinned, so sandboxes that share a host network namespace cannot collide) and dials the fleet's callback pair outbound: `POST /callback/up` for the NDJSON upload, `GET /callback/down` for the SSE downlink, and daemon-initiated `POST /callback/bulk/<correlationId>` for large transfers. The enrollment credential is 256-bit and generation-scoped, and it is read from the provider-state `callback-env.json` handoff (mode 0600) that the fleet writes before the runtime starts. Enrollment credentials ride request headers only, never URL paths or query strings.
- **A private home.** `HOME` is the volume's `.home/`, the agent dir is `.home/agent` (`PI_CODING_AGENT_DIR`), and the daemon writes sessions into `.home/agent/sessions`. The same volume holds `.checkout/`, the working clone.
- **A pinned checkout.** Preparation resolves the initial commit once, persists the pin in `.omp-workspace-init.json` before cloning, clones into `.checkout/` with an independent object store (`--no-hardlinks`, no alternates), and writes the verified marker last. Uncommitted source files are never transferred. The bwrap provider prepares fleet-side; the Kubernetes provider prepares in-pod at the same persisted pin, so a replacement pod never re-clones or re-resolves.

## The bwrap sandbox

The bwrap argv is built by an allowlist, not a deny-list. The host `/` is never bound.

| Category | Mounts |
| --- | --- |
| Read-only system roots | The Nix store, the current system profile, `/usr`, `/usr/local`, `/bin`, `/sbin`, `/lib`, `/lib64`, and `/opt`, each existence-checked and realpath-deduplicated. |
| Read-only `/etc` entries | Resolver and CA data plus locale identity: `resolv.conf`, `hosts`, `nsswitch.conf`, `passwd`, `group`, `localtime`, `ssl`, `pki`, and `ca-certificates`. Never the whole `/etc`. |
| Read-only runtime root | The package root carrying `node_modules/@oh-my-pi`, so the daemon can read its own dependencies. |
| Read-write workspace | The volume's private home and the checkout directory. |
| Read-only profile tools | Every absolute path in the profile's `tools`, asserted against the deny roots first. |

Deny masks are applied after the allowlist (an empty tmpfs over existing denied directories, `/dev/null` over existing denied files): the operator home, the operator ssh directory, the fleet state directory (`~/.omp-web`), the provider's own state directory, `/run/user` and `/run/user/<uid>`, `/var`, `/var/run`, `/mnt`, `/media`, `/srv`, the ssh-agent socket, and the container socket paths for docker, podman, and containerd. The clone source's own host path is masked too, so a sandbox cannot reach the repository it was cloned from.

Namespaces are `--unshare-all --die-with-parent --new-session`, with the working directory set to the checkout. A profile with `network: "host"` adds `--share-net` after `--unshare-all`, a dev-only netns share that makes a loopback callback URL reachable; pid, user, and ipc isolation stay intact, and an absent `network` key means a fresh isolated netns.

The sandbox environment is an allowlist: `HOME`, `PATH`, `TERM`, locale and timezone variables, the session and workspace keys (`OMP_SESSION*`, `OMP_WORKSPACE_*`, `OMP_PROVIDER_PROTO`, `OMP_AGENT_DIR`), and the daemon-set export keys (`PI_EXPORT`, `PI_SESSION_ID`). Credential-shaped keys (`PI_AUTH_*`, `PI_PROFILE`, `PI_CONFIG_DIR`), the ssh agent variables, `XDG_RUNTIME_DIR`, and the fleet config and state paths never pass. Profile secret values merge last, after the allowlist, and cannot override a reserved key. There is no operator agent directory mount: the sandbox sees only the seeded copy described next.

## The seeded private home

A fresh clone would otherwise boot at SDK defaults, so preparation seeds a sanitized copy of the operator's global agent config into `.home/agent/`:

- **`config.yml`.** The source is `OMP_SANDBOX_BASELINE_CONFIG` when set, otherwise the first existing `config.yml` or `config.yaml` under `$PI_CODING_AGENT_DIR`, then `$XDG_DATA_HOME/omp/agent`, then `~/.omp/agent`. Only an allowlist of agent-behavior keys is copied: model roles and enabled models, provider ordering and tags, cycle order, thinking and sampling settings, retry, loop guards, tool approval, bash patterns, task concurrency, plan, steering and follow-up modes, memory backend, TTSR, and compaction thresholds. Credential leaves cannot cross because none of their paths are allowlisted, and a shape filter drops host-bound values (`~/...`, absolute paths, `http://` URLs) even under an allowlisted key. The remote-compaction keys are dropped because an isolated sandbox cannot reach the operator's compaction service.
- **`models.yml`.** When a `models.yml` or `models.yaml` sits beside the source `config.yml`, custom provider definitions are seeded too, sanitized: a value that names an environment variable present in the seed environment stays as an environment reference, a literal provider `apiKey` is rewritten to the `PROVIDER_ID_UPPER_SNAKE_API_KEY` convention (for a provider `tokenrouter`, `TOKENROUTER_API_KEY`) so a profile's injected key can bind to it, `!cmd` host shell commands and `transport: "pi-native"` providers are dropped, and headers survive only as environment references. Literal secrets are never copied.
- **Role coherence.** `modelRoles` entries and `cycleOrder` members are filtered to providers the sandbox can actually resolve: custom providers whose referenced or rewritten environment variable the profile injects, plus catalog providers whose usual environment variable is carried, or every catalog provider when the sandbox borrows credentials from an auth broker.

Seeding is best-effort and never overwrites an existing file. It runs again during preparation of an already-prepared volume, so volumes created before this feature gain the files on their next prepare. If nothing survives the filter, no file is written.

## The Kubernetes session-runtime image

`apps/session/Containerfile` holds the reproducible image definition for the kubernetes provider (with `entrypoint.sh`, `prepare-inpod.ts`, and `image-README.md` beside it). Build it from the repo root:

```sh
docker build -f apps/session/Containerfile -t <image> .
```

- **Two stages.** The first resolves the repo's pinned `bun.lock` with `bun install --frozen-lockfile --production`; the second is a lean runtime stage with git, ca-certificates, and tini, carrying `package.json`, `apps/`, and `lib/`.
- **The same runtime entry as bwrap.** The image runs the same runtime entry the bwrap provider launches (`apps/session/index.ts`), so session behavior matches across providers.
- **One initialization per volume.** tini is PID 1 and runs `entrypoint.sh`, which requires `OMP_WORKSPACE_ROOT`, `OMP_WORKSPACE_ID`, and `OMP_WORKSPACE_GENERATION`, prepares a new volume exactly once (only when the verified `.omp-workspace-init.json` marker is absent, through `apps/session/prepare-inpod.ts` over `lib/runtime/prepare-workspace.ts`), then execs the daemon with `--omp-workspace-token`. A pod that starts on a claim that already holds the marker never re-clones and never re-resolves.
- **Unprivileged.** The container runs as user and group 10001 with a read-only root filesystem, all capabilities dropped, `allowPrivilegeEscalation: false`, `runAsNonRoot`, and the `RuntimeDefault` seccomp profile. `/workspace` (the PVC) and an emptyDir `/tmp` are writable, and the pod never mounts a service-account token.
- **No baked secrets.** Model and tool credentials arrive as `secretKeyRef` environment entries from the profile, and the callback enrollment arrives as pod environment from the fleet's handoff file.

One workspace is one Pod plus one `ReadWriteOnce` PVC and nothing else: no Service, no Ingress, `restartPolicy: Never`. Stop retains the claim.

## Cluster prerequisites and transport

Everything here is operator-managed; omp-web never creates it.

| Prerequisite | Detail |
| --- | --- |
| API access | An operator-approved kubeconfig context with a reachable API, plus namespace-scoped permission to `get`, `create`, and `delete` `pods` and `persistentvolumeclaims`. No cluster-wide grant is needed, and the provider never consults the ambient current-context. |
| Image | The session-runtime image above, built and pullable in the profile namespace. `imagePullSecrets` are namespace-scoped and operator-managed. |
| Storage | A StorageClass, or a cluster default, providing `ReadWriteOnce` volumes. |
| Secrets | Every `secretRefs` Secret pre-created in the namespace with the referenced keys. |
| Git access | Git credential and identity for the clone source, resolved by the preparation step exactly as on the fleet host. |
| Callback endpoint | The fleet's callback endpoint must be reachable from inside the pod or sandbox. HTTPS is required except the explicit loopback-HTTP developer exception, so production needs a routable HTTPS callback endpoint and a same-origin TLS gateway, with the fleet's `--trusted-proxy` list admitting that gateway. |

The status of these claims is honest. bwrap smoke exists and the direct-versus-callback load comparison passed in this runtime, and the streaming callback path works over explicit loopback HTTP. Real Kubernetes lifecycle evidence (there is no operator cluster) and production same-origin TLS gateway plus streaming-proxy failure and recovery evidence are pending operator setup, as are the multi-runtime and fairness load dimensions.

## Validation

`omp-web preflight --profile <id>` is the local gate before any workspace uses a profile. For bwrap profiles it checks the bwrap binary and runs a real mount/namespace probe, resolves the runtime entry and the bun binary, and checks the provider executable, the profile tools, the denied binds, the `env:` secrets, and the durable state directories. For kubernetes profiles it checks the executable and the declared context, namespace, and image, and reports the declared storage when set. The battery never provisions anything, never writes to the callback socket, and prints a `fix:` line for every failure. [Provider profiles](/configuration/provider-profiles/) lists every check.

The provider executables themselves must be present and preflighted per host (bwrap) or cluster (kubernetes) before workspaces use them, and provider preflight fails loudly on an unmet promise rather than launching a weaker sandbox.

## Honest isolation limits

- Both providers share the host kernel. bwrap uses namespaces and Kubernetes uses containers; neither is a virtual machine, and neither provides a kernel-level confidentiality boundary against a compromised host or node.
- Model and tool credentials reach the sandbox as environment values that the sandboxed process can read: bwrap injects the resolved `secretRefs` values as environment, and Kubernetes sets `secretKeyRef` pod environment entries.
- The Kubernetes enrollment token is readable by anyone with pod `get` in the operator-approved namespace, the same exposure class as a process environment, so that namespace must be scoped to trusted operators.
- Operator credentials, the ssh agent, container sockets, and fleet/provider administration state are never mountable into a bwrap sandbox, and the Kubernetes pod has no such mounts and no service-account token. Enforcement is by allowlist rather than deny-list, so the surfaces above are the honest residual exposure, not an oversight.

## Related

- [Clone workspaces](/fleet/clone-workspaces/)
- [Provider profiles](/configuration/provider-profiles/)
- [Stored sessions](/analysis/stored-sessions/)
- [Security model](/operations/security/)
- [Networking and browser access](/operations/networking/)
- [Architecture overview](/advanced/architecture/)
