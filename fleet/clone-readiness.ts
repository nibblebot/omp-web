/**
 * Clone callback readiness (stage 2 item 7).
 *
 * The fleet-side authority that promotes a clone to `ready` only after the
 * daemon's OWN `hello_ok` (with the expected runtime cwd, and — when the
 * launch handoff required a boot session — that same session) and `ready`
 * frames arrive on a fresh internal control stream. An authenticated pair
 * alone is NOT readiness: kubernetes ensure-running commonly waits on the Pod
 * while the daemon dials, and a pair-only promotion both exposes a false
 * `ready` and can erase a real cwd/session mismatch.
 *
 * A pair observed before the launch is authorized waits for the lifecycle
 * owner's `onRuntimeRunning` hook, which re-probes the instant authorization
 * persists (the provider op may outlast any fixed budget).
 */

import { basename, join } from "node:path";
import { WAKE_MATERIALIZE_TIMEOUT_MS } from "../shared/wake-materialize";
import { readCallbackEnvFile } from "../runtime/callback-env";
import type { DaemonTransportRegistry } from "./daemon-transport";
import type { FleetEventLog } from "./events";
import type { Registry, RegistryEntry } from "./registry";

/**
 * Readiness allowance: the daemon may spend up to WAKE_MATERIALIZE_TIMEOUT_MS
 * restoring the required session BEFORE it can prime, and then gets the same
 * 60s prime allowance the pair gate uses. A shorter probe would declare a
 * valid 61-120s restore conclusively failed while it is still restoring.
 */
export const CLONE_READINESS_TIMEOUT_MS = WAKE_MATERIALIZE_TIMEOUT_MS + 60_000;

export type CloneReadinessTransport = Pick<
	DaemonTransportRegistry,
	"onPairChange" | "pairStatus" | "attachVirtualStream" | "detachVirtualStream" | "sendToDaemon"
>;

export interface CloneReadinessDeps {
	registry: Registry;
	transport: CloneReadinessTransport;
	eventLog: Pick<FleetEventLog, "add">;
	/** Managed workspace root (the callback-env handoff lives beneath it). */
	workspaceDir: string;
}

type ProbeOutcome =
	| { ok: true; detail: string }
	| { ok: false; conclusive: boolean; message: string };

/** A clone can be probed through the internal stream after every pair change. */
export class CloneReadiness {
	readonly #deps: CloneReadinessDeps;
	/** Per-workspace pair-change listener unsubscribe. */
	readonly #listeners = new Map<string, () => void>();
	/** Per-workspace active probe cancel (settles the probe's promise). */
	readonly #inflight = new Map<string, () => void>();
	/** Launch-time boot-session expectation per workspace. */
	readonly #bootExpectations = new Map<string, { generation: number; sessionId: string }>();
	/** Monotonic suffix: a NEW browser stream re-primes; a reused one replays. */
	#seq = 0;
	#closed = false;

	constructor(deps: CloneReadinessDeps) {
		this.#deps = deps;
	}

