/**
 * Kubernetes provider wait policy (P5.4): the single source both of the wait
 * budgets the provider enforces and of the fleet-side invocation budget it is
 * given. Both sides read the same env knobs through one parser, so the
 * provider can never be killed before its own deadline.
 *
 * The provider's own waits are the workspace lock (every operation), Pod
 * readiness (`ensure-running`), Pod absence for replacement
 * (`ensure-running`), Pod absence for `stop`, and per-object absence for
 * `delete` (Pod, then PVC, then the workspace-scoped baseline ConfigMap).
 * Each operation's child budget sums the waits it may consume plus fixed
 * headroom for the API calls and polling around them; the caller's outer
 * timeout adds the termination grace, so a provider that overruns its own
 * budget is still killed and reaped within the invocation that started it.
 */

import { ProviderProtocolError } from "../../../shared/provider-protocol";
import type { ProviderOp } from "../../../shared/provider-protocol";

export interface KubernetesWaits {
	/** Pod-readiness budget for `ensure-running`. */
	ensureWaitMs: number;
	/** Pod-absence budget for `ensure-running` (replacement) and `stop`. */
	stopWaitMs: number;
	/** Per-object absence budget for `delete` (Pod, PVC, baseline ConfigMap). */
	deleteWaitMs: number;
	/** Budget every operation spends waiting for a peer to release the workspace lock. */
	lockWaitMs: number;
}

/** Bounded child operation budget plus the outer invoker timeout covering it. */
export interface ProviderOpTimeout {
	/** Operation budget the provider itself runs under. */
	childTimeoutMs: number;
	/** `runProviderOp` wall-clock timeout: `childTimeoutMs` plus the termination grace. */
	invocationTimeoutMs: number;
}

/** Largest accepted wait override (ms): five minutes. */
export const KUBERNETES_WAIT_MS_MAX = 300_000;

/**
 * Fixed headroom (ms) added on top of the waits one operation can consume,
 * covering the Kubernetes API calls, polling, and bookkeeping that are not
 * themselves waits.
 */
export const KUBERNETES_OP_HEADROOM_MS = 240_000;

/**
 * Extra outer budget (ms) handed to `runProviderOp` on top of the child's own
 * operation budget, so process termination (SIGTERM, then the SIGKILL
 * escalation grace period) finishes inside the invocation that started the
 * child instead of racing it.
 */
export const KUBERNETES_OP_TERMINATION_MS = 5_000;

/** Wait-budget defaults (ms), matching the provider's env-tunable knobs. */
const ENSURE_WAIT_MS_DEFAULT = 120_000;
const STOP_WAIT_MS_DEFAULT = 60_000;
const DELETE_WAIT_MS_DEFAULT = 60_000;
const LOCK_WAIT_MS_DEFAULT = 30_000;

/**
 * One wait override: the default applies only when the key is absent. A
 * present value must be an exact integer literal in [1, KUBERNETES_WAIT_MS_MAX];
 * anything else (non-numeric, zero, negative, fractional, over-range) is a
 * misconfiguration and throws `invalid_request` — a typo must never be
 * silently swapped for a different budget. Provider and fleet share this
 * parser, so they always agree on the budget.
 */
function waitMsFromEnv(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name];
	if (raw === undefined) return fallback;
	if (!/^[0-9]+$/.test(raw)) {
		throw ProviderProtocolError.invalidRequest(
			`${name} must be an integer number of milliseconds, got ${JSON.stringify(raw)}`,
		);
	}
	const parsed = Number(raw);
	if (parsed < 1 || parsed > KUBERNETES_WAIT_MS_MAX) {
		throw ProviderProtocolError.invalidRequest(
			`${name} must be between 1 and ${KUBERNETES_WAIT_MS_MAX} milliseconds, got ${raw}`,
		);
	}
	return parsed;
}

/** Read the Kubernetes wait overrides from `env` (defaults to `process.env`). */
export function readKubernetesWaits(
	env: Record<string, string | undefined> = process.env,
): KubernetesWaits {
	return {
		ensureWaitMs: waitMsFromEnv(env, "OMP_KUBE_ENSURE_WAIT_MS", ENSURE_WAIT_MS_DEFAULT),
		stopWaitMs: waitMsFromEnv(env, "OMP_KUBE_STOP_WAIT_MS", STOP_WAIT_MS_DEFAULT),
		deleteWaitMs: waitMsFromEnv(env, "OMP_KUBE_DELETE_WAIT_MS", DELETE_WAIT_MS_DEFAULT),
		lockWaitMs: waitMsFromEnv(env, "OMP_KUBE_LOCK_WAIT_MS", LOCK_WAIT_MS_DEFAULT),
	};
}

/**
 * Bounded operation timeouts for one set of wait overrides (P5.4). Every
 * operation first contends for the workspace lock, so `lockWaitMs` is part of
 * each sum:
 *
 * - `inspect`: lock + headroom (it waits on no object);
 * - `ensure-running`: lock + ensure wait + Pod-replacement stop wait +
 *   ConfigMap-replacement delete wait + headroom;
 * - `stop`: lock + stop wait + headroom;
 * - `delete`: lock + three delete waits (Pod, then PVC, then ConfigMap) +
 *   headroom.
 */
export function kubernetesOpTimeouts(
	waits: KubernetesWaits,
): Record<ProviderOp, ProviderOpTimeout> {
	const op = (childTimeoutMs: number): ProviderOpTimeout => ({
		childTimeoutMs,
		invocationTimeoutMs: childTimeoutMs + KUBERNETES_OP_TERMINATION_MS,
	});
	return {
		inspect: op(waits.lockWaitMs + KUBERNETES_OP_HEADROOM_MS),
		"ensure-running": op(
			waits.lockWaitMs +
				waits.ensureWaitMs +
				waits.stopWaitMs +
				waits.deleteWaitMs +
				KUBERNETES_OP_HEADROOM_MS,
		),
		stop: op(waits.lockWaitMs + waits.stopWaitMs + KUBERNETES_OP_HEADROOM_MS),
		delete: op(waits.lockWaitMs + 3 * waits.deleteWaitMs + KUBERNETES_OP_HEADROOM_MS),
	};
}
