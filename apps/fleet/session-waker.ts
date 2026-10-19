/**
 * Session wake: the one rule set for bringing a session's callback pair up
 * before an attach or a prompt (FLC-23).
 *
 * Every daemon dials the fleet, so the fleet only ever waits on the pair; it
 * never dials. The rules, shared by the browser edge and fan-out prompts:
 *
 *  - A paired session returns at once.
 *  - A clone goes through the lifecycle ensure (provider compute +
 *    enrollment), which resumes the picked session when one is given. The
 *    wake does not wait for the pair; callers that need it use waitForPair.
 *  - A reconnecting session, or a ready one that lost its pair, is redialing
 *    on its own: it gets redialGraceMs to pair before the fleet decides it
 *    needs a respawn.
 *  - Past the grace (or for an asleep/errored row) the session is respawned
 *    (`--resume`), unless it is already `connecting`, then waited on for
 *    pairTimeoutMs.
 *
 * Two implementations used to follow different rules (the edge respawned a
 * stuck reconnecting/ready row after the grace; fan-out only waited on it and
 * timed out forever). The edge's stricter rules were chosen: never replace a
 * process that may still redial, and never return before an in-flight wake
 * settles. Wakes are serialized per daemon: a concurrent wake awaits the SAME
 * promise (shared outcome, failure included), so a daemon is never respawned
 * twice and no caller proceeds before the pair is up. The entry is dropped
 * when the wake settles; a back-to-back wake after success is covered by the
 * `paired` check, and after failure it retries from scratch.
 */

import { REDIAL_GRACE_MS, type Registry, type RegistryEntry } from "./registry";
import { PAIR_TIMEOUT_MS, type SpawnSupervisor } from "./supervisor";

/** The slice of the callback transport the waker reads (structural; the real DaemonTransportRegistry conforms). */
export interface WakeTransport {
	pairStatus(daemonId: string): { paired: boolean };
	onPairChange(daemonId: string, cb: (status: { paired: boolean }) => void): () => void;
}

/** Clone lifecycle slice the waker drives. */
export interface WakeLifecycle {
	/** Resolves at provider-running + enrollment persisted. */
	ensureCloneRunning(daemonId: string, opts?: { resumeSessionId?: string }): Promise<void>;
}

export interface SessionWakerDeps {
	registry: Registry;
	supervisor: Pick<SpawnSupervisor, "respawn">;
	/** Callback transport; without it non-clone and clone wakes answer typed unavailability. */
	transport?: WakeTransport;
	/** Clone lifecycle service; without it clone wakes answer typed unavailability. */
	lifecycle?: WakeLifecycle;
	/** How long a reconnecting/ready unpaired session may redial before it is respawned (default REDIAL_GRACE_MS). */
	redialGraceMs?: number;
	/** Pair wait after a respawn (default PAIR_TIMEOUT_MS). */
	pairTimeoutMs?: number;
}

export class SessionWaker {
	readonly #registry: Registry;
	readonly #supervisor: Pick<SpawnSupervisor, "respawn">;
	readonly #transport: WakeTransport | undefined;
	readonly #lifecycle: WakeLifecycle | undefined;
	readonly #redialGraceMs: number;
	readonly #pairTimeoutMs: number;
	/** In-flight wake per daemonId; concurrent wakes share its outcome. */
	readonly #inflight = new Map<string, Promise<void>>();

	constructor(deps: SessionWakerDeps) {
		this.#registry = deps.registry;
		this.#supervisor = deps.supervisor;
		this.#transport = deps.transport;
		this.#lifecycle = deps.lifecycle;
		this.#redialGraceMs = deps.redialGraceMs ?? REDIAL_GRACE_MS;
		this.#pairTimeoutMs = deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS;
	}

	/**
	 * Bring the session's pair up per the class rules. Resolves once a
	 * non-clone session is paired (a clone once its lifecycle ensure
	 * resolved); throws the reason it cannot be. A wake already in flight for
	 * the daemon is awaited instead of starting another, so a later call's
	 * resumeFile is ignored.
	 */
	wake(entry: RegistryEntry, opts?: { resumeFile?: string }): Promise<void> {
		const daemonId = entry.daemonId;
		const existing = this.#inflight.get(daemonId);
		if (existing !== undefined) return existing;
		const resumeFile = opts?.resumeFile;
		const run =
			entry.workspace?.kind === "clone"
				? this.#wakeClone(entry, resumeFile)
				: this.#wakeSession(entry, resumeFile);
		const tracked: Promise<void> = run.finally(() => {
			if (this.#inflight.get(daemonId) === tracked) this.#inflight.delete(daemonId);
		});
		this.#inflight.set(daemonId, tracked);
		return tracked;
	}

	/** Resolve once the session's pair is up; reject when it is not up within timeoutMs (default pairTimeoutMs). */
	async waitForPair(daemonId: string, timeoutMs: number = this.#pairTimeoutMs): Promise<void> {
		if (!(await this.#awaitPair(daemonId, timeoutMs))) {
			throw new Error(`callback pair for ${daemonId} not ready within ${timeoutMs} ms`);
		}
	}

	async #wakeClone(entry: RegistryEntry, resumeFile: string | undefined): Promise<void> {
		const daemonId = entry.daemonId;
		if (this.#transport?.pairStatus(daemonId).paired === true) return;
		if (this.#lifecycle === undefined || this.#transport === undefined) {
			throw new Error("clone wake is unavailable: no lifecycle/transport wired");
		}
		await this.#lifecycle.ensureCloneRunning(
			daemonId,
			resumeFile && resumeFile.trim() !== "" ? { resumeSessionId: resumeFile } : undefined,
		);
	}

	async #wakeSession(entry: RegistryEntry, resumeFile: string | undefined): Promise<void> {
		const daemonId = entry.daemonId;
		const transport = this.#transport;
		if (transport === undefined) {
			throw new Error("session wake is unavailable: no transport wired");
		}
		if (transport.pairStatus(daemonId).paired) return;
		// A reconnecting session, or a ready one that just lost its pair, is
		// redialing on its own: give it the grace window before deciding it
		// needs a respawn.
		const initial = this.#registry.get(daemonId)?.status ?? entry.status;
		const redialing = initial === "reconnecting" || initial === "ready";
		if (redialing && (await this.#awaitPair(daemonId, this.#redialGraceMs))) {
			return;
		}
		// The status may have changed during the wait; respect the live value.
		const status = this.#registry.get(daemonId)?.status ?? entry.status;
		if (status !== "connecting") {
			const opts = resumeFile && resumeFile.trim() !== "" ? { resumeFile } : undefined;
			await this.#supervisor.respawn(entry, opts);
		}
		if (!(await this.#awaitPair(daemonId, this.#pairTimeoutMs))) {
			throw new Error(
				`session ${entry.name} did not connect within ${this.#pairTimeoutMs / 1000}s`,
			);
		}
	}

	/**
	 * Resolve true once the session's pair is up, false after timeoutMs. The
	 * pair subscription is released on either outcome.
	 */
	#awaitPair(daemonId: string, timeoutMs: number): Promise<boolean> {
		const transport = this.#transport;
		if (transport === undefined) return Promise.resolve(false);
		if (transport.pairStatus(daemonId).paired) return Promise.resolve(true);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let unsubscribe: () => void = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			resolve(false);
		}, timeoutMs);
		unsubscribe = transport.onPairChange(daemonId, (status) => {
			if (!status.paired) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(true);
		});
		return promise;
	}
}
