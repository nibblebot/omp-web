# Complete the Kubernetes worker lifecycle

## Context

Complete the Kubernetes provider so a configured fleet can start a worker automatically, retain its checkout and sessions when stopped, resume it, and delete it after verification. Use the existing provider operations, callback transport, log store, and session materialization code. Prove the lifecycle on a disposable minikube cluster and record the evidence in `docs/clone-plan.md`.

## Approach

Implement the stages in order. Update affected callers and focused tests within each stage. Keep Kubernetes API work in the provider, lifecycle decisions in the fleet, and session work in the daemon.

### 1. Bind each Kubernetes workspace to its resources

**Files:** `shared/provider-protocol.ts`, `fleet/registry.ts`, `fleet/workspace-lifecycle.ts`, `runtime/provider-exec.ts`, and the two files in `runtime/providers/`.

1. Set `OMP_PROVIDER_PROTO = 2` and add `providerProto: 2` to requests and responses. Update both provider entrypoints, the invoker, environment values, and fixtures together. Keep the existing request fields and successful response fields `handle` and `observed`. Reject missing or different versions before dispatch. Map provider errors to lifecycle errors: invalid input and conflicts retain their codes, unavailable dependencies become `unavailable`, timeouts become `retryable`, and internal failures become `provider_failed`.

2. Add `KubernetesBinding = { resourceIdentity: string; context: string; namespace: string; namespaceUid: string }` in the shared provider contract. Require `request.kubernetes` for all Kubernetes operations and reject it on bwrap requests. Add `kubernetes: { namespaceUid: string; podUid: string | null; pvcUid: string | null }` to successful Kubernetes responses. Validate every field through the existing strict parsers.

3. Persist `providerKind` and the binding in `WorkspaceRecord`. Generate `resourceIdentity` from 16 random bytes encoded as lowercase hex. Validate source, callback, and environment settings, then resolve the pin, context, and namespace UID before registration. Pass the complete workspace to the existing `Registry.create` for one atomic save. Use `<workspaceDir>/.kubernetes/<resourceIdentity>/` for provider state and `omp-ws-<resourceIdentity>` for the Pod and PVC names.

4. During startup, resolve legacy bwrap records from their verified local preparation marker. Mark Kubernetes records without a persisted resource binding as `unavailable` and retain their resources for manual recovery. Complete this step before enrolling callbacks or accepting lifecycle requests. Reject later changes to the stored provider kind, context, namespace, or namespace UID as `conflict`.

5. Replace `ownedByWorkspace` with one validator used by all four Kubernetes operations. Check managed-by, workspace, full profile ID, resource ID, namespace UID, and object UID. For Pods, also check the exact positive decimal generation and the existing provider launch token. Fix `profileLabel` by trimming trailing hyphens after truncating to 63 characters.

   Keep the provider launch token in its existing record and Pod annotation. Separately, save the callback credential digest returned by `enrollWorkspace` in the record and Pod annotation. It hashes the decoded credential bytes. Compare it with the handoff before reusing or adopting a Pod. The raw callback credential belongs in the protected handoff and Pod environment; redact it from fleet responses and logs.

6. Store `sourcePinDigest` on each Pod and PVC under the existing `omp-web.omp.dev/` annotation prefix. Compute it as lowercase SHA-256 of UTF-8 `JSON.stringify([source.remote, revision, branch])`. Compare the request tuple with provider state and compare its digest with Kubernetes metadata. Validate the full preparation marker after the PVC is mounted.

7. Serialize lifecycle operations per workspace and lock each provider operation with `acquireFileLock`. Strengthen `shared/file-lock.ts` to check PID, process start time, and a random owner token. Concurrent stale-lock recovery must produce one owner, and release must preserve a replacement owner. Treat unreadable ownership as busy. Keep the state directory until the provider releases the lock and exits; the fleet can then remove it after confirmed resource deletion.

   - `ensure-running`: validate source, handoff, Pod, and PVC before creating or replacing anything. Reuse an owned running Pod and retained PVC. Adopt resources after a lost provider record only when their persisted identities agree.
   - `inspect`: read both objects and report `missing`, `stopped`, or `running`. A Pod without its claim is a conflict.
   - `stop`: validate and delete the requested Pod, wait for its absence, and retain the claim. Pod absence succeeds. Stop can operate when the callback handoff is missing because ownership comes from the resource binding and launch record.
   - `delete`: validate every present object before the first deletion. Delete with Kubernetes UID preconditions and wait for absence. Repeated deletion succeeds after both objects are absent.

   Recheck the namespace UID before returning from ensure. If it changed during the operation, return `conflict` and retain observed resources for inspection.

