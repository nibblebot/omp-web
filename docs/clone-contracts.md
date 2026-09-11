# Clone workspace contract ledger (P0.5)

Frozen implementation contracts produced by P0 investigation of the actual
source and pinned SDK 17.1.8. Phases implement these frozen shapes instead of
inventing values. Approved product behavior lives in clone-design.md; this file
records only literal encoding and mechanics decisions.

## Identities

- `projectId`: existing `pN` monotonic persisted id (realpath-keyed projects).
- `workspaceId`: the existing roster `daemonId` (`dN`, monotonic, never
  reused). No new identity namespace; a workspace IS a roster entry.
- `sessionId`: SDK `SessionHeader.id`; `sessionFile` remains its file identity.
- `exportId`: `ws_<workspaceId>_<sha256(manifest-canonical-json)[:16]>`.
  content-addressed, so identical retries are idempotent and conflicting
  exports collide loudly without a timestamp tiebreak.
  SUPERSEDED (verify-at-deletion): sealed exports no longer exist; the
  manifest schema and its structural verification transfer to deletion
  gating (see Fleet log store).
- `generation`: positive integer persisted as `authorizedGeneration`; starts 1;
  increments only after predecessor termination is proven.
- `connectionId`: `crypto.randomUUID()` per callback pair.
- `resourceHandle`: opaque provider-owned JSON, fleet-private, never serialized
  into roster frames or `/ctl/debug`.

## Workspace registry record (additive, fleet-private on RegistryEntry)

```ts
export type WorkspaceKind = "worktree" | "clone" | "direct";
export type DesiredState = "running" | "stopped";

interface WorkspaceRecord {
  kind: WorkspaceKind;              // absent in legacy state = infer at load
  projectId: string;
  source?: { local?: string; remote?: string };   // clone sources
  pinnedRevision?: string;          // resolved commit, pinned once
  branch?: string;                  // derived from workspace name
  profileId?: string;               // clone workspaces only
  providerKind?: "bwrap" | "kubernetes";  // persisted provider selection
  kubernetes?: KubernetesBinding;   // resource identity + context/namespace/uid
  sourcePinDigest?: string;         // sha256 of [remote, revision, branch]
  lastAttemptedGeneration?: number; // launch attempt that may need adopting
  desiredState: DesiredState;       // absent = legacy (not persisted)
  authorizedGeneration?: number;    // absent = unmanaged
  providerHandle?: unknown;         // private, opaque
  enrollment?: WorkspaceEnrollment; // callback credential digest + generation
  cleanup?: CleanupRecord;          // archive/delete state machine state;
                                    //   SUPERSEDED: deletion verification state (see Fleet log store)
  archiveReceipt?: ArchiveReceipt;  // durable acceptance receipt;
                                    //   SUPERSEDED: verify-at-deletion has no receipts
}
```

Legacy inference at load: `managed || worktreeOf !== undefined` → `worktree`;
`mode === "spawned"` without `worktreeOf` → `direct`; `remote`/`attached` →
`direct`. Inference runs in memory only; entries are stamped on the next
mutation so state files migrate lazily without a rewrite-at-boot.

## Provider profiles (config file, `providerProfiles` key)

```ts
interface ProviderProfile {
  id: string;                 // key in providerProfiles map
  provider: "bwrap" | "kubernetes";
  executable: string;         // provider executable path (absolute or PATH)
  tools: string[];            // runtime tools permitted/required
  resources?: { cpu?: string; memory?: string };
  storage?: { class?: string; size?: string };  // k8s StorageClass/PVC size
  secretRefs?: Record<string, string>;  // name → external secret reference
  image?: string;             // k8s only
  namespace?: string;         // k8s only
  context?: string;           // k8s only: explicit kubeconfig context (never ambient)
  network?: "host" | "isolated";  // bwrap netns share (P5.7): absent =
                                  //   "isolated" (fresh netns; callback URL must
                                  //   be HTTPS-routable from inside). "host" =
                                  //   --share-net after --unshare-all only.
                                  //   pid/user/ipc isolation kept; loopback
                                  //   http callback applies cleanly (dev).
}
```

Validation rejects unknown providers, missing executable, and non-absolute
storage/secret shapes. Public capability view drops `secretRefs` values
(names only), executable internals, and resource handles.

## Preflight rows (`omp-web preflight --profile <id>`)

