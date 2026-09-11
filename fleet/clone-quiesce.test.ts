/**
 * Fleet-side quiesce tests (fleet/clone-quiesce.ts handshake + capture and
 * fleet/clone-quiesce-receipt.ts receipt validation): the control round trip,
 * the bulk capture, and the receipt-validation gate, driven against a STUB
 * transport and a REAL temp FleetLogStore. Every case asserts an observable
 * outcome (typed CloneQuiesceError code/stage, accepted vs refused receipt,
 * released correlation) and fails when the corresponding guard is removed.
 *
 * No daemon child, no live pair, no model: the stub answers (or withholds)
 * the `quiesce_clone_result` control and the evidence upload, so the fleet
 * half runs in isolation.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	CALLBACK_TRANSPORT_STREAM_ID,
	QUIESCE_EVIDENCE_MAX_BYTES,
	type CallbackEnvelope,
	type CloneGitEvidence,
	type FlushBoundary,
	type QuiesceEvidence,
} from "../shared/callback-protocol";
import type { ManifestFile } from "../shared/archive-manifest";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { DaemonTransportRegistry, type BulkCorrelation, type BulkResult } from "./daemon-transport";
import { FleetLogStore, type StoredStreamEvidence } from "./log-store";
import {
	CloneQuiesce,
	CloneQuiesceError,
	QUIESCE_REQUEST_ID_MAX_CHARS,
	quiesceClone,
	type CloneQuiesceReceipt,
} from "./clone-quiesce";
import {
	receiptAllowsDelete,
	validateQuiesceReceipt,
	type CloneQuiesceRequest,
} from "./clone-quiesce-receipt";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

const WORKSPACE_ID = "ws-quiesce";
const SESSION_ID = "sess-a";
const MAIN_RELPATH = `${SESSION_ID}.jsonl`;
const ADVISOR_RELPATH = `${SESSION_ID}/__advisor.a.jsonl`;
const STREAM_ID = `logs/${SESSION_ID}/${MAIN_RELPATH}`;
const ADVISOR_STREAM_ID = `logs/${SESSION_ID}/${ADVISOR_RELPATH}`;
const REQUEST_ID = "req-1";
const CORRELATION_ID = "corr-1";
const SOURCE_REMOTE = "https://example.test/acme/repo.git";
const PINNED_REVISION = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "acceptance";
const RESOURCE_IDENTITY = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const NAMESPACE_UID = "namespace-uid-1";
const POD_UID = "pod-uid-1";
const PVC_UID = "pvc-uid-1";

/** Modern SDK layout: title slot line, session header line, one entry. */
function transcriptJsonl(id: string): string {
	const title = {
		type: "title",
		v: 1,
		title: "t",
		updatedAt: "2026-01-01T00:00:00.000Z",
		pad: "",
	};
	const header = { type: "session", id: `minted-${id}`, sessionId: id, ts: 1 };
	const entry = {
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		ts: 2,
	};
	return `${JSON.stringify(title)}\n${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
}

interface SeededStore {
	store: FleetLogStore;
	/** The main transcript stream. */
	stream: StoredStreamEvidence;
	/** The advisor transcript stream, when the fixture seeds one. */
	advisor?: StoredStreamEvidence;
}

/**
 * Real FleetLogStore over a temp root holding one eof-terminated main
 * stream, plus an advisor transcript under the main's stem dir when asked.
 */
function seededStore(opts: { advisor?: boolean } = {}): SeededStore {
	const store = new FleetLogStore({ rootDir: tempDir("clone-quiesce-logs-") });
	const main = store.ingest(WORKSPACE_ID, SESSION_ID, MAIN_RELPATH, {
		offset: 0,
		generation: 1,
		data: Buffer.from(transcriptJsonl(SESSION_ID), "utf8").toString("base64"),
		eof: true,
	});
	expect(main.status).toBe("acked");
	let advisorStream: StoredStreamEvidence | undefined;
	if (opts.advisor === true) {
		const advisor = store.ingest(WORKSPACE_ID, SESSION_ID, ADVISOR_RELPATH, {
			offset: 0,
			generation: 1,
			data: Buffer.from(transcriptJsonl("__advisor-a"), "utf8").toString("base64"),
			eof: true,
		});
		expect(advisor.status).toBe("acked");
		advisorStream = store
			.storedStreamEvidence(WORKSPACE_ID)
			.find((stream) => stream.relpath === ADVISOR_RELPATH);
	}
	const stream = store
		.storedStreamEvidence(WORKSPACE_ID)
		.find((entry) => entry.relpath === MAIN_RELPATH);
	expect(stream).toBeDefined();
	return { store, stream: stream!, advisor: advisorStream };
}

/** An empty store: the workspace's logs subtree was never created. */
function emptyStore(): FleetLogStore {
	return new FleetLogStore({ rootDir: tempDir("clone-quiesce-empty-") });
}

/** sha256 of the bytes the store holds for one stream relpath. */
function storedSha256(store: FleetLogStore, relpath: string): string {
	const file = store.storedFilePath(WORKSPACE_ID, SESSION_ID, relpath);
	expect(file).not.toBeNull();
	return createHash("sha256").update(readFileSync(file!)).digest("hex");
}

function cleanGit(overrides: Partial<CloneGitEvidence> = {}): CloneGitEvidence {
	return {
		status: "clean",
		head: PINNED_REVISION,
		branch: BRANCH,
		stashes: 0,
		remote: { name: "origin", url: SOURCE_REMOTE },
		refs: [{ name: `refs/heads/${BRANCH}`, tip: PINNED_REVISION, preserved: true }],
		...overrides,
	};
}

/** Evidence bound to the seeded store (boundary/manifest/provenance all match). */
function evidenceFor(
	seeded: SeededStore,
	overrides: Partial<QuiesceEvidence> = {},
): QuiesceEvidence {
	const boundary: FlushBoundary = {
		[STREAM_ID]: {
			offset: seeded.stream.ackedBytes,
			generation: seeded.stream.generation,
			eof: true,
		},
	};
	const manifestFiles: ManifestFile[] = [
		{
			path: MAIN_RELPATH,
			size: seeded.stream.ackedBytes,
			sha256: storedSha256(seeded.store, MAIN_RELPATH),
			kind: "main",
			sessionId: SESSION_ID,
		},
	];
	if (seeded.advisor !== undefined) {
		boundary[ADVISOR_STREAM_ID] = {
			offset: seeded.advisor.ackedBytes,
			generation: seeded.advisor.generation,
			eof: true,
		};
		manifestFiles.push({
			path: ADVISOR_RELPATH,
			size: seeded.advisor.ackedBytes,
			sha256: storedSha256(seeded.store, ADVISOR_RELPATH),
			kind: "advisor",
			sessionId: SESSION_ID,
			parentPath: MAIN_RELPATH,
		});
	}
	return {
		requestId: REQUEST_ID,
		mainSessionRelpath: MAIN_RELPATH,
		boundary,
		manifestFiles,
		provenance: {
			workspaceId: WORKSPACE_ID,
			workspaceName: "ws",
			resolvedCommit: PINNED_REVISION,
			generatedAt: Date.now(),
		},
		writers: { main: "flushed", descendants: [], advisors: "caught_up" },
		git: cleanGit(),
		...overrides,
	};
}

/** Evidence for a workspace whose store/volume hold nothing at all. */
function emptyEvidence(overrides: Partial<QuiesceEvidence> = {}): QuiesceEvidence {
	return {
		requestId: REQUEST_ID,
		mainSessionRelpath: null,
		boundary: {},
		manifestFiles: [],
		provenance: {
			workspaceId: WORKSPACE_ID,
			workspaceName: "ws",
			resolvedCommit: PINNED_REVISION,
			generatedAt: Date.now(),
		},
		writers: { main: "flushed", descendants: [], advisors: "inactive" },
		git: cleanGit(),
		...overrides,
	};
}

function requestFor(overrides: Partial<CloneQuiesceRequest> = {}): CloneQuiesceRequest {
	return {
		workspaceId: WORKSPACE_ID,
		generation: 1,
		podUid: POD_UID,
		pvcUid: PVC_UID,
		namespaceUid: NAMESPACE_UID,
		sourceRemote: SOURCE_REMOTE,
		pinnedRevision: PINNED_REVISION,
		branch: BRANCH,
		binding: {
			resourceIdentity: RESOURCE_IDENTITY,
			context: "minikube",
			namespace: "omp",
			namespaceUid: NAMESPACE_UID,
		},
		projectId: "p1",
		workspaceName: "ws",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Stub transport
// ---------------------------------------------------------------------------

interface StubCorrelation {
	correlationId: string;
	workspaceId: string;
	capture: boolean;
	settled: boolean;
	resolve: (result: BulkResult) => void;
}

/** What the stub does when the fleet sends the quiesce control. */
interface StubBehaviour {
	/** "ok" answers the result control; "error" answers ok:false; "none" stays silent. */
	ack: "ok" | "error" | "none";
	/** "received" settles the capture with the evidence doc; "failed"/"none" do not. */
	upload: "received" | "failed" | "none";
	/** Evidence document the daemon "uploads"; absent = nothing to upload. */
	evidence?: Record<string, unknown>;
	/** Stamp the request's requestId onto the delivered document (default true). */
	stampRequestId?: boolean;
	/** Error payload for ack:"error". */
	ackError?: { code: string; message: string };
	/**
	 * When set, the daemon rejects the CONTROL itself with a kind:"ack"
	 * `quiesce_clone` payload whose typed error nests under `error`
	 * (ControlAckPayload), instead of answering the result control.
	 */
	ackReject?: { code: string; message: string };
	/** Reject sendToDaemon instead of delivering anything. */
	sendThrows?: boolean;
	/** Drop the callback pair instead of delivering anything. */
	pairDrops?: boolean;
}

/** Minimal stand-in for DaemonTransportRegistry covering the quiesce surface. */
class StubTransport {
	readonly sent: Array<{ workspaceId: string; payload: Record<string, unknown> }> = [];
	readonly released: string[] = [];
	readonly created: StubCorrelation[] = [];
	#behaviour: StubBehaviour;
	#envelopes = new Map<string, Set<(envelope: CallbackEnvelope) => void>>();
	#pairs = new Map<string, Set<(status: { paired: boolean }) => void>>();
	#correlations = new Map<string, StubCorrelation>();

	constructor(behaviour: StubBehaviour) {
		this.#behaviour = behaviour;
	}

	onDaemonEnvelope(workspaceId: string, cb: (envelope: CallbackEnvelope) => void): () => void {
		let taps = this.#envelopes.get(workspaceId);
		if (taps === undefined) {
			taps = new Set();
			this.#envelopes.set(workspaceId, taps);
		}
		taps.add(cb);
		return () => taps!.delete(cb);
	}

	onPairChange(workspaceId: string, cb: (status: { paired: boolean }) => void): () => void {
		let listeners = this.#pairs.get(workspaceId);
		if (listeners === undefined) {
			listeners = new Set();
			this.#pairs.set(workspaceId, listeners);
		}
		listeners.add(cb);
		return () => listeners!.delete(cb);
	}

	async sendToDaemon(
		workspaceId: string,
		draft: { streamId: string; kind: string; payload: unknown },
	): Promise<CallbackEnvelope> {
		const payload = draft.payload as Record<string, unknown>;
		this.sent.push({ workspaceId, payload });
		const behaviour = this.#behaviour;
		const envelope = {
			version: 1,
			workspaceId,
			generation: 1,
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: draft.kind,
			payload,
		} as unknown as CallbackEnvelope;
		if (behaviour.sendThrows === true) throw new Error("pair is gone");
		if (behaviour.pairDrops === true) {
			for (const listener of [...(this.#pairs.get(workspaceId) ?? [])]) {
				listener({ paired: false });
			}
			return envelope;
		}
		// The daemon answers synchronously: the fleet subscribes before it
		// sends, so settling here exercises the same ordering as a live pair.
		if (behaviour.ack !== "none") {
			if (behaviour.ackReject !== undefined) {
				this.emit(workspaceId, {
					...envelope,
					kind: "ack",
					payload: {
						type: "quiesce_clone",
						requestId: payload.requestId,
						ok: false,
						error: behaviour.ackReject,
					},
				});
			} else {
				this.emit(workspaceId, {
					...envelope,
					kind: "control",
					payload:
						behaviour.ack === "ok"
							? {
									type: "quiesce_clone_result",
									requestId: payload.requestId,
									correlationId: payload.correlationId,
									ok: true,
								}
							: {
									type: "quiesce_clone_result",
									requestId: payload.requestId,
									correlationId: payload.correlationId,
									ok: false,
									error: behaviour.ackError ?? { code: "conflict", message: "no" },
								},
				});
			}
		}
		const correlationId = String(payload.correlationId ?? "");
		if (behaviour.upload === "received") {
			const document =
				behaviour.evidence === undefined
					? undefined
					: {
							...behaviour.evidence,
							...(behaviour.stampRequestId === false ? {} : { requestId: payload.requestId }),
						};
			const data = new TextEncoder().encode(JSON.stringify(document ?? {}));
			this.complete(correlationId, {
				correlationId,
				workspaceId,
				state: "received",
				bytes: data.byteLength,
				data,
			});
		} else if (behaviour.upload === "failed") {
			this.complete(correlationId, {
				correlationId,
				workspaceId,
				state: "failed",
				bytes: 0,
				error: "transfer aborted",
			});
		}
		return envelope;
	}

	createBulkCorrelation(workspaceId: string, opts?: { capture?: boolean }): BulkCorrelation {
		const correlationId = `${CORRELATION_ID}-${this.created.length + 1}`;
		const record: StubCorrelation = {
			correlationId,
			workspaceId,
			capture: opts?.capture === true,
			settled: false,
			resolve: () => {},
		};
		const done = new Promise<BulkResult>((resolve) => {
			record.resolve = resolve;
		});
		this.#correlations.set(correlationId, record);
		this.created.push(record);
		return { correlationId, done };
	}

	cancelBulkCorrelation(correlationId: string): void {
		if (typeof correlationId !== "string" || correlationId.length === 0) return;
		// The real registry is total here (unknown/settled ids are no-ops), so
		// the observable release is the CALL; the stub records every one.
		this.released.push(correlationId);
		const record = this.#correlations.get(correlationId);
		if (record === undefined) return;
		this.#correlations.delete(correlationId);
		if (record.settled) return;
		record.settled = true;
		record.resolve({
			correlationId,
			workspaceId: record.workspaceId,
			state: "failed",
			bytes: 0,
			error: "bulk correlation cancelled",
		});
	}

	/** Emit one envelope to a workspace's taps. */
	emit(workspaceId: string, envelope: unknown): void {
		for (const tap of [...(this.#envelopes.get(workspaceId) ?? [])]) {
			tap(envelope as CallbackEnvelope);
		}
	}

	/** Settle an open capture correlation with a result. */
	complete(correlationId: string, result: BulkResult): void {
		const record = this.#correlations.get(correlationId);
		if (record === undefined || record.settled) return;
		record.settled = true;
		this.#correlations.delete(correlationId);
		record.resolve(result);
	}
}

/** Run one evidence document through CloneQuiesce.collect. */
async function collectWith(
	store: FleetLogStore,
	evidence: QuiesceEvidence,
	request: CloneQuiesceRequest = requestFor(),
	transport?: StubTransport,
): Promise<{ ok: boolean; receipt?: CloneQuiesceReceipt; error?: CloneQuiesceError }> {
	const stub =
		transport ??
		new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidence as unknown as Record<string, unknown>,
		});
	const quiesce = new CloneQuiesce({
		transport: stub as unknown as DaemonTransportRegistry,
		logStore: store,
	});
	try {
		return { ok: true, receipt: await quiesce.collect(request) };
	} catch (error) {
		return { ok: false, error: error as CloneQuiesceError };
	}
}

// ---------------------------------------------------------------------------
// cancelBulkCorrelation (real registry)
// ---------------------------------------------------------------------------

describe("DaemonTransportRegistry.cancelBulkCorrelation", () => {
	test("is idempotent and safe for an unknown id, settling an open capture as failed", async () => {
		const transport = new DaemonTransportRegistry();
		try {
			// Unknown and empty ids are no-ops that never throw.
			expect(() => transport.cancelBulkCorrelation("no-such-correlation")).not.toThrow();
			expect(() => transport.cancelBulkCorrelation("")).not.toThrow();

			const capture = transport.createBulkCorrelation("ws-cancel", { capture: true });
			transport.cancelBulkCorrelation(capture.correlationId);
			// A second cancel of the same (now forgotten) id is still a no-op.
			expect(() => transport.cancelBulkCorrelation(capture.correlationId)).not.toThrow();
			const result = await capture.done;
			expect(result.state).toBe("failed");
			expect(result.correlationId).toBe(capture.correlationId);
		} finally {
			transport.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Request / evidence handshake
// ---------------------------------------------------------------------------

describe("CloneQuiesce handshake", () => {
	test("a request that is never answered fails at the request stage and releases the capture", async () => {
		const stub = new StubTransport({ ack: "none", upload: "none" });
		const outcome = await quiesceClone({
			transport: stub as unknown as DaemonTransportRegistry,
			workspaceId: WORKSPACE_ID,
			generation: 1,
			source: { remote: SOURCE_REMOTE, revision: PINNED_REVISION, branch: BRANCH },
			timeoutMs: 50,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a failed quiesce");
		expect(outcome.stage).toBe("request");
		expect(outcome.code).toBe("retryable");
		// The capture opened before the control is released on the failure path.
		expect(stub.released).toContain(outcome.correlationId);
		expect(stub.created).toHaveLength(1);
		expect(stub.created[0]?.capture).toBe(true);
	});

	test("a dropped callback pair fails CloneQuiesce.collect at the request stage", async () => {
		const stub = new StubTransport({ ack: "none", upload: "none", pairDrops: true });
		const quiesce = new CloneQuiesce({
			transport: stub as unknown as DaemonTransportRegistry,
			logStore: seededStore().store,
		});
		const err = await quiesce.collect(requestFor()).then(
			() => null,
			(error: unknown) => error,
		);
		expect(err).toBeInstanceOf(CloneQuiesceError);
		const typed = err as CloneQuiesceError;
		expect(typed.stage).toBe("request");
		expect(typed.code).toBe("unavailable");
		// The capture is never left buffered.
		expect(stub.released).toEqual(stub.created.map((record) => record.correlationId));
	});

	test("a daemon that rejects the control fails at the request stage with its code", async () => {
		const stub = new StubTransport({
			ack: "error",
			upload: "none",
			ackError: { code: "writer_active", message: "a writer is still active" },
		});
		const quiesce = new CloneQuiesce({
			transport: stub as unknown as DaemonTransportRegistry,
			logStore: seededStore().store,
		});
		const err = await quiesce.collect(requestFor()).then(
			() => null,
			(error: unknown) => error,
		);
		expect(err).toBeInstanceOf(CloneQuiesceError);
		const typed = err as CloneQuiesceError;
		expect(typed.stage).toBe("request");
		expect(typed.code).toBe("writer_active");
		expect(stub.released).toHaveLength(1);
	});

	test("an ack rejection settles from the nested ControlAckPayload error", async () => {
		// The control itself was rejected: the daemon answers kind:"ack" with
		// the typed error nested under `error` (never top-level).
		const stub = new StubTransport({
			ack: "ok",
			upload: "none",
			ackReject: { code: "writer_active", message: "a writer is still active" },
		});
		const quiesce = new CloneQuiesce({
			transport: stub as unknown as DaemonTransportRegistry,
			logStore: seededStore().store,
		});
		const err = await quiesce.collect(requestFor()).then(
			() => null,
			(error: unknown) => error,
		);
		expect(err).toBeInstanceOf(CloneQuiesceError);
		const typed = err as CloneQuiesceError;
		expect(typed.stage).toBe("request");
		expect(typed.code).toBe("writer_active");
		expect(stub.released).toHaveLength(1);
	});

	test("an evidence upload that never lands fails at the evidence stage and releases the capture", async () => {
		const stub = new StubTransport({ ack: "ok", upload: "none" });
		const outcome = await quiesceClone({
			transport: stub as unknown as DaemonTransportRegistry,
			workspaceId: WORKSPACE_ID,
			generation: 1,
			source: { remote: SOURCE_REMOTE, revision: PINNED_REVISION, branch: BRANCH },
			evidenceTimeoutMs: 50,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected a failed quiesce");
		expect(outcome.stage).toBe("evidence");
		expect(outcome.code).toBe("retryable");
		expect(stub.released).toContain(outcome.correlationId);
	});

	test("a failed evidence transfer fails at the evidence stage as unavailable", async () => {
		const stub = new StubTransport({ ack: "ok", upload: "failed" });
		const quiesce = new CloneQuiesce({
			transport: stub as unknown as DaemonTransportRegistry,
			logStore: seededStore().store,
		});
		const err = await quiesce.collect(requestFor()).then(
			() => null,
			(error: unknown) => error,
		);
		expect((err as CloneQuiesceError).code).toBe("unavailable");
		expect(stub.released).toHaveLength(1);
	});

	test("an oversized evidence document is rejected before it is validated", async () => {
		const seeded = seededStore();
		const oversized = evidenceFor(seeded, {
			writers: {
				main: "flushed",
				descendants: [],
				advisors: "caught_up",
				note: "x".repeat(QUIESCE_EVIDENCE_MAX_BYTES + 1),
			},
		});
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: oversized as unknown as Record<string, unknown>,
		});
		// The fixture must genuinely exceed the document bound, or the case
		// would pass for an unrelated reason.
		expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(
			QUIESCE_EVIDENCE_MAX_BYTES,
		);
		const outcome = await collectWith(seeded.store, oversized, requestFor(), stub);
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBeInstanceOf(CloneQuiesceError);
		expect(outcome.error?.code).toBe("invalid_request");
		expect(outcome.error?.stage).toBe("evidence");
		expect(stub.released).toHaveLength(1);
	});

	test("a structurally invalid evidence document is rejected", async () => {
		const seeded = seededStore();
		const invalid = evidenceFor(seeded, {
			manifestFiles: [
				{
					path: MAIN_RELPATH,
					size: seeded.stream.ackedBytes,
					sha256: storedSha256(seeded.store, MAIN_RELPATH),
					kind: "bogus",
					sessionId: SESSION_ID,
				} as unknown as ManifestFile,
			],
		});
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: invalid as unknown as Record<string, unknown>,
		});
		const outcome = await collectWith(seeded.store, invalid, requestFor(), stub);
		expect(outcome.error?.code).toBe("invalid_request");
		expect(outcome.error?.stage).toBe("evidence");
		expect(stub.released).toHaveLength(1);
	});

	test("evidence whose requestId is not the request's is refused as a conflict", async () => {
		const seeded = seededStore();
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidenceFor(seeded) as unknown as Record<string, unknown>,
			stampRequestId: false,
		});
		const outcome = await collectWith(seeded.store, evidenceFor(seeded), requestFor(), stub);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.code).toBe("conflict");
		expect(outcome.error?.stage).toBe("evidence");
		expect(stub.released).toHaveLength(1);
	});

	test("an unusable resource binding is refused before the daemon is asked", async () => {
		const seeded = seededStore();
		const binding = requestFor().binding!;
		const cases: CloneQuiesceRequest[] = [
			requestFor({
				binding: { ...binding, resourceIdentity: RESOURCE_IDENTITY.toUpperCase() },
			}),
			requestFor({ binding: { ...binding, resourceIdentity: "short" } }),
			requestFor({ binding: { ...binding, namespaceUid: "some-other-namespace-uid" } }),
		];
		for (const request of cases) {
			const stub = new StubTransport({ ack: "ok", upload: "none" });
			const outcome = await collectWith(seeded.store, evidenceFor(seeded), request, stub);
			expect(outcome.ok).toBe(false);
			expect(outcome.error).toBeInstanceOf(CloneQuiesceError);
			expect(outcome.error?.stage).toBe("validation");
			expect(outcome.error?.code).toBe("invalid_request");
			// Nothing was sent and no correlation was opened: the fast-fail
			// never spends a quiesce.
			expect(stub.sent).toHaveLength(0);
			expect(stub.created).toHaveLength(0);
		}
	});

	test("a request without the kubernetes binding is refused before the daemon is asked", async () => {
		const seeded = seededStore();
		const stub = new StubTransport({ ack: "ok", upload: "none" });
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded),
			requestFor({ binding: undefined }),
			stub,
		);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("invalid_request");
		expect(stub.sent).toHaveLength(0);
	});

	test("a missing log store cannot verify a receipt and reports unavailable", async () => {
		const seeded = seededStore();
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidenceFor(seeded) as unknown as Record<string, unknown>,
		});
		const quiesce = new CloneQuiesce({
			transport: stub as unknown as DaemonTransportRegistry,
			logStore: null,
		});
		const err = await quiesce.collect(requestFor()).then(
			() => null,
			(error: unknown) => error,
		);
		expect(err).toBeInstanceOf(CloneQuiesceError);
		expect((err as CloneQuiesceError).code).toBe("unavailable");
		expect((err as CloneQuiesceError).stage).toBe("validation");
		expect(stub.released).toContain(stub.created[0]!.correlationId);
	});
});

// ---------------------------------------------------------------------------
// Persisted request id (the retry replay key)
// ---------------------------------------------------------------------------

describe("CloneQuiesce.collect requestId", () => {
	test("a supplied requestId rides the control verbatim and is echoed in the receipt", async () => {
		const seeded = seededStore();
		const evidence = evidenceFor(seeded);
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidence as unknown as Record<string, unknown>,
		});
		const outcome = await collectWith(
			seeded.store,
			evidence,
			requestFor({ requestId: "req-persisted-7" }),
			stub,
		);
		expect(outcome.ok).toBe(true);
		expect(stub.sent).toHaveLength(1);
		expect(stub.sent[0]?.payload.requestId).toBe("req-persisted-7");
		expect(outcome.receipt?.requestId).toBe("req-persisted-7");
		// The validated receipt carries the same key: a fleet crash after the
		// daemon cached the outcome can replay it.
		expect(outcome.receipt?.receipt.requestId).toBe("req-persisted-7");
	});

	test("without a supplied requestId a fresh one is minted for the control", async () => {
		const seeded = seededStore();
		const evidence = evidenceFor(seeded);
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidence as unknown as Record<string, unknown>,
		});
		const outcome = await collectWith(seeded.store, evidence, requestFor(), stub);
		expect(outcome.ok).toBe(true);
		const wireId = stub.sent[0]?.payload.requestId as string | undefined;
		expect(wireId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(outcome.receipt?.requestId).toBe(wireId);
	});

	test("a requestId at the bound is accepted", async () => {
		const seeded = seededStore();
		const evidence = evidenceFor(seeded);
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidence as unknown as Record<string, unknown>,
		});
		const atBound = "r".repeat(QUIESCE_REQUEST_ID_MAX_CHARS);
		const outcome = await collectWith(
			seeded.store,
			evidence,
			requestFor({ requestId: atBound }),
			stub,
		);
		expect(outcome.ok).toBe(true);
		expect(stub.sent[0]?.payload.requestId).toBe(atBound);
	});

	test("a malformed supplied requestId is refused before any correlation is opened", async () => {
		const seeded = seededStore();
		const evidence = evidenceFor(seeded);
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidence as unknown as Record<string, unknown>,
		});
		const cases = ["", "r".repeat(QUIESCE_REQUEST_ID_MAX_CHARS + 1)];
		for (const requestId of cases) {
			const outcome = await collectWith(seeded.store, evidence, requestFor({ requestId }), stub);
			expect(outcome.ok).toBe(false);
			expect(outcome.error).toBeInstanceOf(CloneQuiesceError);
			expect(outcome.error?.code).toBe("invalid_request");
			expect(outcome.error?.stage).toBe("request");
		}
		// Neither the control nor a capture correlation was ever opened.
		expect(stub.sent).toHaveLength(0);
		expect(stub.created).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Receipt validation against the store
// ---------------------------------------------------------------------------

describe("CloneQuiesce receipt validation", () => {
	test("a clean receipt matching the store is accepted and authorizes deletion", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(seeded.store, evidenceFor(seeded));
		expect(outcome.ok).toBe(true);
		const receipt = outcome.receipt!;
		expect(receipt.receipt.mainSessionRelpath).toBe(MAIN_RELPATH);
		expect(receiptAllowsDelete(receipt.receipt)).toEqual({ ok: true });
	});

	test("a boundary naming a stream the store does not hold is refused", async () => {
		const seeded = seededStore();
		const boundary: FlushBoundary = {
			...evidenceFor(seeded).boundary,
			[`logs/${SESSION_ID}/ghost.jsonl`]: { offset: 1, generation: 1, eof: true },
		};
		const outcome = await collectWith(seeded.store, evidenceFor(seeded, { boundary }));
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a boundary offset that disagrees with the durable store offset is refused", async () => {
		const seeded = seededStore();
		const boundary: FlushBoundary = {
			[STREAM_ID]: {
				offset: seeded.stream.ackedBytes + 1,
				generation: seeded.stream.generation,
				eof: true,
			},
		};
		const outcome = await collectWith(seeded.store, evidenceFor(seeded, { boundary }));
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a boundary generation that disagrees with the store is refused", async () => {
		const seeded = seededStore();
		const boundary: FlushBoundary = {
			[STREAM_ID]: {
				offset: seeded.stream.ackedBytes,
				generation: seeded.stream.generation + 1,
				eof: true,
			},
		};
		const outcome = await collectWith(seeded.store, evidenceFor(seeded, { boundary }));
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a store stream the boundary does not cover is refused", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(seeded.store, evidenceFor(seeded, { boundary: {} }));
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a manifest file whose sha256 disagrees with the stored bytes is refused", async () => {
		const seeded = seededStore();
		const manifestFiles: ManifestFile[] = [
			{
				path: MAIN_RELPATH,
				size: seeded.stream.ackedBytes,
				sha256: "0".repeat(64),
				kind: "main",
				sessionId: SESSION_ID,
			},
		];
		const outcome = await collectWith(seeded.store, evidenceFor(seeded, { manifestFiles }));
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("archive_conflict");
	});

	test("a manifest file whose size disagrees with the stored bytes is refused", async () => {
		const seeded = seededStore();
		const manifestFiles: ManifestFile[] = [
			{
				path: MAIN_RELPATH,
				size: seeded.stream.ackedBytes + 7,
				sha256: storedSha256(seeded.store, MAIN_RELPATH),
				kind: "main",
				sessionId: SESSION_ID,
			},
		];
		const outcome = await collectWith(seeded.store, evidenceFor(seeded, { manifestFiles }));
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("archive_conflict");
	});

	test("a manifest that omits a stored file is refused", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(seeded.store, evidenceFor(seeded, { manifestFiles: [] }));
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("archive_conflict");
	});

	test("a manifest that declares an extra file is refused", async () => {
		const seeded = seededStore();
		const extra: ManifestFile = {
			path: `${SESSION_ID}/extra.jsonl`,
			size: 3,
			sha256: "1".repeat(64),
			kind: "subagent",
			sessionId: SESSION_ID,
			parentPath: MAIN_RELPATH,
		};
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, { manifestFiles: [...evidenceFor(seeded).manifestFiles, extra] }),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("archive_conflict");
	});

	test("mainSessionRelpath naming zero manifest entries is refused", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, { mainSessionRelpath: "not-in-the-manifest.jsonl" }),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a manifest declaring the same path twice is refused", async () => {
		// The storable "two entries for the main relpath" shape cannot reach the
		// mainSessionRelpath census: the manifest schema itself rejects a
		// duplicate path, so the refusal happens one step earlier.
		const seeded = seededStore();
		const duplicated = evidenceFor(seeded).manifestFiles[0]!;
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, { manifestFiles: [duplicated, duplicated] }),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("invalid_request");
	});

	test("a null mainSessionRelpath is refused when the store holds a main transcript", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, { mainSessionRelpath: null }),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a null mainSessionRelpath is refused when the workspace volume holds a main transcript", async () => {
		const outcome = await collectWith(
			emptyStore(),
			emptyEvidence(),
			requestFor({ volumeMainRelpaths: [MAIN_RELPATH] }),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a null mainSessionRelpath over an empty store and volume is accepted", async () => {
		const outcome = await collectWith(
			emptyStore(),
			emptyEvidence(),
			requestFor({ volumeMainRelpaths: [] }),
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.receipt!.receipt.mainSessionRelpath).toBeNull();
		expect(receiptAllowsDelete(outcome.receipt!.receipt)).toEqual({ ok: true });
	});

	test("a preserved checkout beyond its initialization pin permits deletion", async () => {
		const seeded = seededStore();
		const evidence = evidenceFor(seeded);
		const head = "f".repeat(40);
		evidence.provenance.resolvedCommit = head;
		evidence.git = cleanGit({
			head,
			refs: [{ name: `refs/heads/${BRANCH}`, tip: head, preserved: true }],
		});
		const outcome = await collectWith(seeded.store, evidence);
		expect(outcome.ok).toBe(true);
		expect(receiptAllowsDelete(outcome.receipt!.receipt)).toEqual({ ok: true });
		expect(outcome.receipt!.receipt.source.revision).toBe(PINNED_REVISION);
	});

	test("snapshot provenance from another checkout HEAD is refused", async () => {
		const seeded = seededStore();
		const evidence = evidenceFor(seeded, {
			provenance: {
				workspaceId: WORKSPACE_ID,
				workspaceName: "ws",
				resolvedCommit: "f".repeat(40),
				generatedAt: Date.now(),
			},
		});
		const outcome = await collectWith(seeded.store, evidence);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a receipt for a different workspace is refused", async () => {
		const seeded = seededStore();
		const evidence = evidenceFor(seeded, {
			provenance: {
				workspaceId: "some-other-workspace",
				workspaceName: "ws",
				resolvedCommit: PINNED_REVISION,
				generatedAt: Date.now(),
			},
		});
		const outcome = await collectWith(seeded.store, evidence);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("validation");
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a non-positive generation is refused", async () => {
		const seeded = seededStore();
		const result = await validateQuiesceReceipt({
			evidence: evidenceFor(seeded),
			requestId: REQUEST_ID,
			correlationId: CORRELATION_ID,
			request: requestFor({ generation: 0 }),
			store: seeded.store,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the receipt to be refused");
		expect(result.code).toBe("invalid_request");
	});

	test("a receipt bound to a non-kubernetes binding is refused", async () => {
		const seeded = seededStore();
		const binding = requestFor().binding!;
		const result = await validateQuiesceReceipt({
			evidence: evidenceFor(seeded),
			requestId: REQUEST_ID,
			correlationId: CORRELATION_ID,
			request: requestFor({
				binding: { ...binding, resourceIdentity: "not-a-resource-identity" },
			}),
			store: seeded.store,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the receipt to be refused");
		expect(result.code).toBe("invalid_request");
	});

	test("a receipt whose binding namespace disagrees with the observed namespace is refused", async () => {
		const seeded = seededStore();
		const binding = requestFor().binding!;
		const result = await validateQuiesceReceipt({
			evidence: evidenceFor(seeded),
			requestId: REQUEST_ID,
			correlationId: CORRELATION_ID,
			request: requestFor({
				namespaceUid: "observed-namespace-uid",
				binding: { ...binding, namespaceUid: "recorded-namespace-uid" },
			}),
			store: seeded.store,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the receipt to be refused");
		expect(result.code).toBe("conflict");
	});

	test("an inactive advisor barrier with a retained advisor transcript is accepted", async () => {
		// `writers.advisors: "inactive"` describes the live barrier at quiesce,
		// not whether an advisor ever wrote. A transcript left by an earlier
		// advisor is verified structurally against the manifest, so it must
		// keep the receipt valid instead of making deletion impossible.
		const seeded = seededStore({ advisor: true });
		const evidence = evidenceFor(seeded, {
			writers: { main: "flushed", descendants: [], advisors: "inactive" },
		});
		const outcome = await collectWith(seeded.store, evidence);
		expect(outcome.ok).toBe(true);
		expect(receiptAllowsDelete(outcome.receipt!.receipt)).toEqual({ ok: true });
	});

	test("an advisor transcript with a caught-up census is accepted", async () => {
		const seeded = seededStore({ advisor: true });
		const outcome = await collectWith(seeded.store, evidenceFor(seeded));
		expect(outcome.ok).toBe(true);
		expect(receiptAllowsDelete(outcome.receipt!.receipt)).toEqual({ ok: true });
	});

	test("a dirty Git receipt is accepted as a receipt but refuses deletion", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, {
				git: cleanGit({
					status: "dirty",
					dirty: { added: 1, modified: 2, deleted: 0, untracked: 3 },
				}),
			}),
		);
		expect(outcome.ok).toBe(true);
		const receipt = outcome.receipt!.receipt;
		expect(receipt.git.status).toBe("dirty");
		const verdict = receiptAllowsDelete(receipt);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("expected deletion to be refused");
		expect(verdict.code).toBe("conflict");
	});

	test("an unknown Git receipt is accepted as a receipt but refuses deletion", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, { git: { status: "unknown", unknownReason: "git binary missing" } }),
		);
		expect(outcome.ok).toBe(true);
		const verdict = receiptAllowsDelete(outcome.receipt!.receipt);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("expected deletion to be refused");
		expect(verdict.code).toBe("archive_conflict");
	});

	test("a clean receipt with an unpreserved local ref refuses deletion", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, {
				git: cleanGit({
					refs: [{ name: "refs/heads/scratch", tip: PINNED_REVISION, preserved: false }],
				}),
			}),
		);
		expect(outcome.ok).toBe(true);
		const verdict = receiptAllowsDelete(outcome.receipt!.receipt);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("expected deletion to be refused");
		expect(verdict.code).toBe("conflict");
	});

	test("a clean receipt with a stash refuses deletion", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, { git: cleanGit({ stashes: 1 }) }),
		);
		expect(outcome.ok).toBe(true);
		const verdict = receiptAllowsDelete(outcome.receipt!.receipt);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("expected deletion to be refused");
		expect(verdict.code).toBe("conflict");
	});

	test("a git receipt for a different remote than the workspace source is refused", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, {
				git: cleanGit({ remote: { name: "origin", url: "https://example.test/other/repo.git" } }),
			}),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.code).toBe("conflict");
	});

	test("a clean Git object without the stash/ref proof is refused as malformed", async () => {
		const seeded = seededStore();
		const outcome = await collectWith(
			seeded.store,
			evidenceFor(seeded, {
				git: { status: "clean", remote: { name: "origin", url: SOURCE_REMOTE } },
			}),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error?.stage).toBe("evidence");
		expect(outcome.error?.code).toBe("invalid_request");
	});

	test("a malformed Git field is a typed parse failure, never a delete-decision crash", async () => {
		const seeded = seededStore();
		const malformed = [
			cleanGit({ refs: "bad" as unknown as CloneGitEvidence["refs"] }),
			cleanGit({ stashes: "1" as unknown as number }),
			cleanGit({ remote: { name: "origin" } as unknown as CloneGitEvidence["remote"] }),
			cleanGit({
				refs: [
					{ name: "refs/heads/x", tip: PINNED_REVISION } as unknown as {
						name: string;
						tip: string;
						preserved: boolean;
					},
				],
			}),
			cleanGit({ status: "dirty" }),
		];
		for (const git of malformed) {
			const outcome = await collectWith(seeded.store, evidenceFor(seeded, { git }));
			expect(outcome.ok).toBe(false);
			expect(outcome.error?.stage).toBe("evidence");
			expect(outcome.error?.code).toBe("invalid_request");
		}
	});

	test("a clean receipt missing checkout or stash/ref proof never authorizes deletion", async () => {
		const seeded = seededStore();
		for (const git of [
			cleanGit({ head: undefined }),
			cleanGit({ stashes: undefined }),
			cleanGit({ refs: undefined }),
		]) {
			const result = await validateQuiesceReceipt({
				evidence: evidenceFor(seeded, { git }),
				requestId: REQUEST_ID,
				correlationId: CORRELATION_ID,
				request: requestFor(),
				store: seeded.store,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected the receipt to be recorded");
			const verdict = receiptAllowsDelete(result.receipt);
			expect(verdict.ok).toBe(false);
			if (verdict.ok) throw new Error("expected deletion to be refused");
			expect(verdict.code).toBe("archive_conflict");
		}
	});

	test("every refused receipt still releases its bulk correlation", async () => {
		const seeded = seededStore();
		const stub = new StubTransport({
			ack: "ok",
			upload: "received",
			evidence: evidenceFor(seeded, {
				mainSessionRelpath: "not-in-the-manifest.jsonl",
			}) as unknown as Record<string, unknown>,
		});
		const outcome = await collectWith(seeded.store, evidenceFor(seeded), requestFor(), stub);
		expect(outcome.ok).toBe(false);
		expect(stub.released).toEqual(stub.created.map((record) => record.correlationId));
	});
});