### 2. Start and resume the intended session

**Files:** `runtime/prepare-workspace.ts`, `runtime/image/prepare-inpod.ts`, `runtime/image/entrypoint.sh`, `server/config.ts`, `server/index.ts`, `server/session-materialize.ts`, and `fleet/workspace-lifecycle.ts`.

1. Add a shared pure `validateKubernetesSource` helper to `shared/provider-protocol.ts`. Accept absolute `git:`, `https:`, and `ssh:` URLs with a host and repository path. Allow an SSH username; reject passwords, other URL userinfo, whitespace, query strings, fragments, local paths, `file:` URLs, and option or helper syntax. Preserve the validated source text for pin resolution and identity checks. Require a remote source before registering a Kubernetes clone.

   Complete the branch validator in `runtime/prepare-workspace.ts` and export it for admission checks. Reject invalid Git ref components such as `foo//bar`, `foo/.bar`, `foo.`, and components ending in `.lock`. Resolve the requested revision once through `resolveWorkspacePin` and persist its full lowercase commit ID before preparation.

2. Consolidate callback file readers and the lifecycle writer in `runtime/callback-env.ts`. Keep `{version:1, workspaceId, generation, env}` and `callback-env.json`. Write through a temporary file opened with `wx` and mode 0600, fsync it, rename it, and fsync the parent. Reject symlinks, invalid parents, oversized content, and identity mismatches. Kubernetes ensure requires the callback URL, workspace, generation, and credential. Validate `env` against the shared allowlist.

3. Add `lastAttemptedGeneration` to the workspace record. Under the workspace operation queue, prove the predecessor stopped, save the next generation and enrollment digest, write the handoff, attach the log tap, and enroll before invoking ensure. Retain the attempted generation and original handoff after a launch failure. A retry inspects that attempt and reuses its credential; a replacement uses a larger generation. Reattaching a live Pod reuses its original launch inputs.

4. In `prepare-inpod.ts`, require the supplied source, revision, and branch. Initialize an empty volume through `prepareWorkspace`. For an initialized volume, read and validate its marker without resetting the checkout. Compare workspace, source, pin, and branch from the marker; preserve later commits and working files. Reject a corrupt or mismatched marker before starting the daemon.

5. Require `OMP_WORKSPACE_DIR` in the entrypoint and launch:

   ```sh
   exec bun /opt/omp-web/server/index.ts \
     --cwd "$OMP_WORKSPACE_DIR" --port 0 \
     --omp-workspace-token="$OMP_WORKSPACE_TOKEN"
   ```

   Emit exactly one `OMP_SESSION_IDLE_TIMEOUT=0`. Validate reserved environment names before any Kubernetes API call. Reuse the rules in `runtime/bwrap-args.ts`, including the preparation, callback, home, path, and provider version names. Validate each Secret reference while leaving its value in Kubernetes.

6. Extend `#resolveWakeResume` to select the explicit session or the last session recorded by the fleet or store. A missing requested session returns `unavailable` before compute starts. Map the main file beneath `/workspace/.home/agent/sessions/` and add `OMP_SESSION_RESUME` and `OMP_SESSION_RESUME_REQUIRED=1` to the handoff allowlist. Parse `--resume-required` and its environment setting in `server/config.ts`. Choose a new session only when the fleet and store have no previous session identity.

   Move callback construction and log-store materialization setup ahead of required resume in `server/index.ts`. Establish the authenticated pair, restore missing files through `materializeSessionToDir`, acquire the target session lock, switch sessions, then open readiness. Use the existing `shared/wake-materialize.ts` request, cursor, file hashes, and 64 MiB transfer limit. Check the main file itself when deciding whether restoration is needed. Remove only the selected stale lock after the fleet has proved predecessor termination. Required resume failure exits before readiness.

7. Define fleet readiness from the authenticated pair plus the daemon's existing `hello_ok` and `ready` frames on an internal virtual stream. Check the expected cwd and requested session file. Register the control and log listeners before binding fleet callback routes, and repeat the readiness check when a surviving Pod reconnects.

### 3. Collect final evidence before stopping and deleting

**Files:** `shared/callback-protocol.ts`, `server/daemon-control.ts`, `server/quiesce-evidence.ts`, `fleet/workspace-lifecycle.ts`, `fleet/server.ts`, and `fleet/daemon-transport.ts`.