	/**
	 * Register the internal readiness listener for a clone workspace: every
	 * authenticated pair (re)establishment — including a surviving Pod
	 * reconnecting after a fleet restart — runs the probe. Idempotent per
	 * workspace; a pair already live at registration is probed immediately.
	 */
	watch(workspaceId: string): void {
		if (this.#closed || this.#listeners.has(workspaceId)) return;
		const entry = this.#deps.registry.get(workspaceId);
		if (entry?.workspace?.kind !== "clone") return;
		const unsubscribe = this.#deps.transport.onPairChange(workspaceId, (status) => {
			if (status.paired && status.enrolled) void this.#check(workspaceId);
		});
		this.#listeners.set(workspaceId, unsubscribe);
		const status = this.#deps.transport.pairStatus(workspaceId);
		if (status.paired && status.enrolled) void this.#check(workspaceId);
	}

	/**
	 * Capture the launch-time session expectation from the callback handoff
	 * the lifecycle just wrote (called on every launch attempt, before the
	 * provider call). Only an in-flight attempt — one ahead of the last
	 * authorized generation — carries a fresh resume hint: a reattach, and a
	 * boot re-enrollment of an already-running daemon, rewrite the handoff
	 * without one. The expectation is dropped once a probe validates it, so it
	 * is never re-applied after the daemon legitimately switches sessions.
	 */
	recordLaunchSessionExpectation(workspaceId: string): void {
		const entry = this.#deps.registry.get(workspaceId);
		const record = entry?.workspace;
		if (entry === undefined || record?.kind !== "clone") return;
		const attempted = record.lastAttemptedGeneration;
		if (attempted === undefined) return;
		const authorized = record.authorizedGeneration;
		if (authorized !== undefined && authorized >= attempted) return;
		let resume: unknown;
		try {
			resume = readCallbackEnvFile(cloneStateDir(this.#deps.workspaceDir, entry), {
				workspaceId,
				generation: attempted,
			})?.env?.OMP_SESSION_RESUME;
		} catch {
			// Unreadable/absent handoff: no launch expectation to record.
			this.#bootExpectations.delete(workspaceId);
			return;
		}
		if (typeof resume !== "string" || resume === "") {
			this.#bootExpectations.delete(workspaceId);
			return;
		}
		this.#bootExpectations.set(workspaceId, {
			generation: attempted,
			sessionId: sessionIdOf(resume),
		});
	}

	/**
	 * The launch authorization persisted (or a runtime was reattached): probe
	 * now. This is the hook that makes a delayed provider response (a
	 * kubernetes ensure-running that outlives the pair) still validate cwd and
	 * the boot session instead of silently skipping readiness.
	 */
	onRuntimeRunning(workspaceId: string): void {
		if (this.#closed) return;
		const pair = this.#deps.transport.pairStatus(workspaceId);
		// No live pair: nothing to probe yet — the pair's own change event
		// runs the probe the moment the daemon dials.
		if (!pair.paired || !pair.enrolled) return;
		void this.#check(workspaceId);
	}

	/**
	 * A stop/delete ended the running workspace: no probe or listener may
	 * outlive it (a stale probe could otherwise mark a stopped clone ready,
	 * and its timers would be orphaned).
	 */
	onRuntimeStopped(workspaceId: string): void {
		const cancel = this.#inflight.get(workspaceId);
		if (cancel !== undefined) cancel();
		const unsubscribe = this.#listeners.get(workspaceId);
		if (unsubscribe !== undefined) {
			this.#listeners.delete(workspaceId);
			unsubscribe();
		}
		this.#bootExpectations.delete(workspaceId);
	}

	/** Cancel every probe/listener (server close()). */
	close(): void {
		this.#closed = true;
		for (const cancel of [...this.#inflight.values()]) cancel();
		this.#inflight.clear();
		for (const unsubscribe of this.#listeners.values()) unsubscribe();
		this.#listeners.clear();
		this.#bootExpectations.clear();
	}

	/** One bounded readiness check; never throws. */
	async #check(workspaceId: string): Promise<void> {
		if (this.#closed || this.#inflight.has(workspaceId)) return;
		const entry = this.#deps.registry.get(workspaceId);
		if (entry?.workspace?.kind !== "clone") return;
		// A stopped workspace has no launch to validate, and a pair that dialed
		// before its launch was authorized waits for onRuntimeRunning (the
		// provider op may outlast any fixed budget): neither starts a probe.
		if (
			entry.workspace.desiredState !== "running" ||
			entry.workspace.authorizedGeneration === undefined
		) {
			return;
		}
		const generation = entry.workspace.authorizedGeneration;
		const streamId = `browser/readiness-${++this.#seq}`;
		const probe = this.#startProbe(entry, streamId);
		this.#inflight.set(workspaceId, probe.cancel);
		let outcome: ProbeOutcome;
		try {
			outcome = await probe.result;
		} finally {
			this.#inflight.delete(workspaceId);
		}
		if (this.#closed) return; // shutdown: never write roster state
		if (outcome.ok) {
			// Re-read: a launch that superseded this probe must not be labeled
			// ready by its predecessor's frames.
			const current = this.#deps.registry.get(workspaceId);
			if (current?.workspace?.kind !== "clone") return;
			if (current.workspace.desiredState !== "running") return;
			if (current.workspace.authorizedGeneration !== generation) {
				// A newer launch owns readiness now; probe it.
				void this.#check(workspaceId);
				return;
			}
			const expectation = this.#bootExpectations.get(workspaceId);
			if (expectation?.generation === generation) this.#bootExpectations.delete(workspaceId);
			// The readiness owner is the SOLE writer of `ready`: the pair
			// watcher only demotes, so a validated hello_ok+ready here can no
			// longer be overwritten by a pair-only tick.
			this.#deps.registry.update(workspaceId, {
				lifecycleStage: "ready",
				lifecycleError: undefined,
			});
			this.#deps.registry.setStatus(workspaceId, "ready");
			this.#deps.eventLog.add(
				"info",
				"server",
				`clone ${workspaceId} readiness confirmed (${outcome.detail})`,
				workspaceId,
			);
			return;
		}
		if (!outcome.conclusive) {
			// A stop/delete or close() cancelled the probe: no observation to
			// report (the cancellation, not the pair, ended it).
			const still = this.#deps.registry.get(workspaceId);
			if (
				this.#closed ||
				still?.workspace?.kind !== "clone" ||
				still.workspace.desiredState !== "running"
			) {
				return;
			}
			this.#deps.eventLog.add(
				"info",
				"server",
				`clone ${workspaceId} readiness inconclusive: ${outcome.message}`,
				workspaceId,
			);
			return;
		}
		this.#deps.registry.update(workspaceId, {
			lifecycleStage: "failed",
			lifecycleError: outcome.message,
		});
		this.#deps.registry.setStatus(workspaceId, "error", outcome.message);
		this.#deps.eventLog.add(
			"warn",
			"server",
			`clone ${workspaceId} readiness failed: ${outcome.message}`,
			workspaceId,
		);
	}

	/**
	 * One bounded probe: attach a fresh internal virtual stream (its SINK is
	 * the only consumer — a no-op sink plus a raw tap would double-consume),
	 * ask the daemon to open it (the daemon primes hello_ok/…/ready on a NEW
	 * browser stream), and await the hello_ok + ready pair. All timers,
	 * listeners, and the stream are released on every path, and the daemon is
	 * told to close the stream so it is not re-primed forever.
	 */
	#startProbe(
		entry: RegistryEntry,
		streamId: string,
	): { result: Promise<ProbeOutcome>; cancel: () => void } {
		const workspaceId = entry.daemonId;
		const fresh = this.#deps.registry.get(workspaceId) ?? entry;
		const expectedCwd = expectedRuntimeCwd(fresh);
		const requestedSession = this.#requestedSessionId(fresh);
		let settled = false;
		let settle!: (outcome: ProbeOutcome) => void;
		const result = new Promise<ProbeOutcome>((resolve) => {
			settle = (outcome) => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};
		});
		let sawHello = false;
		let sawReady = false;
		let observedCwd = "";
		let observedSession = "";
		this.#deps.transport.attachVirtualStream(workspaceId, streamId, {
			deliver: (envelope) => {
				if (settled) return; // late frame after settle is ignored
				if (envelope.kind !== "frame") return;
				const payload = envelope.payload;
				if (typeof payload !== "object" || payload === null) return;
				const fields = payload as Record<string, unknown>;
				const type = typeof fields.type === "string" ? fields.type : "";
				if (type === "hello_ok") {
					sawHello = true;
					observedCwd = typeof fields.cwd === "string" ? fields.cwd : "";
					observedSession = typeof fields.sessionFile === "string" ? fields.sessionFile : "";
					if (expectedCwd !== null && observedCwd !== "" && observedCwd !== expectedCwd) {
						settle({
							ok: false,
							conclusive: true,
							message: `daemon cwd ${observedCwd} does not match the expected ${expectedCwd}`,
						});
						return;
					}
					if (requestedSession !== null) {
						if (observedSession === "" || sessionIdOf(observedSession) !== requestedSession) {
							settle({
								ok: false,
								conclusive: true,
								message: `daemon session ${observedSession === "" ? "(none)" : observedSession} does not identify the requested session ${requestedSession}`,
							});
							return;
						}
					}
				} else if (type === "ready") {
					sawReady = true;
				}
				if (sawHello && sawReady) {
					settle({
						ok: true,
						detail: `cwd ${observedCwd === "" ? "(unchecked)" : observedCwd}, session ${observedSession === "" ? "(none requested)" : observedSession}`,
					});
				}
			},
		});
		// A pair that drops after the stream-open send can never answer the
		// probe. Settle INCONCLUSIVE from the pair event itself (rather than a
		// conclusive timeout), so the reconnect's own pair change runs a fresh
		// probe instead of downgrading the clone for a transport hiccup.
		const unsubscribePair = this.#deps.transport.onPairChange(workspaceId, (status) => {
			if (status.paired && status.enrolled) return;
			settle({
				ok: false,
				conclusive: false,
				message: "pair dropped during the readiness probe",
			});
		});
		const timer = setTimeout(() => {
			// Belt and braces: a pair already down at the deadline is
			// inconclusive even if its change event was missed.
			const pair = this.#deps.transport.pairStatus(workspaceId);
			if (!pair.paired || !pair.enrolled) {
				settle({
					ok: false,
					conclusive: false,
					message: "pair unavailable at the readiness probe timeout",
				});
				return;
			}
			settle({
				ok: false,
				conclusive: true,
				message: `readiness probe timed out after ${CLONE_READINESS_TIMEOUT_MS}ms (hello_ok=${sawHello}, ready=${sawReady})`,
			});
		}, CLONE_READINESS_TIMEOUT_MS);
		timer.unref();
		void this.#deps.transport
			.sendToDaemon(workspaceId, {
				streamId,
				kind: "control",
				payload: { type: "stream_open" },
			})
			.catch((err: unknown) => {
				// The pair teardown raced the probe: nothing to conclude.
				settle({
					ok: false,
					conclusive: false,
					message: `pair unavailable during the readiness probe: ${err instanceof Error ? err.message : String(err)}`,
				});
			});
		void result.then(async () => {
			clearTimeout(timer);
			unsubscribePair();
			// The daemon's ONLY path for dropping a browser stream is
			// stream_close. Best-effort (the pair may be gone) and sent BEFORE
			// the local detach, else every probe leaves a stream that is
			// re-primed on each pair renewal.
			try {
				await this.#deps.transport.sendToDaemon(workspaceId, {
					streamId,
					kind: "control",
					payload: { type: "stream_close" },
				});
			} catch {
				// Pair gone: nothing to close daemon-side.
			}
			this.#deps.transport.detachVirtualStream(workspaceId, streamId);
		});
		return {
			result,
			cancel: () => settle({ ok: false, conclusive: false, message: "readiness probe cancelled" }),
		};
	}

	/**
	 * The session the fleet's launch handoff required the daemon to BOOT into,
	 * or null when the current generation carries no pending expectation. Null
	 * skips the comparison: a hint that described a past boot must never fail
	 * a daemon that has since switched sessions.
	 */
	#requestedSessionId(entry: RegistryEntry): string | null {
		const expectation = this.#bootExpectations.get(entry.daemonId);
		if (expectation === undefined) return null;
		if (entry.workspace?.authorizedGeneration !== expectation.generation) return null;
		return expectation.sessionId;
	}
}