`runProfilePreflight` runs the host-generic rows for every profile
(executable, callback reachability, durable directories, profile tools,
denied-bind roots, resolvable secret references) and, for Kubernetes
profiles, delegates the cluster requirement rows to
`preflightKubernetesProfile` rather than keeping a parallel set of summary
rows. The Kubernetes rows are: `kubectl-client`, `kube-context`,
`kube-api`, `kube-namespace`, `kube-rbac-<verb>-<resource>` (get, create, and
delete on pods and persistentvolumeclaims), `kube-storageclass`,
`kube-default-storageclass` (required when the profile pins no class),
`kube-secretrefs` (map shape), `kube-secret-<envName>` (one row per
referenced secret name and key), and `kube-image`. Callback reachability is
labelled as reachability from the fleet HOST, not from inside the cluster.
Every failing row carries remediation naming the operator action, and the
`k8s-fields` row is bwrap-only, since a Kubernetes profile's fields are
checked by the rows above.

## Browser and CLI workspace creation (2026-09-06)

- Browser command: `create_clone` with `id`, `projectId`, `name`,
  `profileId`, optional `source: {local?: string; remote?: string}`,
  `revision`, `branch`, and `start`. A supplied source has exactly one
  member; an omitted source uses the registered project's local path.
- CLI HTTP route: `POST /ctl/clones`, the same fields without `id` or
  `type`, returning HTTP 201 with `{entry: DaemonEntry}`. Existing
  worktree creation commands and routes remain unchanged.
- Clone revision input is named `revision`; `baseRef` remains worktree
  vocabulary. The resolved commit is persisted as `pinnedRevision`.
- `GET /ctl/profiles` returns `{profiles: PublicProviderProfile[]}`.
  The browser receives the same secret-free catalog through optional
  `registered_projects.providerProfiles`; older fleets imply an empty
  catalog. Public types live in `shared/protocol.ts`.
- Browser and HTTP lifecycle entrypoints share one fleet-internal
  lifecycle service. Clone start, wake, stop, remove, and verified delete
  cannot bypass its admission and deletion gates. No HTTP self-proxy or
  second lifecycle implementation is introduced.
- Creation preferences store only kind, profile identifier, and
  start-immediately, scoped to the browser's fleet origin across projects.
  Missing saved profiles require deliberate selection. No source,
  revision, name, branch, or credential is remembered.
- These additions preserve `OMP_PROTO = 2`. Implementation and runtime
  proof remain tracked in `clone-plan.md`; this section freezes the
  cross-worker contract, not acceptance evidence.

## Callback transport (`OMP_CALLBACK_PROTO = 1`, separately versioned)

- Up: daemon-initiated long-lived `POST /callback/up`, body
  `application/x-ndjson` UTF-8 callback envelopes, one record ≤ 1 MiB,
  incremental parsing, HTTP chunk boundaries are not message boundaries.
- Down: daemon-initiated long-lived `GET /callback/down`, SSE response,
  `text/event-stream`, same envelope version, `Last-Event-ID` resume.
- Bulk: daemon-initiated `POST /callback/bulk/<correlationId>`, 64 MiB cap;
  completion is never archive acceptance. Also carries wake materialization
  transfers under a fresh correlation id (see Wake).
- Envelope:

```ts
interface CallbackEnvelope {
  version: 1;
  workspaceId: string;
  generation: number;
  connectionId: string;
  streamId: string;       // logical per-browser/control stream
  seq: number;            // per-connection monotonic
  kind: "frame" | "command" | "control" | "ack" | "heartbeat";
  payload: unknown;
  at: number;             // epoch ms
}
```