1. Add `fleet/clone-quiesce.ts` to own the fleet request, timeout, and receipt validation. Reuse `createDaemonControl`, writer flushing, `FlushBoundary`, `ManifestFile`, `CloneGitEvidence`, and `verifyWorkspaceLogs`.

2. Add two control payloads to `shared/callback-protocol.ts`:

   ```ts
   type QuiesceCloneControl = {
     type: "quiesce_clone";
     requestId: string;
     correlationId: string;
     sourceRemote: string;
     pinnedRevision: string;
     branch: string;
   };
   type QuiesceCloneResult = {
     type: "quiesce_clone_result";
     requestId: string;
     correlationId: string;
   } & ({ ok: true } | {
     ok: false;
     error: { code: CallbackErrorCode; message: string };
   });
   ```

   Send the request on the existing transport stream and acknowledge it with `ControlAckPayload`. Handle it in a Kubernetes-specific branch of `createDaemonControl`. Check the authenticated envelope's workspace, generation, and connection fields. Unsupported controls return the existing typed error.

3. Transfer the evidence JSON through `createBulkCorrelation({capture:true})` and `FleetCallback.requestBulkUploadParts`. Include `requestId`, `mainSessionRelpath`, and the existing quiesce `boundary`, `manifestFiles`, `provenance`, `writers`, and `git` fields. Make all evidence fields required and type `manifestFiles` as `ManifestFile[]`. Permit a null main path only when both the volume and store contain no main transcript. Enforce the existing 64 MiB bulk limit. Add `cancelBulkCorrelation` to release abandoned captures on timeout and shutdown.

4. Run the stop admission checks, close command admission, flush all reachable writers, dispose the session, finalize the tailer, and wait for the fleet's acknowledgements. Then collect and upload evidence. Keep admission closed after disposal until the Pod terminates. Cache the outcome by request ID for the lifetime of that daemon.

   Persist `{requestId, generation, podUid, pvcUid, state}` before sending the request, where `state` is `pending`, `verified`, or `invalid`. Save validated evidence before invoking provider stop. After a fleet restart, recheck the same Pod UID before requesting cached evidence through a fresh bulk correlation. A changed Pod or incomplete proof invalidates the receipt.

5. In `collectGitEvidence`, use the stored source URL and pin supplied by the fleet. Read the checkout's raw origin with includes disabled and compare it to that URL before network access. Run network probes from a temporary bare repository with the operator credential settings captured at startup. Import local heads and tags into that repository, fetch the supplied remote, and prove each local tip is preserved by its advertised refs. Include detached HEAD and annotated tags. A newly created branch at the preserved pin passes. Any failed Git or stash probe produces unknown evidence and blocks deletion.

   Capture the host's credential settings and the Pod's credential environment before workspace code runs. Reconstruct only those settings for preparation and network probes. For SSH, add an image-owned `runtime/image/git-ssh.sh` wrapper. It reads `OMP_GIT_SSH_PRIVATE_KEY` and pinned `OMP_GIT_SSH_KNOWN_HOSTS` from Secret references, creates private temporary files, and runs OpenSSH with `-F /dev/null`, `IdentitiesOnly=yes`, and `StrictHostKeyChecking=yes`. Set its path as a reserved `GIT_SSH_COMMAND` and remove temporary files on exit.

6. Validate the receipt against the exact fleet store file set, hashes, sizes, writer results, and per-stream generation/offset/eof boundaries. Reuse the `logs/<sessionId>/<relpath>` mapping from the fleet log tap. Require the main path to identify one manifest entry. Bind the receipt to the workspace resource ID, generation, namespace UID, and PVC UID.

   Dirty Git evidence permits ordinary stop and preserves the PVC. Missing evidence causes stop to retain storage and report the verification failure. Delete requires a stopped workspace, a matching valid receipt, clean Git evidence, and a verified store. Mark the store read-only, invoke provider delete, then remove the roster entry. Clear a rejected deletion attempt so the user can wake the workspace, preserve changes, stop, and retry. Persist partial provider deletion for an idempotent retry.

7. Dispatch resource cleanup in `fleet/server.ts` by the persisted provider kind. Kubernetes cleanup removes provider state after confirmed Pod/PVC deletion. Bwrap cleanup uses the existing guarded local-volume path. Return public entry projections from clone routes and keep bindings, credentials, receipts, source details, and provider handles private.

### 4. Wire preflight and the installed image