/**
 * Runtime cwd the daemon must report in hello_ok, derived from the persisted
 * provider kind (no stored field exists):
 *   - kubernetes: the Pod's in-pod checkout, fixed by the image entrypoint
 *     (`OMP_WORKSPACE_DIR` = /workspace/.checkout);
 *   - bwrap/legacy: the fleet volume's checkout,
 *     <workspaceDir>/<daemonId>/.checkout.
 * Null when the fleet path is unknown (empty cwd): inconclusive, skipped.
 */
function expectedRuntimeCwd(entry: RegistryEntry): string | null {
	if (entry.workspace?.providerKind === "kubernetes" || entry.workspace?.kubernetes) {
		return "/workspace/.checkout";
	}
	const cwd = entry.cwd ?? "";
	if (cwd === "") return null;
	return join(cwd, ".checkout");
}

/** Session identity from a main-session path: the `.jsonl` stem (the
 *  slash-free lineage key). The fleet and the Pod see the same session under
 *  different absolute paths, so readiness compares identities, never paths. */
function sessionIdOf(sessionPath: string): string {
	const base = basename(sessionPath);
	return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/** Fleet-side provider state dir for a clone workspace, mirroring the
 *  lifecycle layout: kubernetes by resource identity, bwrap by daemon id. */
function cloneStateDir(workspaceDir: string, entry: RegistryEntry): string {
	const identity = entry.workspace?.kubernetes?.resourceIdentity;
	if (typeof identity === "string" && identity !== "") {
		return join(workspaceDir, ".kubernetes", identity);
	}
	return join(workspaceDir, ".provider-state", entry.daemonId);
}
