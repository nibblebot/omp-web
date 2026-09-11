import { createHash } from "node:crypto";
import type {
	CallbackErrorCode,
	CloneGitEvidence,
	FlushBoundary,
	QuiesceEvidence,
} from "../shared/callback-protocol";
import { canonicalJson, type ArchiveManifest, type ManifestFile } from "../shared/archive-manifest";
import {
	RESOURCE_IDENTITY_RE,
	computeSourcePinDigest,
	type KubernetesBinding,
} from "../shared/provider-protocol";
import { verifyWorkspaceLogs } from "../runtime/verify-store";
import type { QuiesceCloneSource } from "./clone-quiesce";
import type { FleetLogStore, StoredStreamEvidence } from "./log-store";

/** Largest safe `Date` input (ms); `new Date(x).toISOString()` throws above it. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Split a tailer stream id `logs/<sessionId>/<relpath>` into its store key.
 * Mirrors the fleet log tap exactly (fleet/server.ts #onLogEnvelope: the
 * session id is one slash-free segment, the relpath is everything after the
 * first slash); anything else is null.
 */
function parseLogStreamId(streamId: string): { sessionId: string; relpath: string } | null {
	const prefix = "logs/";
	if (!streamId.startsWith(prefix)) return null;
	const rest = streamId.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const sessionId = rest.slice(0, slash);
	const relpath = rest.slice(slash + 1);
	if (relpath.length === 0) return null;
	return { sessionId, relpath };
}

export interface CloneQuiesceRequest {
	workspaceId: string;
	generation: number;
	podUid: string | null;
	pvcUid: string | null;
	namespaceUid: string;
	sourceRemote: string;
	pinnedRevision: string;
	branch: string;
	/**
	 * Kubernetes resource binding (shared/provider-protocol.ts KubernetesBinding),
	 * i.e. the record's persisted `kubernetes`. REQUIRED at runtime: the receipt
	 * is bound to its resourceIdentity, context, and namespace.
	 */
	binding?: KubernetesBinding;
	/** Registry project id for the receipt manifest provenance; falls back to workspaceId. */
	projectId?: string;
	/**
	 * The exact requestId a previous attempt persisted for this workspace, so
	 * a retry replays the daemon's cached quiesce outcome. Generated when
	 * absent; a malformed value fails typed before any daemon work.
	 */
	requestId?: string;
	/** Roster workspace name for the receipt manifest provenance; falls back to workspaceId. */
	workspaceName?: string;
	/** Main transcript relpaths the workspace volume holds. Omit when the volume is not fleet-readable. */
	volumeMainRelpaths?: readonly string[];
}

/**
 * A validated quiesce receipt: the evidence plus the identity it is bound to.
 * Persist this (or its digest) before provider stop so a later attempt can
 * compare a fresh observation against the same Pod/PVC/namespace facts.
 */
export interface ValidatedQuiesceReceipt {
	requestId: string;
	correlationId: string;
	workspaceId: string;
	generation: number;
	resourceIdentity: string;
	namespaceUid: string;
	podUid: string | null;
	pvcUid: string | null;
	source: QuiesceCloneSource;
	/** `computeSourcePinDigest(source)`: compare against the record's persisted digest. */
	sourcePinDigest: string;
	resolvedCommit: string;
	mainSessionRelpath: string | null;
	boundary: FlushBoundary;
	/** The evidence manifest, proven byte-equal (size/sha256/kind/sessionId/parentPath) to the store. */
	manifestFiles: ManifestFile[];
	/** Daemon provenance, the same shape the evidence document carries. */
	provenance: QuiesceEvidence["provenance"];
	writers: QuiesceEvidence["writers"];
	git: CloneGitEvidence;
	/** sha256 (lowercase hex) of the canonical evidence document; identifies this receipt. */
	digest: string;
	verifiedAt: number;
}

export interface QuiesceReceiptInput {
	/** The parsed evidence document (collectQuiesceEvidence output). */
	evidence: QuiesceEvidence;
	requestId: string;
	correlationId: string;
	request: CloneQuiesceRequest;
	store: FleetLogStore;
}

export type QuiesceReceiptResult =
	| { ok: true; receipt: ValidatedQuiesceReceipt }
	| { ok: false; code: CallbackErrorCode; message: string; path?: string };

/**
 * Writer census check over the invariants `parseQuiesceEvidence` cannot
 * express: the main writer must have flushed, the advisor barrier must be a
 * closed state, and writer ids must be unique (a repeated id is a corrupted
 * census, not a real double). The parser already closed every descendant's
 * shape, and an advisor transcript left in the store by an advisor that is
 * inactive at quiesce is legitimate (historical evidence, verified
 * structurally against the manifest), so no cross-check rejects it here.
 */