**Files:** `runtime/preflight.ts`, `fleet/cli.ts`, `cli/omp-web.ts`, `runtime/image/Containerfile`, and `scripts/build-omp-web.ts`.

1. Add `kubeExec?: KubeExec` to `PreflightContext`. Have `runProfilePreflight` call `preflightKubernetesProfile` for Kubernetes profiles, alongside executable, callback, and durable-directory checks. Remove the duplicate Kubernetes summary checks from that branch. Convert executor failures into rows with remediation.

2. Add `parseKubernetesCallbackUrl(value: string): string` beside `isLoopbackHost` in `server/config.ts`. Accept an HTTPS origin with an optional root slash. Validate explicit ports and reject loopback, unspecified addresses, credentials, other paths, queries, and fragments. Use it in admission, handoff validation, and preflight. Pass `OMP_FLEET_CALLBACK_URL` and the fleet environment from `preflightCmd`; add `preflight` to the installed dispatcher and usage.

3. Check explicit context, namespace access, Pod/PVC get/create/delete rights, the selected StorageClass, and referenced Secret key names. Require one default StorageClass when the profile omits a class. Label DNS/TCP callback checks as reachability from the fleet host. Missing tools or permissions produce failed checks with specific remediation.

4. Bound Kubernetes operations in one shared timeout helper in `runtime/provider-exec.ts`. Parse wait overrides as integers from 1 through 300,000 ms. Give inspect 240,000 ms; ensure its ensure and stop waits plus 240,000 ms; stop its stop wait plus 240,000 ms; delete twice its delete wait plus 240,000 ms. Pass an additional 5,000 ms to the outer invoker for process termination. Every API call and poll uses the remaining operation deadline, capped at 60,000 ms per call. Bound pin resolution at 60,000 ms, quiesce at 30,000 ms, callback readiness at 60,000 ms, and restoration at 120,000 ms. Await terminated child processes.

5. Pin both image stages to `oven/bun:1.4.2-alpine`, matching the inspected development runtime. Include Git, OpenSSH, CA certificates, and tini. Use explicit directory copies for `server/`, `shared/`, and `runtime/`. Build `dist-bundle/image/` as a complete context containing these directories, `package.json`, `bun.lock`, the Containerfile, and entrypoint files. Copy `server/embedded-dist.ts` after the build restores its stub.

6. Add `fleet/examples/kubernetes.json`. Update `README.md`, `runtime/image/README.md`, and `docs/clone-contracts.md` with the bundled provider path, explicit context, namespace, image, resources, storage, Secret references, and HTTPS gateway. Show the separate host and Pod credential setup and the preflight, automatic `add-clone`, stop, start, and remove commands. Define the gateway allowlist as POST `/callback/up`, GET `/callback/down`, and POST `/callback/bulk/<id>`. Match the raw path; `<id>` is one unescaped `[A-Za-z0-9_-]+` segment. Reject other methods, paths, and queries.

### 5. Add a disposable minikube acceptance command

Create `scripts/test-kubernetes-minikube.ts` and the package command `test:kubernetes:minikube`. Use the production `startFleet`, transport, lifecycle, and built provider.

1. Capture environment values and install the cleanup owner and signal handlers before creating resources. Use a private temporary root, unique minikube profile and namespace, isolated `MINIKUBE_HOME`, `KUBECONFIG`, Docker configuration, fleet paths, and Git configuration. Require a local Docker socket. Pin `DOCKER_HOST`, clear competing Docker/BuildKit selectors, and set `DOCKER_BUILDKIT=1`. Bound subprocesses, polling, HTTP requests, and cleanup.

2. Check minikube, Docker, Git, and OpenSSL. Start the unique profile with the Docker driver. Use `minikube -p <profile> kubectl --` through a temporary `OMP_KUBE_BIN` wrapper with the isolated kubeconfig. Create the namespace, wait for its default service account and CA ConfigMap, and select its StorageClass.

3. Build and load the image from `dist-bundle/image/`. Add a temporary CA to a derived image and serve the fleet callback through a streaming HTTPS proxy bound to a Pod-reachable host address. Forward the three documented method/path pairs and verify wrong methods and other paths do not reach the fleet.

4. Serve a temporary bare Git repository with `git daemon` bound to the selected host address. Set its HEAD and `acceptance` branch to an existing commit. Require host and probe-Pod `git ls-remote` to return that commit. Track and remove each probe before proceeding.

