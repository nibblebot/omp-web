# Session runtime image (P5.4)

Reproducible container image for the Kubernetes provider
(`runtime/providers/kubernetes-provider.ts`). The packaging build ships a
complete, self-contained build context at `dist-bundle/image/`. From an
installed package (default pinned install `~/.omp-web/install/`) build it
with the absolute context path:

```sh
docker build -f ~/.omp-web/install/node_modules/omp-web/dist-bundle/image/Containerfile \
  -t omp-web-session:<tag> ~/.omp-web/install/node_modules/omp-web/dist-bundle/image
```

In a source checkout, `bun run build` assembles the same context, then:

```sh
bun run build
docker build -f dist-bundle/image/Containerfile -t omp-web-session:<tag> dist-bundle/image
```

The same definition also builds from the repo root in a source checkout:

```sh
docker build -f runtime/image/Containerfile -t omp-web-session:<tag> .
```

The image carries the pinned `bun.lock` dependencies plus git,
openssh-client, ca-certificates, and tini, and runs the same runtime entry the
bwrap provider launches fleet-side (`server/index.ts`), so session behavior
matches across providers. Both stages are pinned to the inspected development
runtime (`oven/bun:1.4.2-debian`): the agent SDK's prebuilt native addon
(`@oh-my-pi/pi-natives`) ships glibc builds only, so a musl base cannot load
it and the daemon dies at import.

`dist-bundle/image/` carries the Containerfile, the entrypoint files
(`entrypoint.sh`, `prepare-inpod.ts`, `git-ssh.sh`), `package.json`,
`bun.lock`, and the explicit `server/`, `shared/` and `runtime/` trees, so
the image build never reads the repository root. The Containerfile consumes
the entrypoints from `runtime/image/` (they ride the `runtime/` tree); the
root copies keep the context self-describing. The shipped
`server/embedded-dist.ts` is the restored stub (the empty asset map), never
the generated absolute-path asset map from the build tree.

## In-pod layout (the per-workspace PVC at `/workspace`)

| Path | Purpose |
| --- | --- |
| `/workspace/.omp-workspace-init.json` | verified initialization marker |
| `/workspace/.checkout/` | independent working clone |
| `/workspace/.home/` | private writable home; sessions at `.home/agent/sessions` |

`runtime/image/entrypoint.sh` (tini PID 1) validates the reserved pod env
(including `OMP_PROVIDER_PROTO=2` and the callback group), runs
`runtime/image/prepare-inpod.ts` on EVERY pod start, then execs the session
daemon. A genuinely empty volume is initialized and stamped with the verified
`.omp-workspace-init.json` marker; an already-initialized volume only has its
marker checked (workspace, source, pin, branch) against the pod env, so a pod
replacement keeps the existing checkout, its later commits, and untracked or
dirty working files. `prepare-inpod.ts` is the marker gate over
`runtime/prepare-workspace.ts`: it validates the marker against
`OMP_PREP_SOURCE_REMOTE`, `OMP_PREP_REVISION`, and `OMP_PREP_BRANCH`
without resetting the checkout. A corrupt or mismatched marker fails before
the daemon starts.

## Profile fields this image is built for

A Kubernetes profile declares the cluster facts the provider needs, and
preflight checks them before any workspace uses the image:
`context` (kubeconfig context, never the ambient current-context),
`namespace`, `image`, `resources` (`cpu`/`memory`), `storage`
(`class`/`size`), and `secretRefs` (`<secretName>/<key>` in the profile
namespace). The Pod is created with `restartPolicy: Never`, UID/GID/fsGroup
10001, a read-only root filesystem, dropped capabilities, the default seccomp
profile, no service-account token, no service links, and the `/workspace`
PVC mount plus a `/tmp` emptyDir. When the fleet has an agent-behavior config
to seed, the profile namespace also gets one workspace-scoped ConfigMap
(`<resourceName>-baseline`) mounted read-only at `/opt/omp-web/baseline`,
whose `config.yml` (and optional `models.yml`) the in-pod preparation copies
into `.home/agent/` before the daemon starts; the mount is a delivery channel
for that seed, not runtime config. A ready-to-edit profile lives in the
source checkout only (the installed package does not ship `fleet/`) at
`fleet/examples/kubernetes.json`.