function checkWriterEvidence(
	writers: QuiesceEvidence["writers"],
): { ok: true } | { ok: false; message: string } {
	if (writers.main !== "flushed") {
		return { ok: false, message: `writers.main must be "flushed", got ${String(writers.main)}` };
	}
	if (writers.advisors !== "caught_up" && writers.advisors !== "inactive") {
		return {
			ok: false,
			message: `writers.advisors must be "caught_up" or "inactive", got ${String(writers.advisors)}`,
		};
	}
	const ids = new Set<string>();
	for (const entry of writers.descendants) {
		if (ids.has(entry.id)) {
			return { ok: false, message: `writers.descendants repeats writer id ${entry.id}` };
		}
		ids.add(entry.id);
	}
	return { ok: true };
}

/**
 * Validate a parsed receipt against the fleet's own state (clone-plan
 * P7.3/P7.5):
 *
 *  - the exact store file set, with hashes, sizes, kinds, session ids, and
 *    parent paths, proven by `verifyWorkspaceLogs` with the evidence manifest
 *    as the expected one (which also re-runs offset-contiguity and structural
 *    JSONL verification);
 *  - every per-stream generation/offset/eof: the evidence's FlushBoundary and
 *    the store's indices must name exactly the same `logs/<sessionId>/<relpath>`
 *    streams at the same generation, durable offset, and eof (the fleet log
 *    tap's mapping, and the store's own covered set, both checked);
 *  - the writer census (see checkWriterEvidence);
 *  - `mainSessionRelpath` identifies exactly one manifest entry, or is null
 *    only when neither the store nor (when supplied) the workspace volume
 *    holds a main transcript;
 *  - the receipt binds to the workspace resource identity, generation,
 *    namespace UID, PVC UID, the supplied source tuple, and the resolved pin.
 */
