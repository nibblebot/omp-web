# Session runtime image (P5.4)

Reproducible container image for the kubernetes provider
(`apps/fleet/kubernetes-provider.ts`). Build from the repo root:

```sh
docker build -f apps/session/Containerfile -t <image> .
```

The image carries the pinned `bun.lock` dependencies plus git, ca-certificates,
and tini, and runs the same runtime entry the bwrap provider launches
fleet-side (`apps/session/index.ts`), so session behavior matches across providers.

## In-pod layout (the per-workspace PVC at `/workspace`)

| Path | Purpose |
| --- | --- |
| `/workspace/.omp-workspace-init.json` | verified initialization marker |
| `/workspace/.checkout/` | independent working clone |
| `/workspace/.home/` | private writable home; sessions at `.home/agent/sessions` |

`apps/session/entrypoint.sh` (tini PID 1) runs preparation exactly once per
PVC, only when the verified marker is absent, via
`apps/session/prepare-inpod.ts`, then execs the session daemon.

## Files

- `Containerfile`: two-stage build (lockfile-pinned deps → lean runtime).
- `entrypoint.sh`: new-workspace preparation gate + daemon exec.
- `prepare-inpod.ts`: in-pod wrapper over `lib/runtime/prepare-workspace.ts`.

## Build prerequisites (reported by provider preflight, never auto-provisioned)

- Operator-approved context with a reachable API and namespace-scoped RBAC for
  `get|create|delete` on `pods` and `persistentvolumeclaims`.
- The session-runtime image built above and pullable in the profile namespace
  (`imagePullSecrets` are namespace-scoped and operator-managed).
- A StorageClass (or cluster default) providing `ReadWriteOnce` volumes.
- Any `profile.secretRefs` Secrets pre-created in the namespace.
- git credential/identity for the clone source resolved by `prepare-workspace`
  exactly as on the fleet host.

## Transport to the fleet (operator prerequisite)

Sandboxed and in-pod session daemons have no inbound service: the daemon dials
the fleet's callback pair outbound, so the fleet's callback endpoint must be
reachable from inside the sandbox or pod. The callback pair requires HTTPS
except the explicit loopback-HTTP developer exception (bwrap profiles with
`network: "host"` for dev only). The daemon learns the callback URL through
`callback-env.json` written by the provider at launch, with the workspace
enrollment credential and generation; the enrollment token is readable by
anyone with pod `get` permission in the profile namespace, so scope the
namespace to trusted operators (the same exposure class as a process
environment). Production deployments need a routable HTTPS callback endpoint
in front of the fleet, with the fleet's `--trusted-proxy` list admitting the
gateway. Real same-origin TLS gateway streaming and Kubernetes lifecycle
evidence is pending operator setup, not a shipped claim.

## Security model notes

The container is unprivileged (read-only rootfs, no capabilities,
`runAsUser` 10001) and no secret material is baked into the image: model/tool
credentials arrive as `secretKeyRef` pod env from `profile.secretRefs`, and
the callback enrollment arrives as pod env. Kubernetes pods share the host
kernel with the rest of the cluster: container isolation is not a
kernel-level confidentiality boundary, and a pod can read its own
environment, so the profile namespace and its Secrets must be scoped
accordingly. See the security section in [`docs/architecture.md`](../../docs/architecture.md)
and the frozen contracts in [`docs/clone-contracts.md`](../../docs/clone-contracts.md).