## Build prerequisites (reported by provider preflight, never auto-provisioned)

- Operator-approved context with a reachable API and namespace-scoped RBAC for
  `get|create|delete` on `pods`, `persistentvolumeclaims`, and `configmaps`
  (the last for the sanitized baseline delivery; preflight checks all three).
- The session-runtime image built above and pullable in the profile namespace
  (`imagePullSecrets` are namespace-scoped and operator-managed). Preflight
  only checks that the profile declares an image; pullability is admitted at
  the first Pod start, where a failed pull surfaces as an actionable
  `ensure-running` failure.
- A StorageClass (or exactly one cluster default) providing `ReadWriteOnce`
  volumes.
- Any `profile.secretRefs` Secrets pre-created in the namespace, keyed as
  `<secretName>/<key>`. The baseline ConfigMap is NOT pre-created: the
  provider owns it, replaces it before each Pod creation, and deletes it with
  the workspace.
- Git credentials for the clone source, split between host pin resolution and
  the Pod's Secret-backed in-pod preparation (see Credentials and security
  model).

## Commands

```sh
omp-web preflight --profile <id>          # one row per check, non-zero on failure
omp-web add-clone <project> <name> --profile <id> --remote <git-url> --branch <branch>
                                          # registers AND starts (--no-start defers)
omp-web stop <selector>                   # deletes the Pod, keeps the PVC and logs
omp-web start <selector>                  # wakes the workspace, resumes the session
omp-web remove <selector>                 # verified deletion of Pod, PVC, and roster entry
```

## Transport to the fleet (operator prerequisite)

Sandboxed and in-pod session daemons have no inbound service: the daemon dials
the fleet's callback pair outbound, so the fleet's callback endpoint must be
reachable from inside the pod. The pair requires HTTPS except the explicit
loopback-HTTP developer exception. The daemon learns the callback URL through
`callback-env.json` written by the provider at launch, with the workspace
enrollment credential and generation; the enrollment token is readable by
anyone with pod `get` permission in the profile namespace, so scope the
namespace to trusted operators (the same exposure class as a process
environment). Production deployments set `OMP_FLEET_CALLBACK_URL` to a
routable HTTPS origin in front of the fleet, with the fleet's
`--trusted-proxy` list admitting the gateway.

The gateway exposes exactly three daemon-facing routes, matching the RAW
request path: `POST /callback/up`, `GET /callback/down`, and
`POST /callback/bulk/<id>` where `<id>` is one unescaped `[A-Za-z0-9_-]+`
segment. Every other method, path, and query is rejected at the gateway.
Real same-origin TLS gateway streaming and cluster lifecycle evidence remain
operator setup, not a shipped claim.

## Credentials and security model

- Fleet host: the kubeconfig and namespace RBAC for the profile context,
  plus the Git credential used to resolve the pin. The provider binary
  ships with the package (`dist-bundle/providers/`).
- Pod: only what `secretRefs` injects as `secretKeyRef` env, that is the
  model/tool API keys and, for SSH sources, `OMP_GIT_SSH_PRIVATE_KEY` and
  `OMP_GIT_SSH_KNOWN_HOSTS`. The image-owned `git-ssh.sh` (installed as the
  reserved `GIT_SSH_COMMAND`) expands those two into private temporary
  files and runs OpenSSH with `-F /dev/null`, `BatchMode=yes`,
  `IdentitiesOnly=yes`, and `StrictHostKeyChecking=yes`. The Pod's in-pod
  preparation clones its PVC with those Pod credentials. The callback
  enrollment credential arrives as pod env from the fleet, never from this
  image.
- Nothing else crosses: no host credential, no fleet credential, no
  kubeconfig, and no service-account token is mounted into the Pod.

The container is unprivileged (read-only rootfs, no capabilities,
`runAsUser` 10001) and no secret material is baked into the image.
Kubernetes pods share the host kernel with the rest of the cluster:
container isolation is not a kernel-level confidentiality boundary, and a
pod can read its own environment, so the profile namespace and its Secrets
must be scoped accordingly. See the security section in
[`docs/architecture.md`](../../docs/architecture.md)
and the frozen contracts in [`docs/clone-contracts.md`](../../docs/clone-contracts.md).