export async function validateQuiesceReceipt(
	input: QuiesceReceiptInput,
): Promise<QuiesceReceiptResult> {
	const { evidence, request, store } = input;
	const fail = (code: CallbackErrorCode, message: string, path?: string): QuiesceReceiptResult =>
		path === undefined ? { ok: false, code, message } : { ok: false, code, message, path };

	const binding = request.binding;
	if (binding === undefined) {
		return fail(
			"invalid_request",
			`quiesce receipt for ${request.workspaceId} requires the Kubernetes resource binding`,
		);
	}
	if (!RESOURCE_IDENTITY_RE.test(binding.resourceIdentity)) {
		return fail(
			"invalid_request",
			`resourceIdentity must be 32 lowercase hex characters, got ${binding.resourceIdentity}`,
		);
	}
	if (binding.context.length === 0 || binding.namespace.length === 0) {
		return fail("invalid_request", "the Kubernetes binding is missing its context or namespace");
	}
	if (binding.namespaceUid !== request.namespaceUid) {
		return fail(
			"conflict",
			`binding namespace UID ${binding.namespaceUid} does not match the request's ${request.namespaceUid}`,
		);
	}
	if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
		return fail(
			"invalid_request",
			`generation must be a positive integer, got ${request.generation}`,
		);
	}
	if (evidence.requestId !== input.requestId) {
		return fail(
			"conflict",
			`evidence requestId ${evidence.requestId} does not match the quiesce request ${input.requestId}`,
		);
	}
	if (evidence.provenance.workspaceId !== request.workspaceId) {
		return fail(
			"conflict",
			`evidence targets workspace ${evidence.provenance.workspaceId}, not ${request.workspaceId}`,
		);
	}
	const snapshotCommit = evidence.provenance.resolvedCommit;
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshotCommit)) {
		return fail(
			"invalid_request",
			"evidence resolvedCommit must be a full lowercase Git commit id",
		);
	}
	// A checkout may advance; the initialization pin remains bound in source.
	if (evidence.git.head !== undefined && snapshotCommit !== evidence.git.head) {
		return fail(
			"conflict",
			`evidence resolves commit ${snapshotCommit} but the checkout HEAD is ${evidence.git.head}`,
		);
	}
	const generatedAt = evidence.provenance.generatedAt;
	if (!Number.isFinite(generatedAt) || generatedAt < 0 || generatedAt > MAX_DATE_MS) {
		return fail(
			"invalid_request",
			`evidence provenance.generatedAt is not a usable epoch-ms value: ${String(generatedAt)}`,
		);
	}

	const writers = checkWriterEvidence(evidence.writers);
	if (!writers.ok) return fail("conflict", `writer evidence is invalid: ${writers.message}`);

	const streams = store.storedStreamEvidence(request.workspaceId);
	const streamById = new Map<string, StoredStreamEvidence>(
		streams.map((stream) => [stream.streamId, stream]),
	);
	const boundary: FlushBoundary = evidence.boundary;
	const manifestKeys = new Set(
		evidence.manifestFiles.map((file) => `${file.sessionId}/${file.path}`),
	);

	// Exact store bytes: every declared file present with equal size/sha256/
	// kind/sessionId/parentPath, and no store file outside the declared set.
	const expectedManifest: ArchiveManifest = {
		provenance: {
			projectId: request.projectId ?? request.workspaceId,
			workspaceId: request.workspaceId,
			workspaceName: request.workspaceName ?? request.workspaceId,
			source: { remote: request.sourceRemote },
			resolvedCommit: snapshotCommit,
			generatedAt: new Date(generatedAt).toISOString(),
		},
		files: evidence.manifestFiles,
	};
	let verify;
	try {
		verify = await verifyWorkspaceLogs({
			logsRoot: store.rootDir,
			workspaceId: request.workspaceId,
			expectedManifest,
		});
	} catch (error) {
		return fail(
			"unavailable",
			`cannot verify the fleet store for ${request.workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!verify.ok) {
		return fail(
			verify.code === "conflict" ? "archive_conflict" : verify.code,
			`the fleet store does not match the receipt for ${request.workspaceId}: ${verify.message}`,
			verify.path,
		);
	}
	if (verify.manifest === undefined) {
		// No logs/<workspaceId> subtree exists at all: verifyWorkspaceLogs has
		// nothing to compare against, so the receipt must declare nothing.
		if (
			evidence.manifestFiles.length > 0 ||
			Object.keys(boundary).length > 0 ||
			streams.length > 0
		) {
			return fail(
				"archive_conflict",
				`the fleet store holds no subtree for ${request.workspaceId} but the receipt declares ${evidence.manifestFiles.length} file(s)`,
			);
		}
	}

	// Per-stream generation/offset/eof: the boundary and the store must name
	// exactly the same streams, and every boundary stream must be a manifest
	// entry under the fleet log tap's `logs/<sessionId>/<relpath>` mapping.
	for (const streamId of Object.keys(boundary)) {
		const parsed = parseLogStreamId(streamId);
		if (parsed === null) {
			return fail(
				"conflict",
				`the boundary names a malformed log stream id: ${streamId}`,
				streamId,
			);
		}
		const stored = streamById.get(streamId);
		if (stored === undefined) {
			return fail("conflict", `boundary stream ${streamId} is not in the fleet store`, streamId);
		}
		const entry = boundary[streamId];
		if (stored.generation !== entry.generation) {
			return fail(
				"conflict",
				`store generation for ${streamId} is ${stored.generation}, the boundary says ${entry.generation}`,
				streamId,
			);
		}
		if (stored.ackedBytes !== entry.offset) {
			return fail(
				"conflict",
				`store durable offset for ${streamId} is ${stored.ackedBytes}, the boundary says ${entry.offset}`,
				streamId,
			);
		}
		if (!stored.eof) {
			return fail("conflict", `store stream ${streamId} has no final eof marker`, streamId);
		}
		if (!manifestKeys.has(`${parsed.sessionId}/${parsed.relpath}`)) {
			return fail("conflict", `boundary stream ${streamId} has no manifest entry`, streamId);
		}
	}
	for (const stream of streams) {
		if (!(stream.streamId in boundary)) {
			return fail(
				"conflict",
				`the fleet store holds ${stream.streamId}, which the boundary does not cover`,
				stream.streamId,
			);
		}
		if (!manifestKeys.has(`${stream.sessionId}/${stream.relpath}`)) {
			return fail(
				"conflict",
				`stored stream ${stream.streamId} has no manifest entry`,
				stream.streamId,
			);
		}
	}

	// The main transcript, or a justified null (nothing anywhere).
	const mainRelpath = evidence.mainSessionRelpath;
	if (mainRelpath !== null) {
		const matches = evidence.manifestFiles.filter((file) => file.path === mainRelpath);
		if (matches.length !== 1) {
			return fail(
				"conflict",
				`mainSessionRelpath ${mainRelpath} identifies ${matches.length} manifest entries; expected exactly one`,
			);
		}
		if (matches[0].kind !== "main") {
			return fail(
				"conflict",
				`mainSessionRelpath ${mainRelpath} names a ${matches[0].kind} file, not a main transcript`,
			);
		}
	} else {
		const storedMain = evidence.manifestFiles.find((file) => file.kind === "main");
		if (storedMain !== undefined) {
			return fail(
				"conflict",
				`the receipt declares no main transcript but the store holds ${storedMain.path}`,
			);
		}
		const volumeMains = request.volumeMainRelpaths;
		if (volumeMains !== undefined && volumeMains.length > 0) {
			return fail(
				"conflict",
				`the receipt declares no main transcript but the workspace volume holds ${volumeMains.length} main transcript(s)`,
			);
		}
	}

	// Git evidence is bound to the supplied source; a clean or dirty checkout
	// must still report that remote. "unknown" is accepted here (it blocks
	// deletion through receiptAllowsDelete, but the receipt is still recorded).
	const git = evidence.git;
	if (git.status !== "clean" && git.status !== "dirty" && git.status !== "unknown") {
		return fail("invalid_request", `git.status is invalid: ${String(git.status)}`);
	}
	if (git.status !== "unknown") {
		if (git.remote === undefined || git.remote === null) {
			return fail(
				"conflict",
				`git evidence reports no configured remote; the workspace source is ${request.sourceRemote}`,
			);
		}
		if (git.remote.url !== request.sourceRemote) {
			return fail(
				"conflict",
				`git evidence remote ${git.remote.url} does not match the workspace source ${request.sourceRemote}`,
			);
		}
	}

	const source: QuiesceCloneSource = {
		remote: request.sourceRemote,
		revision: request.pinnedRevision,
		branch: request.branch,
	};
	const receipt: ValidatedQuiesceReceipt = {
		requestId: evidence.requestId,
		correlationId: input.correlationId,
		workspaceId: request.workspaceId,
		generation: request.generation,
		resourceIdentity: binding.resourceIdentity,
		namespaceUid: request.namespaceUid,
		podUid: request.podUid,
		pvcUid: request.pvcUid,
		source,
		sourcePinDigest: computeSourcePinDigest(source.remote, source.revision, source.branch),
		resolvedCommit: evidence.provenance.resolvedCommit,
		mainSessionRelpath: mainRelpath,
		boundary,
		manifestFiles: evidence.manifestFiles,
		provenance: evidence.provenance,
		writers: evidence.writers,
		git,
		digest: createHash("sha256").update(canonicalJson(evidence)).digest("hex"),
		verifiedAt: Date.now(),
	};
	return { ok: true, receipt };
}

/**
 * Delete-vs-stop decision over a validated receipt (clone-plan P7.3/P7.5):
 * deletion requires clean Git evidence (no dirt, no stashes, every local ref
 * preserved on the remote) on top of the verified store. Anything else keeps
 * the receipt for the ordinary stop path, which retains storage.
 *
 * Clean is the only state that can authorize deletion, so a clean receipt
 * carrying no valid stash count or ref-preservation census fails closed here
 * as well: an omitted proof is never an implicit zero/empty.
 */
export function receiptAllowsDelete(
	receipt: ValidatedQuiesceReceipt,
): { ok: true } | { ok: false; code: CallbackErrorCode; reason: string } {
	const git = receipt.git;
	if (git.status === "unknown") {
		return {
			ok: false,
			code: "archive_conflict",
			reason: `git evidence is unknown (${git.unknownReason ?? "no reason given"}); deletion is blocked`,
		};
	}
	if (git.status === "dirty") {
		const dirty = git.dirty;
		if (dirty === undefined) {
			return {
				ok: false,
				code: "conflict",
				reason:
					"the checkout is dirty and the receipt carries no change counts; deletion is blocked",
			};
		}
		return {
			ok: false,
			code: "conflict",
			reason: `the checkout is dirty (${dirty.added} added, ${dirty.modified} modified, ${dirty.deleted} deleted, ${dirty.untracked} untracked); stop preserves the PVC, deletion does not`,
		};
	}
	if (git.head === undefined || git.head !== receipt.resolvedCommit) {
		return {
			ok: false,
			code: "archive_conflict",
			reason: "the clean checkout carries no matching snapshot HEAD; deletion is blocked",
		};
	}
	if (typeof git.stashes !== "number" || !Number.isSafeInteger(git.stashes) || git.stashes < 0) {
		return {
			ok: false,
			code: "archive_conflict",
			reason: "the clean checkout carries no valid stash count; deletion is blocked",
		};
	}
	if (git.stashes > 0) {
		return {
			ok: false,
			code: "conflict",
			reason: `the checkout holds ${git.stashes} stash(es)`,
		};
	}
	const refs = git.refs;
	if (!Array.isArray(refs)) {
		return {
			ok: false,
			code: "archive_conflict",
			reason: "the clean checkout carries no ref-preservation census; deletion is blocked",
		};
	}
	const unpreserved = refs.filter((ref) => !ref.preserved);
	if (unpreserved.length > 0) {
		return {
			ok: false,
			code: "conflict",
			reason: `${unpreserved.length} local ref(s) are not preserved on the remote: ${unpreserved
				.slice(0, 5)
				.map((ref) => ref.name)
				.join(", ")}`,
		};
	}
	return { ok: true };
}
