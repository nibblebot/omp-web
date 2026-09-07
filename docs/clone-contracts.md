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
  desiredState: DesiredState;       // absent = legacy (not persisted)
  authorizedGeneration?: number;    // absent = unmanaged
  providerHandle?: unknown;         // private, opaque
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

## Provider executable contract (`OMP_PROVIDER_PROTO = 1`)

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
> draft above. The binding request/response shapes, exit semantics, error
> vocabulary, identity/supervision rules, and safety rules are below;
> implementations live in `shared/provider-protocol.ts` (types, validation,
> response parsing, pidfile identity helpers) and `runtime/provider-exec.ts`
> (fleet-side invocation).

Invocation: the fleet runs `<executable> <op>` with exactly one JSON request
on stdin (≤ 1 MiB), exactly one JSON response on stdout, and stderr as a
human log the fleet never parses. Exit 0 = the provider produced a response
on stdout; success AND typed failure both exit 0; the `ok` flag classifies
the outcome. A non-zero exit means no trustworthy response; the fleet treats
it as an `internal` failure carrying the exit code and stderr. Spawning uses
explicit argv arrays, never a shell.

Request (`op` is repeated in argv and in the request):

```ts
interface ProviderRequest {
	op: "ensure-running" | "inspect" | "stop" | "delete";
	workspaceId: string;
	generation: number;         // positive; the authorized generation
	workspaceDir: string;       // the checkout directory
	homeDir: string;            // private writable home
	profile: ProviderProfile;   // fleet config profile; secretRefs by NAME only
	handle?: string;            // opaque provider-namespaced handle
	stateDir: string;           // provider-private per-workspace supervision dir
}
```

Response:

```ts
type ProviderResponse =
	| { ok: true; handle: string; observed: "running" | "stopped" | "missing"; pid?: number; startedAt?: number }
	| { ok: false; error: { code: "invalid_request" | "unavailable" | "conflict" | "internal"; message: string; retryable: boolean } };
```

- Error vocabulary is the frozen ledger vocabulary; the fleet adds `timeout`
  for an invocation that produced no response in time. Codes are not
  retryability: `unavailable` is retryable, `internal` is not; `conflict`
  means a writer is active or a predecessor's termination is uncertain,
  the fleet blocks replacement until resolved. `retryable` on a provider
  envelope is the provider's explicit verdict and is honored as-is.
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
- Liveness = the pid is alive AND its `/proc/<pid>/stat` field 22 equals the
  recorded `procStartTime` AND `/proc/<pid>/cmdline` still contains the
  `workspaceToken`. A reused PID never matches.
- `ensure-running` is idempotent: it rediscovers the running resource by the
  durable identity above (stateDir + pidfile + handle), never by blind
  creation, and returns the same handle the fleet already holds.
- `stop` must PROVE the requested generation terminated before reporting
  `observed: "stopped"`: the recorded identity no longer matches a live
  process (or the process is gone) for that generation. PID-only checks are
  forbidden; an uncertain predecessor is `conflict`, and later replacement
  must not start until the generation's termination is proven.
- `delete` removes provider state and runs only after `stop`; it reports
  `observed: "missing"`.

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
