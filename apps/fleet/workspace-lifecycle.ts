/**
 * Clone-workspace lifecycle service (clone-plan P6/P7; proposed module
 * `fleet/workspace-lifecycle.ts`). THE single create/ensure/stop/delete
 * owner for provider-managed clone workspaces, shared by the control-plane
 * HTTP handlers (POST /ctl/clones, /ctl/start|wake, /ctl/stop, DELETE
 * /ctl/worktrees/:id) and the browser edge's command dispatch (Transport's
 * `EdgeLifecycleHooks`, this class conforms to it structurally).
 *
 * Frozen contracts: docs/clone-contracts.md ("Browser and CLI workspace
 * creation", "Provider operation protocol", "Fleet log store", "Retention",
 * "Wake", "Typed errors") and docs/clone-plan.md P6/P7.
 *
 * Ownership rules this service enforces:
 * - One lifecycle implementation. HTTP handlers and edge commands call
 *   here; nothing self-fetches /ctl/* and no second clone lifecycle exists.
 * - Desired state, generation, provider handle, source/pin, and lifecycle
 *   progress persist BEFORE any retry-prone provider step, so a crash or a
 *   failed op resumes from durable state, never from re-resolution.
 * - Predecessor termination is proven before a generation is bumped; an
 *   uncertain predecessor (`conflict` from the provider, or a live pair at
 *   the current generation with no recoverable binding) blocks replacement.
 * - Every destructive transition runs the verify-at-deletion gate
 *   (admission → quiesce with proven stop → Git guard → store verification
 *   against the workspace volume's own session tree → read-only flip →
 *   provider deletion → volume deletion → roster removal). `removeClone`
 *   routes through the SAME gate; no kind-blind roster eviction can bypass
 *   it.
 * - Stop preserves checkout and session logs; only the verified gate
 *   deletes. Idle handling stays fleet-owned (P6.4): this service never
 *   stops compute on its own; explicit stop/wake are the only transitions.
 *
 * The fleet server injects everything external (registry, config, callback
 * transport, log store, resource deleter, event ring, log-tap attach, and
 * the callback base URL); this module has no HTTP surface of its own.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { ENROLLMENT_KEY_BYTES } from "#lib/wire/callback-protocol";
import type { LifecycleStage } from "#lib/wire/protocol";
import type { Registry, RegistryEntry, WorkspaceRecord, DeletionGateError } from "./registry";
import type { FleetConfig } from "./config";
import type { DaemonTransportRegistry } from "./daemon-transport";
import type { FleetLogStore } from "./log-store";
import type { FleetEventLog } from "./events";
import type { WorkspaceResourceDeleter } from "./server";
import type { ProviderOkResponse, ProviderResponse } from "#lib/runtime/provider-protocol";
import { runProviderOp } from "#lib/runtime/provider-exec";
import {
	deriveWorkspaceBranch,
	PrepareWorkspaceError,
	prepareWorkspace,
	resolveWorkspacePin,
} from "#lib/runtime/prepare-workspace";
import { verifyWorkspaceLogs } from "./verify-store";
import { MAX_EXPORT_BYTES, MAX_EXPORT_FILES } from "#lib/session-files/export-sessions";
import {
	WakeMaterializeError,
	materializeMissingSessionFiles,
	pickNewestSessionId,
	resolveMainSessionFile,
} from "./wake-materialize";
import type { ArchiveManifest } from "#lib/session-files/archive-manifest";
import { isNormalizedPosixRelativePath } from "#lib/session-files/archive-manifest";

// ---------------------------------------------------------------------------
// Typed errors (frozen ledger vocabulary; message text is safe to surface)
// ---------------------------------------------------------------------------

/** Error codes this service raises; the frozen ledger vocabulary. */
export type CloneLifecycleErrorCode =
	| "invalid_request"
	| "invalid_identity"
	| "unauthorized"
	| "forbidden"
	| "unavailable"
	| "conflict"
	| "generation_obsolete"
	| "writer_active"
	| "archive_pending"
	| "archive_conflict"
	| "provider_failed"
	| "retryable";

/** Typed lifecycle failure; `message` is caller-safe (roster/HTTP/edge). */
export class CloneLifecycleError extends Error {
	constructor(
		readonly code: CloneLifecycleErrorCode,
		message: string,
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// Inputs / deps
// ---------------------------------------------------------------------------

/** create_clone input (frozen contract; `id`/`type` are edge-only). */
export interface CloneCreateInput {
	projectId: string;
	name: string;
	profileId: string;
	/** Exactly one member when given; absent = the registered project's local path. */
	source?: { local?: string; remote?: string };
	/** Clone pin vocabulary (never baseRef). */
	revision?: string;
	branch?: string;
	start?: boolean;
}

/** External wiring the fleet server injects (nothing HTTP here). */
export interface WorkspaceLifecycleDeps {
	registry: Registry;
	config: Pick<FleetConfig, "workspaceDir" | "providerProfiles">;
	transport: DaemonTransportRegistry;
	/** Fleet log store; null when the logs dir was unwritable at boot. */
	logStore: FleetLogStore | null;
	/** Post-verification volume deleter (default = local volume removal). */
	resourceDeleter: WorkspaceResourceDeleter;
	eventLog: FleetEventLog;
	/**
	 * Attach the fleet log-store tap for a workspace's callback envelopes.
	 * Called when this service enrolls a runtime generation (the ONLY place
	 * a fresh pair can start after boot) so a fresh clone never streams into
	 * the void.
	 */
	attachLogTap(workspaceId: string): void;
	/** Fleet callback base URL the sandbox daemon dials (http loopback dev). */
	callbackUrl(): string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** One `git -C <cwd> <args>` invocation via explicit argv, never a shell. */
async function runGit(
	args: string[],
	cwd: string,
	opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	}) as Subprocess & {
		stdout: ReadableStream<Uint8Array<ArrayBufferLike>>;
		stderr: ReadableStream<Uint8Array<ArrayBufferLike>>;
	};
	const read = async (stream: ReadableStream<Uint8Array<ArrayBufferLike>>): Promise<string> => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let out = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += decoder.decode(value as Buffer, { stream: true });
		}
		return out;
	};
	const [stdout, stderr] = await Promise.all([read(child.stdout), read(child.stderr)]);
	const timedOut = await Promise.race([
		child.exited.then(() => false),
		sleep(opts?.timeoutMs ?? 15_000).then(() => true),
	]);
	if (timedOut) {
		child.kill("SIGKILL");
		await child.exited.catch(() => {
			// Exit may reject if the child was never reaped; ignore.
		});
		return { exitCode: 124, stdout, stderr: `${stderr}\ngit timed out` };
	}
	await child.exited.catch(() => {
		// Handled below through exitCode.
	});
	return { exitCode: child.exitCode ?? 1, stdout, stderr };
}

/** sha256 hex of a file read via a bounded chunk stream. */
async function sha256File(absolute: string): Promise<string> {
	const hash = createHash("sha256");
	const file = Bun.file(absolute);
	const stream = file.stream();
	const reader = stream.getReader();
	const chunk = new Uint8Array(256 * 1024);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		let offset = 0;
		while (offset < value.length) {
			const take = Math.min(chunk.length, value.length - offset);
			hash.update(value.subarray(offset, offset + take));
			offset += take;
		}
	}
	return hash.digest("hex");
}

/** One volume file the completeness cross-check compares against the store. */
interface VolumeFile {
	sessionId: string;
	/** POSIX relpath inside the session dir (manifest rules). */
	relpath: string;
	size: number;
}

/**
 * Walk one volume session dir for regular files (no traversal, no symlinks),
 * mirroring the manifest relpath rules, bounded like the export gate.
 */
function walkSessionDir(
	sessionDir: string,
	sessionId: string,
	state: { files: number; bytes: number },
	out: VolumeFile[],
): void {
	let entries;
	try {
		entries = readdirSync(sessionDir, { withFileTypes: true });
	} catch {
		return; // Missing/unreadable session dir: nothing to enumerate.
	}
	for (const dent of entries) {
		const absolute = join(sessionDir, dent.name);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(absolute);
		} catch {
			continue;
		}
		if (stats.isSymbolicLink()) continue; // Reject symlinks (P7.2).
		if (stats.isDirectory()) {
			walkSessionDir(absolute, sessionId, state, out);
			continue;
		}
		if (!stats.isFile()) continue; // Sockets/fifos are rejected.
		if (state.files >= MAX_EXPORT_FILES || state.bytes + stats.size > MAX_EXPORT_BYTES) {
			continue; // Bound exceeded; the gate below reports the shortfall.
		}
		const rel = relativePosix(sessionDir, absolute);
		if (rel.length === 0 || !isNormalizedPosixRelativePath(rel)) continue;
		state.files += 1;
		state.bytes += stats.size;
		out.push({ sessionId, relpath: rel, size: stats.size });
	}
}