5. Start the fleet on an assigned loopback port and pass `--port <port>` to the built CLI. Run configured preflight, register the seed project, and create clone A with `add-clone <project> clone-a --profile kubernetes --remote <url> --branch acceptance`. Require automatic start, one Running Pod, one Bound PVC, and a callback pair. Open a production virtual stream, name the session, call `getSessionStats`, and wait for stored transcript bytes. Stop and remove A through the public routes.

6. Create clone B with `start:false`, prove it has zero Kubernetes resources, then call `/ctl/start`. Assert the image, PVC class/size, CPU and memory settings, `restartPolicy: Never`, UID/GID/fsGroup 10001, seccomp, dropped capabilities, read-only root filesystem, disabled service-account token and service links, and the exact `/workspace` PVC and `/tmp` mounts. Repeat start and require the same generation and object UIDs.

7. For B, compare callback and stored transcript bytes and download a real file through bulk. Check the pin and daemon cwd. Write a home sentinel, stop, and wake; require the same PVC, files, and session with a new Pod UID. Restart the fleet and require reconnection to that Pod. After another stop, use a temporary Pod to remove only the main transcript from B's PVC; wake and require byte-identical restoration of that session. Finally, stop with a dirty file, verify removal is refused, wake and preserve the change, then stop and remove successfully.

8. Cleanup stops the fleet, proxy, Git daemon, and exact child processes; removes the generated namespace, profile, and image tags; restores environment values; and removes the temporary root last. Handle SIGINT, SIGTERM, and SIGHUP through this owner. Emit `KUBERNETES_MINIKUBE_ACCEPTANCE_OK` only after every assertion and cleanup succeeds. Failure exits nonzero with `BLOCKED <phase>` and sanitized diagnostics. Use phases `prerequisite`, `cluster`, `image`, `git`, `preflight`, `spawn`, `stream`, `wake`, `delete`, and `cleanup`.

## Verification

Convert `runtime/providers/kube-smoke.test-raw.ts` into `runtime/providers/kubernetes-provider.test.ts` using `bun:test`. Use `tempDir()` for changed filesystem fixtures. Cover:

- Version rejection through both provider executables; valid responses retain `handle` and `observed`.
- Source, branch, callback, environment, generation, UID, and resource identity failures before mutation.
- Repeated ensure/stop/delete, a retained PVC after lost provider state, a foreign claim beside an owned Pod, and a namespace replaced during ensure.
- Concurrent provider calls, stale-lock takeover, PID reuse, and an old owner's release after replacement.
- A failed launch and fleet restart using the recorded attempted generation and credential.
- Initialized checkouts retaining later commits and dirty files across restart.
- Required resume with an existing main file, a missing main restored through the existing bulk protocol, unavailable history, and switch failure.
- Quiesce disposal keeping command admission closed; final writer/store evidence; replay after restart; stale, incomplete, oversized, or conflicting evidence; dirty refusal followed by successful recovery and deletion.
- Installed preflight with a temporary Kubernetes executable and execution of both packaged providers.

Run from the repository root after the stages are integrated:

```sh
bun scripts/test.ts runtime shared fleet/workspace-lifecycle.test.ts fleet/clone-recovery.test.ts fleet/recovery-wake.test.ts fleet/server-routes.test.ts fleet/edge-wire.test.ts fleet/registry.test.ts fleet/cli.test.ts cli/omp-web.test.ts server/daemon-control.test.ts server/omp-session.test.ts
bun run check:types
bun run lint
bun run test
bun scripts/test-onboard.ts
bun run build
bun run test:bwrap:acceptance
bun run test:kubernetes:minikube
```

Stop at the first failed command and retain complete logs. Extend `scripts/test-onboard.ts` to execute both installed providers and check their protocol behavior. The final build restores the package version after onboarding's update fixture and supplies the image context. After acceptance, remove throwaway files, update the evidence, and run the project formatter once followed by `bun run format:check`.

Add `scripts/test-bwrap-lifecycle.ts` and `test:bwrap:acceptance` for the shared protocol changes. Resolve one absolute bwrap executable and exercise the production fleet through session streaming, stop, retained data, same-session wake, fleet restart, and verified delete.

In `docs/clone-plan.md`, record Kubernetes P5.6 as partial until the installed configured preflight succeeds. Close P5.3 only with an exit-zero minikube log containing the success marker. Close P5.7 only with fresh bwrap and minikube lifecycle logs. Record package verification under P9.4 and qualify cluster evidence as local minikube.

