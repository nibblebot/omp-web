# Clone workspace design summary

Summary of [clone-design.md](clone-design.md). The design is approved as amended. Implementation resumed on 2026-09-06 under explicit authorization; [clone-plan.md](clone-plan.md) tracks execution and proof, and no phase counts as complete without its stated evidence.

## Workspaces and ownership

- Add independent clones alongside existing local, unsandboxed worktrees, grouped by stable project identity. Preserve standalone, direct remote, worktree, CLI, and one-session-per-process behavior.
- Fleet owns workspace lifecycle, provider profiles, browser access, routing, and the durable streamed transcript store: every managed daemon continuously streams its full session lineage, and the fleet durably appends the bytes to its own disk near-realtime. Daemons keep execution authority and file-level source of truth while the workspace lives; providers manage compute and persistent resources. One active fleet uses durable state and restart recovery.
- A unified Add workspace dialog and CLI expose creation and lifecycle operations. Remember kind, profile, and start preference per browser/fleet across projects; show preparation, startup, connection, and retryable failures distinctly.
- Clone preparation pins and verifies the selected commit, uses independent Git objects without hardlinks or alternates, and retries safely. It never copies source dirt or resets an initialized workspace on wake. Runtime push credentials are opt-in and separate from preparation credentials.

## Providers and lifecycle

- Ship fleet-side executable providers for bwrap and Kubernetes plus a reproducible runtime image definition. Versioned JSON operations are `ensure-running`, `inspect`, `stop`, and `delete`, with idempotent resource discovery after restart.
- bwrap supervision survives fleet restart without relying on PID-only identity. Kubernetes uses operator-prepared infrastructure and persistent per-workspace PVCs, with no ephemeral-storage fallback.
- Stop preserves checkout and logs. Disconnection means neither dead nor idle: accepted work continues, dialogs wait, and reconnection continues. Fleet alone performs managed-workspace idle stop.
- Fence obsolete runtime generations, and prove the predecessor terminated before replacement. If termination is uncertain, block replacement to prevent concurrent writers.

## HTTP callback transport

- Both connections originate at the daemon: a long-lived streaming POST sends UTF-8 NDJSON envelopes to fleet; a long-lived GET receives SSE acknowledgments, controls, and commands. No inbound daemon service or concurrent POST-response streaming is required.
- Authenticate both halves over HTTPS, except explicit loopback HTTP allowances. Bind them to workspace, generation, and connection identity; require both ready before new commands. Either-half failure replaces the pair with jittered backoff, not the runtime.
- Use versioned envelopes, bounded incremental parsing, independent virtual browser streams, backpressure, and control fairness. HTTP chunks are not message boundaries. Preserve browser POST/SSE and collaboration WebSockets.
- Replay is bounded and acknowledged, with duplicate suppression and daemon-owned resynchronization when unavailable. No durable offline command queue or exactly-once promise: distinguish unsubmitted commands from unknown acceptance, retrying the same identity only within the defined deduplication contract. Transport acknowledgment is not command acceptance.
- Every managed daemon, sandboxed or not, continuously tails its full session lineage subtree, the Q2 subtree (main, subagent, advisor, and metadata JSONL and blob records), and streams the bytes over the same callback pair, with one envelope format, registry, and resume protocol for all.
- Streaming failure semantics: a bounded per-session in-memory ring at the daemon; reconnects resume from the last acknowledged offset; ring overflow flags a gap repaired by re-streaming from the file, which stays the source of truth; atomic full-file rewrites, detected by generation or inode change, resync from zero; crash-partial trailing lines are tolerated like the SDK loader. Ceiling: no fsync upstream, software-crash-safe only, sub-second lag target.
- Downloads use separate bounded, authenticated, daemon-initiated HTTP transfers. Require configured streaming proxies, delivered heartbeats, and periodic renewal; buffering or unsupported ingress fails visibly without automatic fallback.

## Security

- One operator signs in through an access token, establishing a persistent HttpOnly, Secure, same-site cookie with 30-day absolute expiry. Enforce revocation, CSRF, approved origins, trusted proxies, and authentication for history and downloads behind one public origin. Browser credentials never enter URLs or localStorage.
- Separate browser, workspace enrollment, provider, model, and Git credentials. Keep secrets and private endpoints out of public metadata. Sandboxes have private homes/checkouts and do not mount operator or administration credentials.
- bwrap and containers share the host kernel, not VM isolation. Agent-readable secrets remain stealable; general outbound networking means this is not exfiltration-proof.

## Deletion, retention, and wake

- Delete is an explicit operation that refuses active work. Block new admissions, quiesce every writer, require final Git safety evidence and a final flush boundary for session files, verify the fleet store offset-contiguous and structurally complete per session under the existing manifest and JSONL rules, commit verified state and make the store read-only for the workspace, then authorize provider deletion and finalize registry cleanup.
- Git guard: dirty changes, untracked files, stashes, or unpreserved local history block deletion, with no force override and the guard rechecked with writers stopped. Transcripts are not a source backup. Store integrity failures before verification retain workspace storage and keep deletion blocked with retry state; after verification, provider-deletion failures keep a recoverable cleanup record and the intact read-only store.
- Verification is fleet-side over the stored bytes, offset-contiguous through the last acknowledged offset, with the quiesced flush boundary defining expected end offsets. No staging, rename, acceptance receipt, or separate archive copy; the verification machinery transfers and the workspace-side copy step is gone. Verified data is never garbage-collected; the read-only state is the historical transition, and conflicts with a read-only workspace block rather than overwriting history.
- Retention: a workspace deleted without verification keeps its fleet store as orphaned logs indefinitely, manual purge only. A session deleted workspace-side, while the workspace remains, purges the fleet copy; the workspace wins. Verified stores have no automatic expiration; deleting them is a separate explicit operation, and fleet storage backup is the operator's responsibility.
- The data-loss boundary is the acknowledgment offset: unacknowledged records lost with destroyed storage are lost; every acknowledged record is durably stored fleet-side, and gaps repair only over surviving daemon files.
- Wake: any session is wakeable. Workspace alive, fleet materializes cold or missing transcripts into the agent directory before the existing resume path, so resume validation sees the full lineage. Workspace deleted, stored transcripts stay view-only by default, plus an explicit resume onto fresh clone: provision at the pinned commit, materialize transcripts, and resume. Uncommitted working-tree state is unrecoverable, reported explicitly; an unavailable pinned source or commit is a typed failure, never upstream substitution.
- Session logs are not the workspace: transcripts contain the session lineage only and never working-tree files, uncommitted changes, or other workspace data.
- Read access: fleet-stored logs stay gated by the same P2 browser authentication, no new permission model, and readable without the daemon. This change adds no new read surfaces; roster and statistics consumption of the fleet store is deferred to a later phase.

## Delivery boundary

- Intended acceptance envelope: 20 streaming daemons, 100 workspaces, and 3 browsers. Require measured direct-path comparisons, real bwrap/Kubernetes lifecycle evidence, real HTTPS streaming-proxy failure/recovery proof, verify-at-deletion checks, browser verification, and applicable type/test/distribution gates. These are requirements, not measured results.
- Freeze literal schemas, endpoints, acknowledgment/replay limits, timeouts, credentials, storage durability mechanics, infrastructure configuration, and benchmark thresholds before their implementation.
- Excludes active-active or multi-user operation, shared clone objects, microVM delivery, remote bwrap launchers, automatic infrastructure installation, model gateways, automated push/fetch-back, automatic store expiration, and archived-environment restoration.