/** Read one directory's entries (missing/unreadable → []). */
function listDir(dir: string): Array<{ name: string; isDirectory(): boolean }> {
	try {
		return readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
			name: string;
			isDirectory(): boolean;
		}>;
	} catch {
		return [];
	}
}

function relativePosix(fromDir: string, absolute: string): string {
	const rel = absolute
		.slice(fromDir.length)
		.replace(/^[/\\]+/, "")
		.split("\\")
		.join("/");
	return rel;
}

// ---------------------------------------------------------------------------
// The lifecycle service
// ---------------------------------------------------------------------------

/**
 * Clone workspace lifecycle owner. Conforms to Transport's `EdgeLifecycleHooks`
 * (createClone / ensureCloneRunning / stopClone / deleteClone / removeClone);
 * richer method returns are assignable to the void-hook signatures.
 */
export class WorkspaceLifecycle {
	readonly #deps: WorkspaceLifecycleDeps;
	/** Workspaces with a verified delete gate in flight (serializes DELETEs). */
	readonly #deleting = new Set<string>();
	/** Bounded pair-readiness watchers (setTimeout id per workspace). */
	readonly #pairWatchers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(deps: WorkspaceLifecycleDeps) {
		this.#deps = deps;
	}

	// ------------------------------------------------------------------
	// Public hook surface (EdgeLifecycleHooks-compatible)
	// ------------------------------------------------------------------

	/**
	 * Create a clone workspace (frozen contract). Persists the registry
	 * record (source, profile, desired state) and the resolved pin BEFORE
	 * any retry-prone step; prepares the fleet-local volume (bwrap
	 * profiles); starts it when `start` is true.
	 *
	 * Typed failures: invalid_request (bad input), unavailable (unknown
	 * profile / unresolvable source or pin / provider unavailable),
	 * conflict (a prepared clone at the same identity cannot be started
	 * safely), provider_failed (provider op failure after preparation).
	 *
	 * On PREPARATION failure the entry and its partial volume are removed
	 * and the error is typed; nothing streamed, nothing retained. On
	 * START failure after a successful preparation the entry IS retained
	 * (volume + pin are expensive and durable) with lifecycleStage
	 * "failed" + lifecycleError; retry via ensureCloneRunning (start).
	 */
	async createClone(input: CloneCreateInput): Promise<RegistryEntry> {
		const { registry, config } = this.#deps;
		const projectId = input.projectId;
		const name = input.name;
		const profileId = input.profileId;
		if (typeof projectId !== "string" || projectId.length === 0) {
			throw new CloneLifecycleError("invalid_request", "missing or invalid field: projectId");
		}
		if (typeof name !== "string" || name.trim() === "" || name.includes("\0")) {
			throw new CloneLifecycleError(
				"invalid_request",
				"missing or invalid field: name (must be non-empty, no NUL)",
			);
		}
		if (typeof profileId !== "string" || profileId.length === 0) {
			throw new CloneLifecycleError("invalid_request", "missing or invalid field: profileId");
		}
		const rawSource = input.source;
		if (
			rawSource !== undefined &&
			(rawSource === null || typeof rawSource !== "object" || Array.isArray(rawSource))
		) {
			throw new CloneLifecycleError("invalid_request", "source must be an object");
		}
		const sourceLocal = rawSource?.local;
		const sourceRemote = rawSource?.remote;
		if (
			(sourceLocal !== undefined && sourceRemote !== undefined) ||
			(sourceLocal !== undefined && typeof sourceLocal !== "string") ||
			(sourceRemote !== undefined && typeof sourceRemote !== "string")
		) {
			throw new CloneLifecycleError(
				"invalid_request",
				"source must carry exactly one of local (string path) or remote (string URL)",
			);
		}
		if (
			input.revision !== undefined &&
			(typeof input.revision !== "string" || input.revision.trim() === "")
		) {
			throw new CloneLifecycleError("invalid_request", "revision must be a non-empty string");
		}
		if (
			input.branch !== undefined &&
			(typeof input.branch !== "string" || input.branch.trim() === "")
		) {
			throw new CloneLifecycleError("invalid_request", "branch must be a non-empty string");
		}

		const project = registry.projects().find((p) => p.projectId === projectId);
		if (project === undefined) {
			throw new CloneLifecycleError("invalid_request", `unknown project: ${projectId}`);
		}
		const profile = config.providerProfiles?.[profileId];
		if (profile === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`no resolvable provider profile "${profileId}" (no matching providerProfiles entry)`,
			);
		}

		// Exactly-one source: an omitted source defaults to the registered
		// project's own local path (frozen contract).
		const source: { local?: string; remote?: string } =
			sourceLocal !== undefined || sourceRemote !== undefined
				? {
						...(sourceLocal !== undefined ? { local: sourceLocal } : {}),
						...(sourceRemote !== undefined ? { remote: sourceRemote } : {}),
					}
				: { local: project.path };
		const start = input.start ?? false;
		const branch = input.branch ?? deriveWorkspaceBranch(name);

		// Durable identity first: the volume lives under workspaceDir/<dN>.
		const created = registry.create({
			name: name.trim(),
			cwd: "",
			project: project.name,
			projectId,
			managed: true,
			labels: [],
			mode: "spawned",
			status: "asleep",
		});
		const daemonId = created.daemonId;
		const volumeRoot = join(config.workspaceDir, daemonId);

		// Persist source/profile/desiredState BEFORE any retry-prone step.
		const record: WorkspaceRecord = {
			kind: "clone",
			projectId,
			source,
			branch,
			profileId,
			desiredState: start ? "running" : "stopped",
		};
		registry.update(daemonId, {
			cwd: volumeRoot,
			lifecycleStage: "preparation",
			lifecycleError: undefined,
		});
		registry.setWorkspace(daemonId, record);
		this.#deps.eventLog.add(
			"info",
			"server",
			`clone ${daemonId} created (${profile.provider})`,
			daemonId,
		);

		// Resolve the pin ONCE, for EVERY profile (fleet-owned pin
		// resolution, the k8s provider never resolves; Runtime contract).
		// prepareWorkspace (bwrap) resolves internally too, but the explicit
		// resolve here persists the full commit BEFORE any retry-prone step
		// and feeds the persisted pin into the volume prep below.
		let pinnedRevision: string | undefined;
		try {
			pinnedRevision = await resolveWorkspacePin(source, input.revision, {
				// The workspaceDir is created lazily and may not exist yet on a
				// fresh fleet; the registered project path always exists.
				cwd: project.path,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const code =
				err instanceof PrepareWorkspaceError
					? err.code === "invalid_request"
						? "invalid_request"
						: "unavailable"
					: "unavailable";
			// Nothing streamed and nothing retained: drop the fresh entry +
			// volume (no preparation happened yet); the typed failure is the
			// whole story.
			this.#removeEntryAndVolume(daemonId, volumeRoot);
			throw new CloneLifecycleError(code, `cannot resolve clone pin: ${message}`);
		}
		registry.updateWorkspace(daemonId, { pinnedRevision });

		// Preparation. Fleet-local volumes (bwrap) prepare here; kubernetes
		// profiles skip the fleet-side clone: the provider initializes its
		// PVC in-pod at the persisted pin during ensure-running (Runtime
		// lane), reusing the SAME full commit on every retry.
		if (profile.provider === "bwrap") {
			try {
				await prepareWorkspace({
					workspaceId: daemonId,
					workspaceRoot: volumeRoot,
					source,
					branch,
					revision: pinnedRevision,
					sandboxEnvKeys: Object.keys(profile.secretRefs ?? {}),
				});
			} catch (err) {
				const code =
					err instanceof PrepareWorkspaceError
						? err.code
						: err instanceof Error && err.message.includes("not a git repository")
							? "invalid_request"
							: "unavailable";
				const message = err instanceof Error ? err.message : String(err);
				// Nothing streamed and nothing retained: drop the partial
				// entry + volume; the typed failure is the whole story.
				this.#removeEntryAndVolume(daemonId, volumeRoot);
				throw new CloneLifecycleError(
					code === "invalid_request" || code === "conflict" || code === "provider_failed"
						? code
						: "unavailable",
					`clone preparation failed: ${message}`,
				);
			}
		}

		if (!start) {
			// Prepared and parked: stopped clone, wakeable via start. A
			// stopped workspace has NO active lifecycle stage; clear the
			// transient "preparation" so the roster never shows an eternal
			// pulsing stage for a deliberately parked clone (start will set
			// preparation→runtime→callback→ready on wake).
			registry.update(daemonId, { lifecycleStage: undefined, lifecycleError: undefined });
			this.#deps.eventLog.add(
				"info",
				"server",
				`clone ${daemonId} prepared at ${pinnedRevision} (stopped)`,
				daemonId,
			);
			return registry.get(daemonId) ?? created;
		}

		// Start immediately: run the ensure path. A start failure after a
		// successful preparation keeps the entry (typed failed stage): the
		// volume + pin are durable and expensive; start retries in place.
		try {
			await this.#ensure(registry.get(daemonId) ?? registry.update(daemonId, {}), {
				firstStart: true,
			});
		} catch (err) {
			const code =
				err instanceof CloneLifecycleError
					? err.code
					: err instanceof Error
						? this.#codeForEnsureFailure(err)
						: "provider_failed";
			const message = err instanceof Error ? err.message : String(err);
			this.#setStage(daemonId, "failed", `${code}: ${message}`);
			registry.updateWorkspace(daemonId, { desiredState: "stopped" });
			this.#deps.eventLog.add(
				"warn",
				"server",
				`clone ${daemonId} start after create failed (${code}): ${message}`,
				daemonId,
			);
			throw new CloneLifecycleError(
				code,
				`clone ${daemonId} prepared but start failed (${code}): ${message}; retry with start, or delete to remove it`,
			);
		}
		return registry.get(daemonId) ?? created;
	}

	/**
	 * Start/wake: ensure-running. Resolves when the provider confirms the
	 * compute is running and the enrollment is persisted; never blocks on
	 * pair readiness (callback → ready rides the roster via the bounded
	 * pair watcher). Rejects with typed errors otherwise.
	 *
	 * P8.9 wake resume: `resumeSessionId` names the session this wake
	 * should boot into (the edge pre-validates it against the fleet store
	 * listing). When given, the wake materializes that session's cold/
	 * missing stored transcripts into the volume and hands the daemon the
	 * resolved main-file path as OMP_SESSION_RESUME (bwrap volumes only:
	 * the sandbox sees the host path). When ABSENT the wake resumes the
	 * newest session it can see (volume ∪ store), so a stopped clone wake
	 * continues its last session instead of booting fresh; a never-started
	 * clone (no sessions anywhere) still boots fresh. An EXPLICIT id that
	 * exists nowhere is a typed `unavailable`, never a silent fresh boot.
	 */
	async ensureCloneRunning(daemonId: string, opts?: { resumeSessionId?: string }): Promise<void> {
		const entry = this.#requireClone(daemonId, "start");
		if (entry.workspace?.deletion?.state !== undefined) {
			throw new CloneLifecycleError(
				entry.workspace.deletion.state === "delete-pending-retry" ? "archive_pending" : "conflict",
				`workspace ${daemonId} is being deleted (${entry.workspace.deletion.state}); cannot start`,
			);
		}
		await this.#ensure(entry, { firstStart: false, resumeSessionId: opts?.resumeSessionId });
	}

	/** Stop: proof-bearing provider stop, desiredState stopped, enrollment
	 *  revoked. Preserves checkout + session logs (never deletes). */
	async stopClone(daemonId: string): Promise<void> {
		const entry = this.#requireClone(daemonId, "stop");
		const record = entry.workspace;
		if (record?.deletion?.state !== undefined) {
			throw new CloneLifecycleError(
				"conflict",
				`workspace ${daemonId} is being deleted (${record.deletion.state}); stop is not available`,
			);
		}
		const generation = record?.authorizedGeneration;
		const handle = this.#handleOf(entry);
		if (generation !== undefined) {
			// #runCloneOp throws a typed CloneLifecycleError on provider
			// failure; an ok response here proves the generation terminated.
			const response = await this.#runCloneOp(entry.daemonId, "stop", handle);
			if (response.observed === "running") {
				// The provider failed to prove termination: a running
				// process would violate the desired stopped state.
				throw new CloneLifecycleError(
					"conflict",
					`stop of ${daemonId} could not prove termination (observed running)`,
				);
			}
		}
		this.#deps.registry.updateWorkspace(daemonId, { desiredState: "stopped" });
		this.#deps.registry.setStatus(daemonId, "asleep");
		// A stopped workspace has no active lifecycle stage (stop cleared
		// it): start/wake re-runs preparation→runtime→callback→ready.
		this.#deps.registry.update(daemonId, {
			lifecycleStage: undefined,
			lifecycleError: undefined,
		});
		if (generation !== undefined) {
			this.#deps.transport.revokeEnrollment(daemonId, generation);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, generation);
		}
		this.#deps.eventLog.add(
			"info",
			"server",
			`clone ${daemonId} stopped (gen ${generation ?? "never-started"})`,
			daemonId,
		);
	}

	/** Verified deletion (P7.3/P7.5). `removeClone` is an alias: clone
	 *  removal NEVER bypasses the gate. Returns the verified session list. */
	async deleteClone(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		return await this.#deleteGate(daemonId);
	}

	/** Clone-safe remove: routes through the SAME verified gate. */
	async removeClone(daemonId: string): Promise<void> {
		await this.#deleteGate(daemonId);
	}

	// ------------------------------------------------------------------
	// Boot reconciliation (P6.3)
	// ------------------------------------------------------------------

	/**
	 * Reconcile provider-managed clone workspaces after a fleet restart.
	 * Provider compute survived the restart (it is not an in-memory child),
	 * so this inspects durable identity BEFORE acting:
	 *   - observed running  → reattach (refresh handle, ready), same
	 *     generation, persisted credential reused; NEVER a new process;
	 *   - observed stopped/missing + desired running → ensure-running
	 *     (bumped generation after the predecessor is proven gone);
	 *   - desired stopped → leave.
	 * Failures are bounded, logged, and never hidden retry loops. Never
	 * downgrades statuses (clone entries are skipped by the legacy boot
	 * status reconcile in server.ts).
	 */
	async reconcile(): Promise<void> {
		for (const entry of this.#deps.registry.list()) {
			if (entry.workspace?.kind !== "clone") continue;
			const record = entry.workspace;
			// A persisted "deleting" state describes an in-flight gate of a
			// previous fleet process; nothing is running now, so it
			// reconciles to delete-pending-retry (retry by deleting again).
			if (record.deletion?.state === "deleting") {
				this.#deps.registry.setWorkspaceDeletion(entry.daemonId, {
					state: "delete-pending-retry",
					requestedAt: record.deletion.requestedAt,
					error: {
						code: "retryable",
						message: "deletion was interrupted before verification completed; retry the delete",
					},
				});
				continue;
			}
			if (record.providerHandle === undefined && record.authorizedGeneration === undefined) {
				continue; // Never started; nothing to inspect or reattach.
			}
			const desired = record.desiredState;
			let response: ProviderOkResponse;
			try {
				// #runCloneOp throws a typed CloneLifecycleError on provider
				// failure; an ok response here is a trustworthy observation.
				response = await this.#runCloneOp(entry.daemonId, "inspect", this.#handleOf(entry));
			} catch (err) {
				this.#log(
					"warn",
					`clone boot reconcile: inspect failed for ${entry.daemonId}: ${err instanceof Error ? err.message : String(err)}`,
					entry.daemonId,
				);
				continue;
			}
			if (response.observed === "running") {
				// Reattach: same generation, refresh handle, surface liveness.
				this.#deps.registry.updateWorkspace(entry.daemonId, { providerHandle: response.handle });
				this.#deps.registry.setStatus(entry.daemonId, "ready");
				this.#setStage(entry.daemonId, "ready");
				this.#log(
					"info",
					`clone boot reconcile: ${entry.daemonId} reattached (running)`,
					entry.daemonId,
				);
				continue;
			}
			// stopped | missing: desired state decides.
			if (desired === "running") {
				try {
					await this.#ensure(this.#deps.registry.get(entry.daemonId) ?? entry, {
						firstStart: false,
					});
					this.#log(
						"info",
						`clone boot reconcile: ${entry.daemonId} recreated (${response.observed} → ensure-running)`,
						entry.daemonId,
					);
				} catch (err) {
					this.#log(
						"warn",
						`clone boot reconcile: ensure-running failed for ${entry.daemonId}: ${err instanceof Error ? err.message : String(err)}`,
						entry.daemonId,
					);
				}
			} else {
				this.#log(
					"info",
					`clone boot reconcile: ${entry.daemonId} left ${response.observed} (desired stopped)`,
					entry.daemonId,
				);
			}
		}
	}

	/** Cancel timers (server close()); never stops provider compute. */
	close(): void {
		for (const timer of this.#pairWatchers.values()) clearTimeout(timer);
		this.#pairWatchers.clear();
	}

	// ------------------------------------------------------------------
	// Ensure-running (start/wake/reconcile core)
	// ------------------------------------------------------------------

	/**
	 * P6.1/P6.2 ensure-running. Inspect-before-act, then:
	 *   - running + persisted binding at the current generation → reattach:
	 *     reuse the daemon's own credential (recovered from the state file),
	 *     no generation bump, no replacement;
	 *   - running + NO recoverable binding → replacement: prove the
	 *     predecessor terminated (provider stop), THEN bump the generation
	 *     and start fresh;
	 *   - stopped/missing → start. If the workspace ran before, the
	 *     predecessor is already proven gone (the stop that parked it), so
	 *     the generation bumps to fence stale callbacks; a first start runs
	 *     at generation 1.
	 * On success: provider handle, authorized generation, desiredState
	 * running, status ready persist; lifecycleStage advances
	 * runtime → callback (pair watcher → ready).
	 */
	async #ensure(
		entry: RegistryEntry,
		opts: { firstStart: boolean; resumeSessionId?: string },
	): Promise<ProviderResponse> {
		const daemonId = entry.daemonId;
		const record = entry.workspace;
		if (record?.kind !== "clone") {
			throw new CloneLifecycleError(
				"invalid_request",
				`daemon ${daemonId} is not a clone workspace (kind ${record?.kind ?? "legacy"}); start a worktree/direct session through /ctl/spawn`,
			);
		}
		// A workspace mid-deletion must not re-enroll (P7.3 admission
		// barrier: "block new admission once deletion begins").
		if (record.deletion?.state !== undefined) {
			throw new CloneLifecycleError(
				record.deletion.state === "delete-pending-retry" ? "archive_pending" : "conflict",
				`workspace ${daemonId} is being deleted (${record.deletion.state}); cannot start`,
			);
		}
		const currentGen = record.authorizedGeneration;
		const handle = this.#handleOf(entry);
		this.#setStage(daemonId, "runtime");

		// Inspect first: a live sandbox must never be blindly recreated.
		// #runCloneOp throws a typed CloneLifecycleError on provider failure
		// (conflict = uncertain predecessor, unavailable, provider_failed).
		let inspect: ProviderOkResponse | null = null;
		if (currentGen !== undefined || handle !== undefined) {
			try {
				inspect = await this.#runCloneOp(entry.daemonId, "inspect", handle);
			} catch (err) {
				// Inspect unavailable is NOT a license to recreate: an
				// unknown predecessor blocks replacement (P6.2).
				throw err instanceof CloneLifecycleError
					? err
					: new CloneLifecycleError(
							"unavailable",
							`cannot inspect ${daemonId} before start: ${err instanceof Error ? err.message : String(err)}`,
						);
			}
		}

		let generation: number;
		let reuseToken: string | undefined;
		if (inspect !== null && inspect.observed === "running" && currentGen !== undefined) {
			// Reattach path. If the persisted binding matches this
			// generation AND the state-file token is recoverable, reuse it:
			// the daemon's live pair keeps its original credential.
			if (record.enrollment !== undefined && record.enrollment.generation === currentGen) {
				try {
					reuseToken = this.#persistedCallbackToken(entry, currentGen);
				} catch {
					reuseToken = undefined;
				}
			}
			if (reuseToken !== undefined) {
				generation = currentGen;
			} else {
				// Running with no recoverable binding: replacing the process
				// would create two writers on one volume. Prove the
				// predecessor terminated FIRST, then bump the generation.
				// (#runCloneOp throws on a non-ok stop; observed running
				// after an ok stop means termination is unproven.)
				const stop = await this.#runCloneOp(entry.daemonId, "stop", handle);
				if (stop.observed === "running") {
					throw new CloneLifecycleError(
						"conflict",
						`cannot replace ${daemonId}: predecessor termination is uncertain (stop did not prove); no new writer admitted`,
					);
				}
				generation = currentGen + 1;
			}
		} else {
			// stopped | missing (proven gone), or never started.
			if (opts.firstStart && currentGen === undefined) {
				generation = 1;
			} else {
				generation = (currentGen ?? 0) + 1;
			}
		}

		// P8.9 wake resume: when this wake is spawning a NEW daemon process
		// (not the reattach path), compute the resume target and materialize
		// cold/missing transcripts into the volume BEFORE the provider runs.
		// The resume hint rides the callback-env handoff
		// (OMP_SESSION_RESUME, allowlisted by the providers) so the daemon's
		// existing boot switchSession(config.resume) resumes it. Only bwrap
		// volumes: the sandbox binds the volume at the HOST path, so the
		// fleet-resolved path is valid in-sandbox; k8s pod paths differ and
		// its PVC is retained across stop (warm), so no fleet-side hint.
		// Computed BEFORE enrollment persists so a typed failure (an explicit
		// id that exists nowhere) never leaves a dangling enrollment behind.
		const resumeFile =
			reuseToken !== undefined && generation === currentGen
				? undefined // Reattach: same live process; no new spawn to hint.
				: await this.#resolveWakeResume(entry, opts);

		// Enroll + persist the binding BEFORE ensure-running (a live
		// credential must exist for the daemon's pair). Attach the log tap
		// at the same time so a fresh clone never streams into the void.
		// P6.2 fencing: when the generation is BUMPED (predecessor proven
		// terminated), revoke the OLD generation's enrollment first so a
		// stale credential can never authenticate against the new runtime.
		if (currentGen !== undefined && generation > currentGen) {
			this.#deps.transport.revokeEnrollment(daemonId, currentGen);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, currentGen);
		}
		const credentialHex = reuseToken ?? randomBytes(ENROLLMENT_KEY_BYTES).toString("hex");
		const digest = this.#deps.transport.enrollWorkspace(daemonId, generation, credentialHex);
		this.#deps.registry.setWorkspaceEnrollment(daemonId, { credentialHash: digest, generation });
		this.#writeCallbackEnv(entry, generation, credentialHex, resumeFile);
		this.#deps.attachLogTap(daemonId);

		try {
			// #runCloneOp throws on a non-ok provider response; an ok
			// response here is a live, current-generation runtime. The
			// generation override is REQUIRED: the bump was computed +
			// enrolled above but authorizedGeneration persists only after
			// ensure succeeds; without it the request would carry the stale
			// pre-bump generation and the provider would fence it (P6.2).
			const response = await this.#runCloneOp(entry.daemonId, "ensure-running", handle, generation);
			this.#deps.registry.updateWorkspace(daemonId, {
				providerHandle: response.handle,
				authorizedGeneration: generation,
				desiredState: "running",
			});
			if (response.observed === "running") {
				this.#deps.registry.setStatus(daemonId, "ready");
				this.#setStage(daemonId, "callback");
				// Bounded pair-readiness watcher: callback → ready when the
				// daemon's pair is observed live (never blocks the caller).
				this.#armPairWatcher(daemonId);
			}
			this.#log(
				"info",
				`clone ${daemonId} ensured running (gen ${generation}, observed ${response.observed})`,
				daemonId,
			);
			return response;
		} catch (err) {
			// A failed start must not leave a live enrollment credential or
			// a running desired state behind.
			this.#deps.transport.revokeEnrollment(daemonId, generation);
			this.#deps.registry.clearWorkspaceEnrollment(daemonId, generation);
			throw err;
		}
	}

	// ------------------------------------------------------------------
	// The verified delete gate (P7.3/P7.5)
	// ------------------------------------------------------------------

	/**
	 * P7.3/P7.5 ordered gate for clone workspaces (shared by deleteClone and
	 * removeClone, removal cannot bypass it):
	 *   1. serialize concurrent DELETEs + reconcile a persisted "deleting"
	 *      from a previous fleet process to delete-pending-retry;
	 *   2. admission: refuse while compute is live or its pair is live
	 *      (activity is not observable fleet-side for clones, so a live
	 *      workspace is refused until explicitly stopped);
	 *   3. persist "deleting" (durable state before any destructive step);
	 *   4. quiesce: revoke the callback enrollment (no further log frames)
	 *      and PROVE the compute stopped via the provider BEFORE
	 *      verification; a stop that cannot prove termination blocks;
	 *   5. Git guard with writers stopped (dirty/untracked/stash/unpreserved
	 *      history block; no force override);
	 *   6. fleet-store verification INCLUDING an independent cross-check of
	 *      the workspace volume's own session tree; an empty store never
	 *      trivially passes when sessions existed on the volume;
	 *   7. read-only flip (only when anything is retained);
	 *   8. provider deletion → volume deletion → roster removal.
	 * Any failure before verification persists delete-pending-retry with a
	 * typed error and retains the workspace, its volume, and its store.
	 */
	async #deleteGate(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		const entry0 = this.#deps.registry.get(daemonId);
		if (!entry0) {
			throw new CloneLifecycleError("invalid_request", `unknown daemon: ${daemonId}`);
		}
		if (entry0.workspace?.kind !== "clone") {
			throw new CloneLifecycleError(
				"invalid_request",
				`daemon ${daemonId} is not a clone workspace; deletion routes by kind and this gate only owns clones`,
			);
		}
		if (this.#deleting.has(daemonId)) {
			throw new CloneLifecycleError(
				"conflict",
				`deletion already in progress for workspace ${daemonId}`,
			);
		}

		// Reconcile a persisted "deleting" from a crashed previous fleet.
		let entry = this.#deps.registry.get(daemonId) ?? entry0;
		const previous = entry.workspace?.deletion;
		if (previous?.state === "deleting") {
			this.#deps.registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt: previous.requestedAt,
				error: {
					code: "retryable",
					message: "deletion was interrupted before verification completed; retry the delete",
				},
			});
			entry = this.#deps.registry.get(daemonId) ?? entry;
		}

		// Admission. For clones, "active work" is not derivable fleet-side:
		// a ready workspace whose callback pair is live (or whose enrollment
		// is live) may carry accepted work; refuse with an actionable
		// message instead of risking mid-turn deletion. Explicitly stopped
		// workspaces (asleep, desired stopped, enrollment revoked) pass.
		const record = entry.workspace;
		const pair = this.#deps.transport.pairStatus(daemonId);
		const live =
			entry.status === "ready" &&
			(record?.desiredState === "running" || pair.enrolled || pair.paired);
		if (live) {
			throw new CloneLifecycleError(
				"writer_active",
				`workspace ${daemonId} is live with unobservable activity; stop current work (explicit stop) before deleting`,
			);
		}

		this.#deleting.add(daemonId);
		try {
			return await this.#gate(daemonId);
		} finally {
			this.#deleting.delete(daemonId);
		}
	}

	/** The gate body (runs under the #deleting serialization). */
	async #gate(daemonId: string): Promise<{ removed: string; verified: string[] }> {
		const { registry, logStore, eventLog } = this.#deps;
		const requestedAt = Date.now();
		let entry = this.#require(daemonId);
		const previous = entry.workspace?.deletion;

		// Durable "deleting" before ANY destructive step (P7.3/P7.5:
		// registry identity is never removed early; cleanup state survives
		// restart). Re-entry from delete-pending-retry keeps remaining
		// resources across the retry.
		registry.setWorkspaceDeletion(daemonId, {
			state: "deleting",
			requestedAt,
			...(previous?.remainingResources !== undefined
				? { remainingResources: previous.remainingResources }
				: {}),
		});

		// Quiesce writers: revoke the callback enrollment (no further log
		// frames reach the store), then PROVE the provider compute stopped.
		// The stop is not a flush acknowledgment; only the store's verified
		// offsets + the volume cross-check prove completeness, but no writer
		// may still run while verification reads.
		if (entry.workspace?.enrollment !== undefined) {
			const gen = entry.workspace.enrollment.generation;
			this.#deps.transport.revokeEnrollment(daemonId, gen);
			registry.clearWorkspaceEnrollment(daemonId, gen);
		}
		const gen = entry.workspace?.authorizedGeneration;
		const everStarted = gen !== undefined || entry.workspace?.providerHandle !== undefined;
		if (everStarted) {
			let stop: ProviderOkResponse;
			try {
				stop = await this.#runCloneOp(entry.daemonId, "stop", this.#handleOf(entry));
			} catch (err) {
				// #runCloneOp throws a typed CloneLifecycleError on provider
				// failure; persist delete-pending-retry and retain everything.
				const code = err instanceof CloneLifecycleError ? err.code : "provider_failed";
				const message = err instanceof Error ? err.message : String(err);
				const error: DeletionGateError = {
					code: code === "conflict" ? "conflict" : "provider_failed",
					message: `cannot quiesce compute before verification: ${message}`,
				};
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					error,
				});
				eventLog.add(
					"warn",
					"server",
					`delete ${daemonId} blocked: quiesce stop failed (${error.code}): ${error.message}`,
					daemonId,
				);
				throw new CloneLifecycleError(error.code, error.message);
			}
			if (stop.observed === "running") {
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					error: {
						code: "conflict",
						message: "could not prove the workspace's compute terminated; deletion blocked",
					},
				});
				throw new CloneLifecycleError(
					"conflict",
					`workspace ${daemonId} compute could not be proven terminated; deletion blocked`,
				);
			}
			// The stopped generation is proven gone: persist the desired
			// stopped state so no boot reconcile races the gate.
			registry.updateWorkspace(daemonId, { desiredState: "stopped" });
			registry.setStatus(daemonId, "asleep");
			registry.update(daemonId, { lifecycleStage: undefined, lifecycleError: undefined });
			entry = registry.get(daemonId) ?? entry;
		}

		// Git guard (P7.4), writers stopped: reject dirty files, untracked
		// files, stashes, and unpreserved local history. No force override.
		await this.#runGitGuard(daemonId);

		// Store verification. When the fleet log store is absent, deletion
		// cannot be verified and is blocked (everything retained).
		if (logStore === null) {
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error: {
					code: "unavailable",
					message: "fleet log store is unavailable; deletion cannot be verified",
				},
			});
			throw new CloneLifecycleError(
				"unavailable",
				`workspace ${daemonId} cannot be verified (log store unavailable); deletion blocked`,
			);
		}

		const record = registry.get(daemonId)?.workspace;
		const verify = await verifyWorkspaceLogs({
			logsRoot: logStore.rootDir,
			workspaceId: daemonId,
			// Additive provenance: yields the store-side manifest (per-file
			// sha256/size/sessionId) used by the volume cross-check.
			registry: {
				projectId: record?.projectId,
				workspaceName: entry.name,
				...(record?.source !== undefined ? { source: record.source } : {}),
				...(record?.pinnedRevision !== undefined ? { resolvedCommit: record.pinnedRevision } : {}),
			},
		});
		if (!verify.ok) {
			const error = {
				code: verify.code,
				message: verify.message,
				...(verify.path !== undefined ? { path: verify.path } : {}),
			};
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error,
			});
			eventLog.add(
				"warn",
				"server",
				`delete ${daemonId} blocked: store verification failed (${verify.code}${verify.path ? ` at ${verify.path}` : ""}): ${verify.message}`,
				daemonId,
			);
			throw new CloneLifecycleError(
				verify.code === "invalid_request" ? "invalid_request" : "archive_conflict",
				`workspace ${daemonId} store verification failed (${verify.code}): ${verify.message}`,
			);
		}

		// Independent completeness cross-check (never infer completeness
		// from an empty store): the workspace volume's own session tree must
		// be byte-identical to the verified store.
		const volumeCheck = await this.#verifyVolumeAgainstStore(daemonId, verify.manifest);
		if (!volumeCheck.ok) {
			const error: DeletionGateError = {
				code: "archive_conflict",
				message: volumeCheck.message,
			};
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error,
			});
			eventLog.add(
				"warn",
				"server",
				`delete ${daemonId} blocked: volume/store mismatch (${volumeCheck.message})`,
				daemonId,
			);
			throw new CloneLifecycleError("archive_conflict", volumeCheck.message);
		}

		// Verified: flip the store read-only ONLY when anything is retained
		// (a never-streamed workspace leaves no store subtree to flip).
		const retained = verify.sessions.length > 0;
		if (retained) {
			logStore.markWorkspaceReadOnly(daemonId);
		}

		// Provider deletion (stop-proof + provider state clear), then volume
		// removal, then the roster transition. Partial provider failure after
		// the flip records remaining resources and stays retry-able.
		if (everStarted) {
			try {
				await this.#deleteProvider(registry.get(daemonId) ?? entry);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				registry.setWorkspaceDeletion(daemonId, {
					state: "delete-pending-retry",
					requestedAt,
					error: { code: "provider_failed", message },
					remainingResources: [
						typeof registry.get(daemonId)?.workspace?.providerHandle === "string"
							? (registry.get(daemonId)?.workspace?.providerHandle as string)
							: (entry.cwd ?? ""),
					],
				});
				eventLog.add(
					"warn",
					"server",
					`delete ${daemonId}: store verified + read-only, provider deletion failed (${message}); resources remain`,
					daemonId,
				);
				throw new CloneLifecycleError(
					"provider_failed",
					`workspace ${daemonId} verified read-only, but provider deletion failed: ${message}`,
				);
			}
		}

		// Volume removal (LocalCloneResourceDeleter or a P5 provider hook).
		try {
			const current = registry.get(daemonId) ?? entry;
			await this.#deps.resourceDeleter.deleteWorkspaceResources(daemonId, current);
		} catch (err) {
			void record; // kept for the remainingResources fallback below.
			const message = err instanceof Error ? err.message : String(err);
			registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt,
				error: { code: "provider_failed", message },
				remainingResources: [entry.cwd ?? ""],
			});
			eventLog.add(
				"warn",
				"server",
				`delete ${daemonId}: store verified + read-only, volume removal failed (${message}); resources remain`,
				daemonId,
			);
			throw new CloneLifecycleError(
				"provider_failed",
				`workspace ${daemonId} verified read-only, but volume removal failed: ${message}`,
			);
		}

		// Finalize: roster identity removed (verified read-only store is
		// Retention's). No orphan marker: verification passed.
		registry.remove(daemonId);
		eventLog.add("info", "server", `workspace ${daemonId} deleted (verified)`, daemonId);
		return { removed: daemonId, verified: verify.sessions.map((s) => s.sessionId) };
	}

	// ------------------------------------------------------------------
	// Gate parts
	// ------------------------------------------------------------------

	/** Provider delete (runs only after the read-only flip). */
	async #deleteProvider(entry: RegistryEntry): Promise<ProviderOkResponse> {
		const generation = entry.workspace?.authorizedGeneration;
		// #runCloneOp throws a typed CloneLifecycleError on provider failure;
		// the gate's caller converts it to delete-pending-retry + remaining
		// resources.
		const response = await this.#runCloneOp(entry.daemonId, "delete", this.#handleOf(entry));
		if (generation !== undefined) {
			this.#deps.transport.revokeEnrollment(entry.daemonId, generation);
			this.#deps.registry.clearWorkspaceEnrollment(entry.daemonId, generation);
		}
		this.#log(
			"info",
			`clone ${entry.daemonId} provider deleted (gen ${generation ?? "never-started"}, observed ${response.observed})`,
			entry.daemonId,
		);
		return response;
	}

	/**
	 * P7.4 non-bypassable Git guard with writers stopped. Runs against the
	 * clone's `.checkout`: dirty files, untracked files, stashes, and
	 * unpreserved local history all block with actionable messages. No
	 * force override, no transcript-as-source-backup claim. Unreachable git
	 * or an unreadable checkout blocks (unknown verification status).
	 */
	async #runGitGuard(daemonId: string): Promise<void> {
		const entry = this.#require(daemonId);
		const checkoutDir = join(entry.cwd ?? "", ".checkout");
		if (!existsSync(join(checkoutDir, ".git"))) {
			// A never-prepared/never-started clone has no checkout to guard;
			// the store/volume checks below are authoritative.
			return;
		}
		const fail = (message: string): never => {
			this.#deps.registry.setWorkspaceDeletion(daemonId, {
				state: "delete-pending-retry",
				requestedAt: Date.now(),
				error: { code: "conflict", message },
			});
			throw new CloneLifecycleError("conflict", message);
		};

		// Dirty + untracked (writers stopped: `git status` is a read).
		const status = await runGit(["status", "--porcelain=v1"], checkoutDir);
		if (status.exitCode !== 0) {
			return fail(
				`cannot verify git state for ${daemonId} (status exited ${status.exitCode}): preserve the checkout manually and retry`,
			);
		}
		if (status.stdout.trim() !== "") {
			const lines = status.stdout.split("\n").filter((l) => l.length > 0);
			const sample = lines
				.slice(0, 5)
				.map((l) => l.slice(3))
				.join(", ");
			return fail(
				`workspace ${daemonId} has uncommitted or untracked files (${lines.length}): ${sample}…; commit/push or stash them before deletion (session transcripts are not source backup)`,
			);
		}
		// Stashes.
		const stash = await runGit(["stash", "list"], checkoutDir);
		if (stash.exitCode === 0 && stash.stdout.trim() !== "") {
			return fail(
				`workspace ${daemonId} has ${stash.stdout.trim().split("\n").length} stash(es); drop or apply them before deletion`,
			);
		}
		// Unpreserved local history: refresh origin remote-tracking refs
		// best-effort (offline is fine; the count below is conservative
		// against the last known refs), then count commits not reachable
		// from any origin ref.
		await runGit(["fetch", "--quiet", "--no-tags", "origin"], checkoutDir).catch(() => {
			// Offline: fall through to the last known remote-tracking refs.
		});
		const unpushed = await runGit(
			["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
			checkoutDir,
		);
		if (unpushed.exitCode !== 0) {
			return fail(
				`cannot verify history preservation for ${daemonId} (rev-list exited ${unpushed.exitCode}); preserve manually and retry`,
			);
		}
		const count = Number.parseInt(unpushed.stdout.trim(), 10);
		if (Number.isFinite(count) && count > 0) {
			return fail(
				`workspace ${daemonId} has ${count} commit(s) not preserved on its configured remote; push them first (no force override)`,
			);
		}
	}

	/**
	 * Independent completeness check: the workspace volume's own session
	 * tree (`.home/agent/sessions`) must be byte-identical to the verified
	 * store. This is what makes an empty store FAIL deletion when sessions
	 * actually existed on the volume.
	 */
	async #verifyVolumeAgainstStore(
		daemonId: string,
		storeManifest: ArchiveManifest | undefined,
	): Promise<{ ok: true } | { ok: false; message: string }> {
		const entry = this.#require(daemonId);
		const record = entry.workspace;
		const volumeRoot = entry.cwd ?? join(this.#deps.config.workspaceDir, daemonId);
		const sessionsDir = join(volumeRoot, ".home", "agent", "sessions");
		const everStarted =
			record?.authorizedGeneration !== undefined ||
			record?.providerHandle !== undefined ||
			record?.enrollment !== undefined;

		// The volume is fleet-readable when its root exists.
		const volumePresent = existsSync(volumeRoot);
		const files: VolumeFile[] = [];
		let bounded = true;
		if (volumePresent && existsSync(sessionsDir)) {
			const state = { files: 0, bytes: 0 };
			const rootEntries = listDir(sessionsDir);
			for (const dir of rootEntries) {
				if (!dir.isDirectory()) continue;
				const sid = dir.name;
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sid)) continue;
				walkSessionDir(join(sessionsDir, sid), sid, state, files);
			}
			if (state.files >= MAX_EXPORT_FILES || state.bytes > MAX_EXPORT_BYTES) {
				bounded = false;
			}
		}

		if (volumePresent && files.length === 0 && everStarted) {
			// Volume present but no session files yet: a running/stopped
			// workspace that never opened a session. The store should be
			// empty too; verifyWorkspaceLogs already proved that (ok with
			// sessions:[]). Nothing to cross-check.
		}
		if (!volumePresent) {
			if (everStarted && storeManifest === undefined) {
				// Store verified (storeManifest is present only on ok:true
				// with provenance), if the store really has zero sessions
				// AND we cannot read the volume, completeness is unprovable.
				// (storeManifest undefined on a non-ok result is handled by
				// the caller; here it means ok + no manifest is impossible.)
				return {
					ok: false,
					message: `cannot verify store completeness for ${daemonId}: volume is not fleet-readable and the store has no sessions to compare`,
				};
			}
			return { ok: true }; // k8s volume with verified stored sessions, or never started.
		}
		if (!bounded) {
			return {
				ok: false,
				message: `session tree for ${daemonId} exceeds verification bounds (${MAX_EXPORT_FILES} files / ${MAX_EXPORT_BYTES} bytes); deletion blocked`,
			};
		}
		if (files.length === 0) {
			return { ok: true }; // Nothing on the volume to compare; store empty is provably complete.
		}
		if (storeManifest === undefined) {
			return {
				ok: false,
				message: `workspace ${daemonId} has ${files.length} session file(s) on its volume but the store verification produced no manifest`,
			};
		}
		// Index the store manifest by (sessionId, path).
		const stored = new Map<string, { size: number; sha256: string }>();
		for (const file of storeManifest.files) {
			stored.set(`${file.sessionId}/${file.path}`, { size: file.size, sha256: file.sha256 });
		}
		// Every volume file must exist byte-identically in the store.
		for (const file of files) {
			const key = `${file.sessionId}/${file.relpath}`;
			const side = stored.get(key);
			if (side === undefined) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} (${file.size} bytes) is missing from the fleet store; deletion blocked (logs were not fully streamed)`,
				};
			}
			if (side.size !== file.size) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} is truncated in the fleet store (${side.size}/${file.size} bytes); deletion blocked`,
				};
			}
			const absolute = join(volumeRoot, ".home", "agent", "sessions", file.sessionId, file.relpath);
			const sha = await sha256File(absolute);
			if (sha !== side.sha256) {
				return {
					ok: false,
					message: `workspace ${daemonId} session ${file.sessionId} file ${file.relpath} differs from its stored bytes; deletion blocked (rewrite not re-streamed)`,
				};
			}
		}
		return { ok: true };
	}

	// ------------------------------------------------------------------
	// Provider invocation / paths / enrollment handoff
	// ------------------------------------------------------------------

	/** Resolve the profile (typed unavailable when absent). */
	#cloneProfile(entry: RegistryEntry): {
		profileId: string;
		profile: NonNullable<FleetConfig["providerProfiles"]>[string];
	} {
		const profileId = entry.workspace?.profileId;
		if (entry.workspace?.kind !== "clone" || profileId === undefined) {
			throw new CloneLifecycleError(
				"invalid_request",
				`clone workspace ${entry.daemonId} is missing a provider profile (kind ${entry.workspace?.kind ?? "legacy"})`,
			);
		}
		const profile = this.#deps.config.providerProfiles?.[profileId];
		if (profile === undefined) {
			throw new CloneLifecycleError(
				"unavailable",
				`clone workspace ${entry.daemonId} has no resolvable provider profile "${profileId}" (no matching providerProfiles entry)`,
			);
		}
		return { profileId, profile };
	}

	/** Workspace paths: volume root + sandbox dirs (frozen layout). */
	#clonePaths(entry: RegistryEntry): {
		volumeRoot: string;
		checkoutDir: string;
		homeDir: string;
		stateDir: string;
	} {
		const volumeRoot = join(this.#deps.config.workspaceDir, entry.daemonId);
		return {
			volumeRoot,
			checkoutDir: join(volumeRoot, ".checkout"),
			homeDir: join(volumeRoot, ".home"),
			stateDir: join(this.#deps.config.workspaceDir, ".provider-state", entry.daemonId),
		};
	}

	/** Opaque string provider handle, when one is persisted. */
	#handleOf(entry: RegistryEntry): string | undefined {
		return typeof entry.workspace?.providerHandle === "string"
			? entry.workspace.providerHandle
			: undefined;
	}

	/**
	 * One provider operation invocation, typed. Re-reads the CURRENT
	 * registry entry by daemonId so every op builds its request from ONE
	 * consistent snapshot; a stale caller entry can never send a request
	 * carrying an old generation against a freshly enrolled one (P6.2
	 * fencing). `generationOverride` is REQUIRED on the ensure-running call
	 * after a generation bump: the bump is computed and enrolled BEFORE the
	 * provider runs, but `authorizedGeneration` on the record is only
	 * persisted AFTER ensure succeeds; without the override the request
	 * would carry the stale pre-bump generation and the provider would
	 * fence it. Maps provider failures onto the frozen error vocabulary
	 * with caller-safe messages.
	 */
	async #runCloneOp(
		daemonId: string,
		op: "ensure-running" | "inspect" | "stop" | "delete",
		handle: string | undefined,
		generationOverride?: number,
	): Promise<ProviderOkResponse> {
		const entry = this.#require(daemonId);
		const { profile } = this.#cloneProfile(entry);
		const { checkoutDir, homeDir, stateDir } = this.#clonePaths(entry);
		const generation = generationOverride ?? entry.workspace?.authorizedGeneration ?? 1;
		const record = entry.workspace;
		// Every op carries the workspace's clone source + pinned full commit
		// + branch (Runtime contract): the k8s provider initializes its PVC
		// in-pod at the persisted pin from these, never resolves itself;
		// bwrap ignores them (fleet-side prepared). Additive per
		// shared/provider-protocol.ts ProviderRequest.
		const request = {
			op,
			workspaceId: daemonId,
			generation,
			workspaceDir: checkoutDir,
			homeDir,
			profile,
			...(handle !== undefined ? { handle } : {}),
			stateDir,
			...(record?.source !== undefined ? { source: record.source } : {}),
			...(record?.pinnedRevision !== undefined ? { revision: record.pinnedRevision } : {}),
			...(record?.branch !== undefined ? { branch: record.branch } : {}),
		};
		const response = await runProviderOp(profile.executable, request);
		if (response.ok) return response;
		throw new CloneLifecycleError(
			this.#codeForProviderError(response.error.code),
			`provider ${op} failed for ${entry.daemonId} (${response.error.code}): ${response.error.message}`,
		);
	}

	#codeForProviderError(code: string): CloneLifecycleErrorCode {
		switch (code) {
			case "invalid_request":
				return "invalid_request";
			case "conflict":
				return "conflict";
			case "unavailable":
				return "unavailable";
			case "retryable":
				return "retryable";
			default:
				return "provider_failed";
		}
	}

	#codeForEnsureFailure(err: Error): CloneLifecycleErrorCode {
		return err instanceof CloneLifecycleError ? err.code : "provider_failed";
	}

	/**
	 * P8.9 wake resume: compute the resume target for a NEW daemon spawn and
	 * materialize cold/missing transcripts into the volume. Returns the
	 * absolute main-session file path to hand the daemon via
	 * OMP_SESSION_RESUME, or undefined when the wake should boot fresh:
	 *   - never-started clones (no sessions anywhere) → fresh;
	 *   - k8s volumes (pod paths differ from host; PVC retained across
	 *     stop) → no fleet-side hint (documented P5-blocked lane);
	 *   - explicit `resumeSessionId` that exists nowhere → typed
	 *     `unavailable` (the edge pre-validates against the store, so this
	 *     only fires on a store/volume disagreement, never silent fresh);
	 *   - implicit wake → newest session (volume ∪ store) so a stopped
	 *     clone wake continues its last session.
	 * Fill-missing-only materialization: existing volume files are never
	 * overwritten (the volume may hold a newer unacked tail; the daemon's
	 * tailer re-streams it once booted). Throws CloneLifecycleError
	 * `unavailable` when an explicit target cannot be materialized.
	 */
	async #resolveWakeResume(
		entry: RegistryEntry,
		opts: { firstStart: boolean; resumeSessionId?: string },
	): Promise<{ OMP_SESSION_RESUME: string } | undefined> {
		const daemonId = entry.daemonId;
		const { profile } = this.#cloneProfile(entry);
		// k8s volumes are not fleet-path-identical and are retained across
		// stop (warm): no fleet-side resume hint on that lane.
		if (profile.provider !== "bwrap") return undefined;
		const store = this.#deps.logStore;
		const { volumeRoot } = this.#clonePaths(entry);
		const sessionsDir = join(volumeRoot, ".home", "agent", "sessions");
		const record = this.#deps.registry.get(daemonId)?.workspace;
		const everStarted =
			record?.authorizedGeneration !== undefined ||
			record?.providerHandle !== undefined ||
			record?.enrollment !== undefined;

		const explicit = opts.resumeSessionId;
		const target =
			explicit !== undefined
				? explicit
				: opts.firstStart && !everStarted
					? undefined
					: pickNewestSessionId({
							sessionsDir,
							...(store !== null ? { store, workspaceId: daemonId } : {}),
						});
		if (target === undefined) return undefined; // Nothing to resume: fresh boot.

		if (store !== null) {
			try {
				materializeMissingSessionFiles({
					store,
					workspaceId: daemonId,
					sessionId: target,
					sessionsDir,
				});
			} catch (err) {
				if (explicit !== undefined) {
					// An explicit pick that cannot be materialized is a typed
					// failure, never a silent fresh boot over the user's pick.
					throw err instanceof WakeMaterializeError
						? new CloneLifecycleError(
								err.code === "invalid_request" ? "invalid_request" : "unavailable",
								`cannot materialize session ${target} for wake of ${daemonId}: ${err.message}`,
							)
						: new CloneLifecycleError(
								"unavailable",
								`cannot materialize session ${target} for wake of ${daemonId}: ${err instanceof Error ? err.message : String(err)}`,
							);
				}
				// Implicit pick + materialize failure: fall back to whatever
				// is already warm on the volume (never fail a plain wake over
				// a store-only cold session).
			}
		} else if (explicit !== undefined) {
			// Explicit target with no store to fill from: only acceptable
			// when the volume already has it warm.
			if (resolveMainSessionFile(sessionsDir, target) === null) {
				throw new CloneLifecycleError(
					"unavailable",
					`cannot resume session ${target} for ${daemonId}: no fleet log store and the session is not on the volume`,
				);
			}
		}

		const mainFile = resolveMainSessionFile(sessionsDir, target);
		if (mainFile === null) {
			if (explicit !== undefined) {
				throw new CloneLifecycleError(
					"unavailable",
					`cannot resume session ${target} for ${daemonId}: no transcript on the volume or in the fleet store`,
				);
			}
			return undefined; // Implicit target vanished; boot fresh.
		}
		// Stale-lock cleanup (P8.9 boot-resume): the daemon locks the resumed
		// session file (`<file>.lock`) with its PID. A prior sandbox lifetime
		// that was stopped without a graceful release leaves that lock file
		// behind, and its PID is namespace-relative (e.g. 2 inside bwrap),
		// so the NEW sandbox's liveness probe sees an ALIVE pid 2 and refuses
		// to boot ("session file ... is locked by another omp-session"). This
		// wake only reaches here after the predecessor generation is PROVEN
		// terminated (P6.2 stop proof precedes the generation bump), so any
		// lock beside the resume target is definitionally stale: clear it
		// before the daemon spawns. Best-effort (a missing lock is fine).
		try {
			unlinkSync(`${mainFile}.lock`);
		} catch {
			// Absent or already cleared, nothing to do.
		}
		return { OMP_SESSION_RESUME: mainFile };
	}

	/** Write the 0600 callback-enrollment handoff BEFORE ensure-running. */
	#writeCallbackEnv(
		entry: RegistryEntry,
		generation: number,
		credentialHex: string,
		extraEnv?: Record<string, string>,
	): void {
		const { stateDir } = this.#clonePaths(entry);
		mkdirSync(stateDir, { recursive: true });
		const url = this.#deps.callbackUrl();
		const allowHttp = url.startsWith("http://") ? "1" : undefined;
		const env: Record<string, string> = {
			OMP_SESSION_CALLBACK_URL: url,
			OMP_SESSION_CALLBACK_WORKSPACE: entry.daemonId,
			OMP_SESSION_CALLBACK_GENERATION: String(generation),
			OMP_SESSION_CALLBACK_TOKEN: credentialHex,
		};
		if (allowHttp !== undefined) env.OMP_SESSION_CALLBACK_ALLOW_HTTP = allowHttp;
		if (extraEnv !== undefined) {
			for (const [key, value] of Object.entries(extraEnv)) {
				if (env[key] !== undefined) {
					// Reserved: the enrollment keys own these names; never
					// allow a resume hint to shadow the callback pair.
					throw new CloneLifecycleError(
						"invalid_request",
						`refusing to overwrite callback env key ${key}`,
					);
				}
				env[key] = value;
			}
		}
		const payload = JSON.stringify({ version: 1, workspaceId: entry.daemonId, generation, env });
		const path = join(stateDir, "callback-env.json");
		// Mode 0600 exactly: an explicit 0600 fd so umask can never loosen it.
		const fd = openSync(path, "w", 0o600);
		try {
			writeSync(fd, payload);
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * Recover the raw enrollment token from the provider state file so a
	 * re-ensure on the SAME generation keeps the credential the daemon
	 * already holds (restart-safe; only the digest is ever persisted).
	 */
	#persistedCallbackToken(entry: RegistryEntry, generation: number): string {
		const { stateDir } = this.#clonePaths(entry);
		const raw = readFileSync(join(stateDir, "callback-env.json"), "utf8");
		const value = JSON.parse(raw) as {
			version?: unknown;
			generation?: unknown;
			env?: Record<string, unknown>;
		};
		if (
			value?.version !== 1 ||
			value.generation !== generation ||
			typeof value.env?.OMP_SESSION_CALLBACK_TOKEN !== "string" ||
			value.env.OMP_SESSION_CALLBACK_TOKEN.length === 0
		) {
			throw new Error(
				`cannot recover callback token for ${entry.daemonId} generation ${generation} from the persisted state file`,
			);
		}
		return value.env.OMP_SESSION_CALLBACK_TOKEN;
	}

	// ------------------------------------------------------------------
	// Stage + readiness bookkeeping
	// ------------------------------------------------------------------

	/** Write lifecycleStage (+ optional error) and broadcast via onChange. */
	#setStage(daemonId: string, stage: LifecycleStage, error?: string): void {
		const entry = this.#deps.registry.get(daemonId);
		if (!entry) return;
		this.#deps.registry.update(daemonId, {
			lifecycleStage: stage,
			...(error !== undefined ? { lifecycleError: error } : { lifecycleError: undefined }),
		});
	}

	/**
	 * Bounded callback→ready watcher: polls the transport pair status at 1s
	 * intervals and writes lifecycleStage "ready" once the daemon's pair is
	 * observed live. Never blocks callers; stops when the workspace leaves
	 * desired-running.
	 *
	 * A provider that reported `observed: running` can still die before its
	 * callback pair dials (or never dial at all). The watcher therefore
	 * periodically re-inspects the provider: a sandbox that is no longer
	 * running surfaces as status "error" + lifecycleStage "failed" with the
	 * typed message (never an eternal "callback" stage over a dead pid), and
	 * the polling stops. A live-but-slow sandbox keeps polling: the stage
	 * flips to "ready" the moment the pair establishes. There is no silent
	 * timeout that leaves the stage stuck.
	 */
	#armPairWatcher(daemonId: string): void {
		if (this.#pairWatchers.has(daemonId)) return;
		let attempts = 0;
		const tick = async (): Promise<void> => {
			const current = this.#deps.registry.get(daemonId);
			if (!current || current.workspace?.desiredState !== "running") {
				this.#pairWatchers.delete(daemonId);
				return;
			}
			const pair = this.#deps.transport.pairStatus(daemonId);
			if (pair.paired && pair.enrolled) {
				this.#setStage(daemonId, "ready");
				this.#pairWatchers.delete(daemonId);
				return;
			}
			attempts += 1;
			// Every 10th tick (~10s) re-inspect the provider: a sandbox the
			// provider claimed running but that has since died (or whose
			// callback never dials) must not sit at stage "callback" forever.
			if (attempts % 10 === 0) {
				try {
					const inspect = await this.#runCloneOp(daemonId, "inspect", this.#handleOf(current));
					if (inspect.observed !== "running") {
						this.#setStage(
							daemonId,
							"failed",
							`sandbox stopped before the callback pair established (observed ${inspect.observed})`,
						);
						this.#deps.registry.setStatus(
							daemonId,
							"error",
							`sandbox stopped before the callback pair established (observed ${inspect.observed}); stop and start to retry`,
						);
						this.#pairWatchers.delete(daemonId);
						this.#log(
							"warn",
							`clone ${daemonId} callback never established; sandbox ${inspect.observed}`,
							daemonId,
						);
						return;
					}
				} catch {
					// Inspect failed (provider unavailable or a typed
					// conflict/unavailable): keep polling; the pair may
					// still come up; the next inspect retries. A genuinely
					// dead sandbox reports observed != running (not an
					// error), which is handled above.
				}
			}
			this.#pairWatchers.set(
				daemonId,
				setTimeout(() => void tick(), 1_000),
			);
		};
		this.#pairWatchers.set(
			daemonId,
			setTimeout(() => void tick(), 1_000),
		);
	}

	// ------------------------------------------------------------------
	// Internal plumbing
	// ------------------------------------------------------------------

	#require(daemonId: string): RegistryEntry {
		const entry = this.#deps.registry.get(daemonId);
		if (!entry) throw new CloneLifecycleError("invalid_request", `unknown daemon: ${daemonId}`);
		return entry;
	}

	#requireClone(daemonId: string, verb: string): RegistryEntry {
		const entry = this.#require(daemonId);
		if (entry.workspace?.kind !== "clone") {
			throw new CloneLifecycleError(
				"invalid_request",
				`daemon ${daemonId} is not a clone workspace (kind ${entry.workspace?.kind ?? "legacy"}); ${verb} a worktree/direct session through its own path`,
			);
		}
		return entry;
	}

	#log(level: "info" | "warn" | "error", message: string, daemonId?: string): void {
		this.#deps.eventLog.add(level, "server", message, daemonId);
	}

	/** Remove a just-created (never-streamed) entry + its partial volume. */
	#removeEntryAndVolume(daemonId: string, volumeRoot: string): void {
		try {
			rmSync(volumeRoot, { recursive: true, force: true });
		} catch {
			// Best-effort: the volume may be mid-write; the registry removal
			// below is the durable part.
		}
		this.#deps.registry.remove(daemonId);
	}
}