- Ack: HTTP 200 on the POST is transport receipt only; an `ack` envelope
  confirms command receipt at the daemon boundary; neither is command
  execution acceptance (that remains the daemon's 202/call_result semantics).
- Dedup: command `id` within workspace, existing 60 s / 64-entry window.
- Limits: heartbeat 15 s; silence deadline 30 s; pair renewal 5 min; pair-ready
  wait 60 s; wake wait 60 s; reconnect backoff 1 s → 30 s jittered.
  Buffers: envelope 1 MiB; per-connection 8 MiB; per-virtual-stream 4 MiB;
  replay ring 10k entries.
- Enrollment: 256-bit credential hashed fleet-side, scoped to
  workspace+generation+connection; knowing a callback URL is insufficient;
  obsolete generations rejected (`generation_obsolete`).
- Identity binding: request HEADERS on both halves and bulk;
  `x-omp-workspace-id`, `x-omp-generation`, `x-omp-connection-id`, plus
  `authorization: Bearer <enrollment credential>`. Identity and credentials
  never travel in URL paths or query strings (keeps them out of logs),
  matching the existing fleet bearer precedent.
- Pair readiness: the fleet confirms a pair with an in-band control
  envelope on the down half: streamId `transport`, payload
  `{type:"pair_ready", connectionId, generation}`. The daemon's `start()`
  resolves ready only on receipt (within the 60s pair-ready timeout); the
  HTTP 200s on either half are not readiness. The up half is
  fire-and-forget (the fleet reads the body to completion; no mid-life
  response).
- HTTPS required except explicitly allowed loopback HTTP.

## Callback gateway allowlist

An HTTPS gateway or reverse proxy in front of the fleet exposes exactly the
three daemon-facing callback routes, and nothing else:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/callback/up` | NDJSON envelope upload |
| GET | `/callback/down` | SSE downlink |
| POST | `/callback/bulk/<id>` | bulk transfer under one correlation id |

The gateway matches the RAW request path: no percent-decoding, no
trailing-slash folding, and no normalization before the comparison. `<id>`
is exactly one unescaped `[A-Za-z0-9_-]+` segment (never empty, never
containing a slash, never a second segment). Every other method, every other
path, and any request carrying a query string is rejected at the gateway and
never reaches the fleet. This allowlist covers the daemon callback surface
only; browser, CLI, and admin routes are separate and follow the operator's
own auth policy.

## Session log streaming

Every fleet-managed daemon (sandboxed clones AND unsandboxed worktrees and
default workspaces) continuously tails its full session lineage subtree:
main session JSONL, subagent and advisor recorders, and metadata JSONL and
blobs under the agent dir. Raw bytes stream to the fleet over the uniform
daemon-initiated callback pair (`OMP_CALLBACK_PROTO = 1`); envelopes,
registry, dedup, resume, and limits are unchanged. Streaming is continuous,
not quiesce-gated, with a sub-second lag target while a session is live.

- Stream identity: one virtual stream per lineage file, streamId
  `logs/<sessionId>/<relpath>` with relpath POSIX-relative inside the agent
  dir, matching manifest path normalization. `kind` stays `frame`; no new
  envelope kind.
- Log chunk frame payload:

```ts
interface LogChunk {
  offset: number;      // byte offset of this chunk in the file at `generation`
  generation: number;  // per-file identity counter; NOT the envelope's
                       // workspace `generation` field
  data: string;        // base64 of raw chunk bytes, no line reinterpretation
  eof: boolean;        // false while tailing; true on the final chunk of a
                       // closed session file
}
```

- Control payloads (fleet to daemon on the down half, `kind: "control"`,
  streamId `transport`; distinct from the `ack` kind, which stays command
  receipt):
  - `{type: "log_ack", offsets: Record<streamId, number>}`: durable append
    offset per stream; one control may batch several streams.
  - `{type: "log_gap", from: number, to: number}`: repair request; the
    daemon re-streams bytes `[from, to)` from the file.
- Ack ordering: the fleet appends chunk bytes to its store, fsyncs, and only
  then emits `log_ack` (see Fleet log store). An ack is durability, not
  delivery: each stream's acked offset is the daemon's resume point.
- Resume: on reconnect the daemon re-reads each lineage file from its last
  acked offset, ring first, file as source of truth, and re-streams. The
  fleet enforces offset continuity: the expected next offset is the last
  acked offset; an incoming frame with `offset` greater than expected
  yields one `{type: "log_gap", from: expected, to: frame.offset}`, and
  offsets below expected are post-reconnect re-sends, ignored up to the
  acked offset.
- Ring overflow: the daemon's per-session ring drops unacked buffered
  bytes; the daemon self-repairs by re-reading the file from the last
  acked offset, and the fleet continuity check above covers loss only the
  fleet side can observe. The file stays source of truth in both paths.
- Generations: the SDK appends, but atomic full-file rewrites replace the
  file. The daemon watches file identity (inode change), bumps the chunk
  `generation`, and resyncs from offset 0 under the new generation; the
  fleet resets that stream's offset state on the first chunk of the new
  generation.
- Bounds: the 1 MiB envelope cap applies. A chunk frame whose envelope
  would exceed the cap is split with the existing `planOversizeSplit`
  (control/"chunk", chunkId/index/total, base64 of the payload JSON bytes)
  and reassembled fleet-side with `reassembleChunks` before the LogChunk
  is applied. Per-session in-memory ring at the daemon: 4 MiB, aligned
  with the existing per-virtual-stream 4 MiB buffer budget.
- Partial tails: crash-partial trailing lines (a torn final write) are
  streamed and stored verbatim, exactly like the SDK loader tolerates
  them. No daemon-side line validation and no fleet-side repair;
  structural JSONL verification remains a deletion-gate concern (see
  Fleet log store).

## Fleet log store

The fleet durably appends streamed log bytes to its own state dir in
near-realtime and deliberately becomes a transcript store. Fleet-served
history no longer waits for sealed archive acceptance, and no separate
archive copy is produced.

- Layout under the fleet state dir:
  `logs/<workspaceId>/<sessionId>/<relpath>` holds raw bytes,
  byte-identical to the streamed lineage file; relpath mirrors the agent
  dir (main, subagent, advisor, metadata).
- Path segments (ruled 2026-09-06): `<sessionId>` is exactly one segment,
  the lineage key; SDK session ids are slash-free, and `<relpath>` carries
  the full sessions-root-relative path verbatim, including any project
  prefix and the main's own stem dir for descendants. Manifest paths equal
  store relpaths verbatim; there is no prefix normalization. Splitting the
  stream identity on the first slash after `logs/` is safe because the key
  cannot contain a slash.
- Sidecar index `logs/<workspaceId>/<sessionId>/index.json`:

```ts
interface LogStoreIndex {
  version: 1;
  workspaceId: string;
  sessionId: string;
  streams: Record<string, {   // key: relpath
    generation: number;       // last chunk generation applied
    ackedOffset: number;      // durable append offset; equals the last log_ack
    eof: boolean;             // tail complete
  }>;
}
```

  The index is updated in the same critical section as the append and is
  itself rewritten atomically (temp file, rename, parent fsync).
- fsync-on-ack: the fleet fsyncs the appended file, and its parent
  directory on first creation, BEFORE emitting `log_ack`, so an ack means
  durable and the daemon may discard ring and file-buffer state below the
  acked offset. This fleet-side fsync is required; it does not relax the
  upstream ceiling: the SDK and daemon side stay no-fsync,
  software-crash-safe only.
- Verify-at-deletion gate: workspace deletion is gated on store
  completeness for every session: offset-contiguous streams (ackedOffset
  equals the streamed size, no gaps) AND structurally verified JSONL under
  the existing manifest rules (title slot, header, newline-terminated
  entries) against a manifest computed from the agent dir. The manifest
  schema and structural verification machinery transfer unchanged from the
  export pipeline; the workspace-side copy step dies, and no staging,
  rename, or receipt is produced.
- Read-only flip: once deletion verification passes, the workspace's
  `logs/<workspaceId>/` subtree becomes read-only; no further appends, the
  workspace is gone, and Retention governs its life.

## Quiesce and evidence collection (`quiesce_clone`)

Kubernetes workspaces collect their final evidence over the callback pair
instead of the `quiesce_begin`/`quiesce_result` exchange: the fleet has
already proved predecessor termination and supplies the source facts the
daemon must not re-derive. `fleet/clone-quiesce.ts` owns the fleet-side
request, timeout, and receipt validation; `server/quiesce-evidence.ts` owns
the daemon-side document.

```ts
interface QuiesceCloneControl {   // fleet → daemon, kind "control", streamId "transport"
	type: "quiesce_clone";
	requestId: string;
	correlationId: string;        // bulk correlation the evidence document rides
	sourceRemote: string;
	pinnedRevision: string;
	branch: string;
}

type QuiesceCloneResultControl = {   // daemon → fleet, same stream
	type: "quiesce_clone_result";
	requestId: string;
	correlationId: string;
} & ({ ok: true } | { ok: false; error: { code: CallbackErrorCode; message: string } });

interface QuiesceEvidence {       // one JSON document, uploaded over bulk
	requestId: string;
	/** POSIX relpath of the main transcript under the agent sessions dir; null only when neither the volume nor the store holds one. */
	mainSessionRelpath: string | null;
	boundary: FlushBoundary;
	manifestFiles: ManifestFile[];
	provenance: {
		workspaceId: string;
		workspaceName: string;
		resolvedCommit: string;
		generatedAt: number;
	};
	writers: {
		main: "flushed";
		descendants: QuiesceWriterEntry[];
		advisors: "caught_up" | "inactive";
		note?: string;
	};
	git: CloneGitEvidence;
}
```

- The request rides the existing transport stream and is acknowledged with
  `ControlAckPayload`; unsupported controls return the existing typed error.
  The authenticated envelope's workspace, generation, and connection fields
  are checked before the Kubernetes-specific branch runs.
- Stop admission closes, every reachable writer flushes, the session
  disposes, the tailer finalizes, and the fleet's acknowledgements land
  before evidence is collected. Admission stays closed after disposal until
  the Pod terminates. The outcome is cached by request ID for the lifetime
  of that daemon.
- The document is transferred as one bulk upload under the control's
  `correlationId` (`createBulkCorrelation(workspaceId, { capture: true })` and
  `FleetCallback.requestBulkUploadParts`), bounded at 16 MiB inside the
  64 MiB bulk cap; abandoned captures are released with
  `cancelBulkCorrelation` on timeout and shutdown. Before sending the
  request the fleet persists the receipt binding `{requestId, generation,
  podUid, pvcUid, state}` on the workspace deletion state (`state` is
  `pending`, `verified`, or `invalid`), and it stores the validated receipt
  only after collection and validation both succeed, before invoking
  provider stop.
- Every evidence field is required and `manifestFiles` is `ManifestFile[]`,
  so a receipt can never be validated against a partial proof.
- `collectGitEvidence` uses the stored source URL and the pin supplied by
  the fleet: it reads the checkout's raw origin with includes disabled and
  compares it to that URL before any network access, then probes from a
  temporary bare repository with the credential settings captured at
  startup, imports local heads and tags, fetches the supplied remote, and
  proves every local tip is preserved by its advertised refs (detached HEAD
  and annotated tags included; a newly created branch at the preserved pin
  passes). Any failed Git or stash probe yields unknown evidence and blocks
  deletion.
- The receipt is validated against the exact fleet store file set (hashes,
  sizes, writer results, and per-stream generation/offset/eof boundaries
  from the `logs/<sessionId>/<relpath>` mapping), the main path must
  identify one manifest entry, and the receipt binds to the workspace
  resource ID, generation, namespace UID, and PVC UID. After a fleet
  restart the same Pod UID is rechecked before cached evidence is requested
  through a fresh bulk correlation; a changed Pod or incomplete proof
  invalidates the receipt.
- Dirty Git evidence permits ordinary stop and preserves the claim. Missing
  evidence causes stop to retain storage and report the verification
  failure. Delete requires a stopped workspace, a matching valid receipt,
  clean Git evidence, and a verified store.

## Retention

- Workspace deleted without verification (the completeness gate failed or
  never ran): fleet logs are kept indefinitely as `orphaned`; only a
  manual purge removes them.
- Session deleted workspace-side: the fleet purges its copy of that
  session's log subtree. Workspace state wins.
- Verified data is never garbage-collected; the read-only flip is the only
  automatic lifecycle transition.

## Wake

Any session is wakeable, whether its workspace is alive or deleted.

- Workspace alive: if a transcript is cold or missing in the agent dir,
  the fleet materializes it from the log store, then the existing
  `--resume` path proceeds unchanged. Materialization rides the bulk
  channel: the daemon initiates `POST /callback/bulk/<correlationId>` with
  a materialization request naming the session and stream set, and the
  fleet serves the stored bytes under that correlation, 64 MiB per
  transfer, larger transcripts split across sequential correlation ids.
  The daemon writes the files into the agent dir and re-derives the
  manifest before resume.
- Workspace deleted: sessions are view-only by default, plus an explicit
  "resume onto fresh clone" action: provision a fresh workspace at the
  pinned commit (`pinnedRevision`), materialize the session transcripts as
  above, resume. Uncommitted working-tree file state is unrecoverable and
  is never approximated; there is no upstream substitution.
- Typed failures reuse the existing vocabulary: unresolvable source or
  pinned revision maps to `unavailable`; missing transcripts map to
  `unavailable`; malformed requests map to `invalid_request`; identity and
  authorization follow Browser auth.
- Standing fact: session logs are not the workspace. Transcripts do not
  contain working-tree files; wake restores conversation state only.

## Provider executable contract (`OMP_PROVIDER_PROTO = 1`) (SUPERSEDED)

Draft retained for history: the implicit version and the exit-code taxonomy
below were replaced by the versioned JSON protocol that follows.

Executable invoked as `<executable> <operation>` with one JSON request on
stdin, one JSON response on stdout, stderr human log. Operations:
`ensure-running`, `inspect`, `stop`, `delete`. Request fields:
`workspaceId`, `desiredState`, `generation`, `profile`, `source`,
`resourceHandle`, `storage`, `callback`. Exit codes: 0 success; 20 invalid
request; 21 unavailable; 22 conflict (e.g. writer active, uncertain
predecessor); 23 internal. Responses are typed errors with actionable
remediation text. Operations are idempotent and rediscover resources after
fleet restart by durable identity, never by PID alone.

## Provider operation protocol (frozen contract)

> Supersedes the "Provider executable contract (`OMP_PROVIDER_PROTO = 1`)"
> draft above. `OMP_PROVIDER_PROTO = 2`: the binding request/response
> shapes, the version gate, exit semantics, error vocabulary,
> identity/supervision rules, and safety rules are below; implementations
> live in `shared/provider-protocol.ts` (types, validation, response parsing,
> pidfile identity helpers) and `runtime/provider-exec.ts` (fleet-side
> invocation).

Invocation: the fleet runs `<executable> <op>` with exactly one JSON request
on stdin (≤ 1 MiB), exactly one JSON response on stdout, and stderr as a
human log the fleet never parses. Exit 0 = the provider produced a response
on stdout; success AND typed failure both exit 0; the `ok` flag classifies
the outcome. A non-zero exit means no trustworthy response; the fleet treats
it as an `internal` failure carrying the exit code and stderr. Spawning uses
explicit argv arrays, never a shell.

Version gate: `providerProto` rides BOTH directions. A request whose
`providerProto` is missing or different from `OMP_PROVIDER_PROTO` is
rejected before any operation is dispatched, and a response whose
`providerProto` differs is a malformed response the fleet refuses. The
version is one constant: changing it updates both provider entrypoints, the
invoker, the environment values, and the fixtures together.

Request (`op` is repeated in argv and in the request):

```ts
interface ProviderRequest {
	providerProto: 2;           // must equal OMP_PROVIDER_PROTO
	op: "ensure-running" | "inspect" | "stop" | "delete";
	workspaceId: string;
	generation: number;         // positive; the authorized generation
	workspaceDir: string;       // the checkout directory
	homeDir: string;            // private writable home
	profile: ProviderProfile;   // fleet config profile; secretRefs by NAME only
	handle?: string;            // opaque provider-namespaced handle
	stateDir: string;           // provider-private per-workspace supervision dir
	kubernetes?: KubernetesBinding;  // required on kubernetes profiles, rejected on bwrap
	source?: { local?: string; remote?: string };  // exactly one member when present
	revision?: string;          // pinned full commit, fleet-resolved once
	branch?: string;            // branch created at the pin
	baseline?: { configYaml: string; modelsYaml?: string };  // sanitized sandbox baseline (see below)
}
```

Sandbox baseline delivery (P5.5): a fleet-side prepared volume (bwrap)
receives the sanitized agent-behavior config directly from
`prepareWorkspace`, which runs on the fleet host and can read the operator's
agent dir. A provider-side prepared volume (kubernetes) is prepared in-pod,
where that dir does not exist, so the fleet runs the SAME seed authority
(`runtime/sandbox-baseline.ts`) and ships its two documents in `baseline`.
The provider materializes them as a workspace-scoped ConfigMap mounted
read-only at `/opt/omp-web/baseline` and points the in-pod seed at it with
`OMP_SANDBOX_BASELINE_CONFIG`; the image then seeds
`.home/agent/{config.yml,models.yml}` exactly as the bwrap path does,
including the `modelRoles` filter against the profile's `secretRefs` env
names, which the fleet applies before shipping. The documents are allowlisted,
credential-free, and bounded (256 KiB each); the field is a config channel,
never a credential channel (`secretRefs` remains the only one), and profiles
that prepare fleet-side omit it. The ConfigMap is created before the Pod that
mounts it, replaced (never reused) when a Pod is recreated, refused when a
foreign object squats the deterministic name, and deleted with the Pod and
claim. `delete` reports `observed: "missing"` only once Pod, claim, and
ConfigMap are all absent; a volume from a pre-baseline generation still
deletes cleanly.

Kubernetes binding (request) and observation (successful response):

```ts
interface KubernetesBinding {
	resourceIdentity: string;  // 16 random bytes as 32 lowercase hex characters
	context: string;           // operator-explicit context; never the ambient current-context
	namespace: string;         // operator-prepared namespace
	namespaceUid: string;      // namespace API uid, captured at registration
}

interface KubernetesObserved {
	namespaceUid: string;
	podUid: string | null;     // null = the object is absent
	pvcUid: string | null;
}
```

Every Kubernetes operation requires the binding and validates each object it
touches against it (managed-by, workspace, full profile id, resource id,
namespace uid, object uid; Pods additionally the exact positive decimal
generation and the provider launch token). A bwrap request carrying
`kubernetes` is rejected. A successful Kubernetes response carries the
observed uids, so the fleet can detect a namespace, Pod, or claim replaced
underneath a live workspace. `resourceIdentity` is generated once by the
fleet and never changes: `<workspaceDir>/.kubernetes/<resourceIdentity>/`
holds provider state and `omp-ws-<resourceIdentity>` names the Pod and PVC.

Source-pin digest: lowercase SHA-256 of the UTF-8
`JSON.stringify([source.remote, revision, branch])`. The fleet computes it
and the provider stores it on the Pod and PVC under the existing
`omp-web.omp.dev/` annotation prefix; the fleet compares the request tuple
with provider state and the digest with the Kubernetes metadata before
reusing or adopting resources, and validates the full preparation marker
after the claim is mounted.

Response:

```ts
type ProviderResponse =
	| {
		ok: true;
		providerProto: 2;
		handle: string;
		observed: "running" | "stopped" | "missing";
		kubernetes?: KubernetesObserved;
		pid?: number;
		startedAt?: number;
	}
	| {
		ok: false;
		providerProto: 2;
		error: { code: "invalid_request" | "unavailable" | "conflict" | "internal" | "timeout"; message: string; retryable: boolean };
	};
```

- Error vocabulary is the frozen ledger vocabulary; the fleet adds `timeout`
  for an invocation that produced no response in time. Codes are not
  retryability: `unavailable` is retryable, `internal` is not; `conflict`
  means a writer is active or a predecessor's termination is uncertain,
  the fleet blocks replacement until resolved. `retryable` on a provider
  envelope is the provider's explicit verdict and is honored as-is.
  Provider codes map to lifecycle codes: invalid input and conflicts keep
  their codes, unavailable dependencies become `unavailable`, timeouts
  become `retryable`, and internal failures become `provider_failed`.
- Callback credential digest: the lowercase SHA-256 of the DECODED callback
  enrollment credential bytes. The fleet persists it with its generation on
  the workspace record and on the Pod annotation, and compares it with the
  handoff before reusing or adopting a Pod; the raw credential lives only in
  the protected handoff and the Pod environment, and fleet responses and
  logs carry the digest instead. The provider launch token keeps its own
  record and Pod annotation slot, separate from this digest.
- `handle` is opaque and provider-namespaced, never inspected fleet-side and
  never crossing trust boundaries. The same workspace+generation always
  yields the same handle after restart.
- Envelopes are strict: unknown fields at any level are a malformed
  response. Requests are strict the same way, and the fleet validates before
  spawn (`invalid_request` without spawning).

Identity and supervision (never PID-only):

- `stateDir` is provider-private per-workspace supervision state. The
  provider records its launch identity there as `provider.pid.json`:
  `{ pid, procStartTime, generation, workspaceToken }`, where
  `procStartTime` is `/proc/<pid>/stat` field 22 read at launch and
  `workspaceToken` is an opaque launch token embedded in the workspace
  process argv.
- Kubernetes workspaces record the same identity in
  `<stateDir>/provider.k8s.json`: `{version, workspaceId, generation,
  workspaceToken, namespace, namespaceUid, resourceIdentity, podName,
  pvcName, podUid, pvcUid, sourceRemote, revision, branch, sourcePinDigest,
  callbackDigest, createdAt, startedAt?, stoppedAt?}`. The launch token there
  is the API-side analogue of bwrap's argv token (it also rides the Pod
  annotation), and `callbackDigest` is the callback credential digest
  described above.
- Liveness (bwrap) = the pid is alive AND its `/proc/<pid>/stat` field 22
  equals the recorded `procStartTime` AND `/proc/<pid>/cmdline` still
  contains the `workspaceToken`. A reused PID never matches.
- Kubernetes liveness is API-side: the Pod exists carrying the bound
  resource identity, the namespace uid, the full profile id, and the
  recorded launch token, at the exact positive decimal generation. One
  ownership validator backs all four operations.
- `ensure-running` is idempotent: it rediscovers the running resource by the
  durable identity above (stateDir + pidfile + handle; Kubernetes adds the
  bound object names, identity labels/annotations, and an API uid re-anchor),
  never by blind creation, and returns the same handle the fleet already
  holds. A recheck of the namespace uid before returning turns a namespace
  replaced mid-operation into `conflict` with the observed resources retained.
- `stop` must PROVE the requested generation terminated before reporting
  `observed: "stopped"`: the recorded identity no longer matches a live
  process (bwrap), or the Pod is absent from the API (Kubernetes). PID-only
  checks are forbidden; an uncertain predecessor is `conflict`, and later
  replacement must not start until the generation's termination is proven.
- `delete` removes provider state and runs only after `stop`; it reports
  `observed: "missing"`. Kubernetes deletes the Pod, the PVC, and the
  baseline ConfigMap with Kubernetes UID preconditions, waits for absence,
  and removes provider state only after confirmed deletion; repeated deletion
  succeeds once all three objects are absent, and partial progress is
  persisted so a retry is idempotent.

Safety rules (P5.5, never negotiable):

- No secrets travel in requests. `profile.secretRefs` values are external
  secret reference names only, never materialized secrets, and request
  key allowlists reject unknown fields so nothing secret-shaped can be
  smuggled in. The provider's sandbox never mounts operator credentials,
  the SSH agent, a container socket, or fleet/provider admin secrets.
- Requests and responses are bounded at 1 MiB; provider stdout/stderr are
  capped at 1 MiB each.

## Preparation layout (runtime workspace volume)

- `.omp-workspace-init.json`: verified initialization marker:
  `workspaceId`, `source`, `resolvedCommit`, `branch`, `initializedAt`,
  `prepVersion`.
- `.checkout/`: the working clone (independent object store, no hardlinks or
  alternates to the source).
- `.home/`: private writable home; sessions at `.home/agent/sessions`
  (`PI_CODING_AGENT_DIR=.home/agent`). Preparation seeds
  `.home/agent/config.yml` from the operator's global config through a fixed
  allowlist of agent-behavior keys (credentials, host paths, and URLs never
  cross); `OMP_SANDBOX_BASELINE_CONFIG` overrides the source. A sibling
  `models.yml` beside the operator config seeds `.home/agent/models.yml` the
  same way: custom provider definitions cross, with literal or `!`-command
  credentials rewritten to env-name references under the `<PROVIDER>_API_KEY`
  convention (upper-snake provider id) that the profile's `secretRefs` must
  inject into the sandbox. pi-native transports never resolve in a sandbox
  and are dropped with their provider. OAuth credentials never cross as
  files: a sandbox borrows them at runtime from an operator-run auth broker
  (`omp auth-broker serve`) when the profile injects `OMP_AUTH_BROKER_URL`
  and `OMP_AUTH_BROKER_TOKEN` via `secretRefs` (refresh tokens stay on the
  broker; bwrap sandboxes need `network: "host"` to reach a loopback
  broker). When the profile's secretRefs keys are known at prepare time,
  `modelRoles` and `cycleOrder` entries whose providers cannot resolve are
  dropped so the seeded config never names a dead default model. The seed
  is best-effort and never overwrites an existing file.

## Export manifest (`manifest.v1.json`, sha256 file hashes)

Paths POSIX-relative, normalized, no `..`, no absolute, regular files only.
Each entry: `path`, `size`, `sha256`, `kind` (`main`|`subagent`|`advisor`|
`metadata`), `sessionId`, `parentPath?` (lineage via artifact-dir nesting).
Provenance: `projectId`, `workspaceId`, `workspaceName`, `source`,
`resolvedCommit`, `generatedAt`. Raw JSONL bytes preserved unchanged.

## Archive store commit (SUPERSEDED: verify-at-deletion)

SUPERSEDED mechanics, retained for history: staging, the fsync-and-rename
commit, and `archive-receipt.json` no longer exist. The fleet log store
flips read-only at deletion verification instead of accepting a sealed
archive; see Fleet log store. The manifest schema and structural JSONL
verification transfer unchanged.

`staging/<workspaceId>/<exportId>/` → verify full declared set → fsync files
and dirs → atomic rename to `archives/<workspaceId>/<exportId>/` → fsync
parents → write `archive-receipt.json` durably. Partial staging of the same
export identity is cleaned before retry; final conflicts fail without
overwrite. Platform fsync via `fs.fsyncSync` on files and directories.

## SDK flush evidence ceiling (P0.3 finding, load-bearing)

SDK 17.1.8 never fsyncs; `SessionManager.flush()/close()` resolving without a
latched disk failure is the only supported flush acknowledgment
(software-crash-safe, not power-loss-safe). Quiesce =
`AgentSession.dispose()` cascade (main + subagents + advisor recorders).
Known gap: `AgentLifecycleManager.release` swallows subagent dispose errors
(agent-lifecycle.ts 374-379), and `#doDispose` suppresses advisor-recorder
rejection via allSettled (agent-session.ts 3580-3597), so top-level dispose
resolution alone is NOT all-writer flush evidence. Export acceptance
therefore requires: quiesced writers + structural read verification of every
declared JSONL (title slot, header, newline-terminated entries) +
`SessionPersistenceIndeterminateError` treated as hard blocker. A follow-up
SDK change to surface descendant dispose failures is the correct long-term
resolution; until then the structural read check is mandatory.

Verify-at-deletion reuses this exact predicate (quiesced writers plus
structural read verification of every declared JSONL) as the fleet store
completeness gate; the acceptance target changes from sealed export
acceptance to store completeness (see Fleet log store).

## Browser auth

Opaque 256-bit session id, `omp_session` cookie, HttpOnly, Secure,
SameSite=Lax, 30-day absolute expiry (no sliding). Server stores a hash.
Mutations require Origin allowlist + CSRF header bound to the session.
Explicit loopback-dev exception for the Secure flag only. CLI loopback path
retained. Callback enrollment credentials hashed, scoped, revocable.

## Typed errors

`invalid_request`, `invalid_identity`, `unauthorized`, `forbidden`,
`unavailable`, `conflict`, `generation_obsolete`, `writer_active`,
`archive_pending`, `archive_conflict`, `provider_failed`, `retryable`.

`archive_pending` and `archive_conflict` keep their meanings under
verify-at-deletion as deletion-gate states (verification pending, verification
conflict); the archive-pipeline naming is retained for vocabulary stability.
Wake and materialization add no error names; they reuse `unavailable` and
`invalid_request` from this list.

## Workload acceptance envelope (P0.6, pending measurement)

Proposed: 20 streaming daemons, 100 registered workspaces, 3 browser clients;
60 s sustained + 30 s idle; thresholds: p95 ≤ direct p95×1.5+10 ms;
throughput ≥ 95% direct; memory growth ≤ 32 MiB over final half post-warmup;
no command starvation > 1 s. Thresholds finalized against measured baseline
(P0.6) before P9.6 comparison.
