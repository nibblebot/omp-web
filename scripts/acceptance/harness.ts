/**
 * harness — shared scaffolding for the acceptance walks
 * (scripts/test-bwrap-lifecycle.ts, scripts/test-kubernetes-minikube.ts):
 * diagnostics hygiene, the hermetic environment capture, the single cleanup
 * owner, and the phase-assertion surface. Each walk keeps its own phase
 * vocabulary, waits, and provider assertions.
 */

// ---------------------------------------------------------------------------
// Diagnostics hygiene
// ---------------------------------------------------------------------------

/** Paths/literals replaced with a placeholder before anything is printed. */
const REDACTIONS: { needle: string; label: string }[] = [];

export function redact(value: string, label: string): string {
	if (value !== "") REDACTIONS.push({ needle: value, label });
	return value;
}

export function sanitize(text: string): string {
	let out = text;
	for (const { needle, label } of REDACTIONS) out = out.split(needle).join(`<${label}>`);
	return out;
}

export function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Environment control (captured before any mutation, restored by cleanup)
// ---------------------------------------------------------------------------

const originalEnv = new Map<string, string | undefined>();

export function setEnv(key: string, value: string): void {
	if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
	process.env[key] = value;
}

export function unsetEnv(key: string): void {
	if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
	delete process.env[key];
}

export function restoreEnv(): void {
	for (const [key, value] of originalEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** The current (sandboxed) environment with no `undefined` values. */
export function scriptEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

// ---------------------------------------------------------------------------
// Single cleanup owner
// ---------------------------------------------------------------------------

export type SignalName = "SIGINT" | "SIGTERM" | "SIGHUP";

export const SIGNAL_EXIT: Record<SignalName, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** A phase-tagged, caller-visible failure; the only thing that blocks a run. */
export class BlockedError extends Error {
	constructor(
		readonly phase: string,
		detail: string,
	) {
		super(detail);
	}
}

export interface CleanupStep {
	readonly name: string;
	run(): Promise<void> | void;
}

/**
 * The single cleanup owner. `install()` runs BEFORE any resource exists and
 * wires SIGINT/SIGTERM/SIGHUP; every teardown step is registered here and runs
 * exactly once, in reverse registration order, from both the normal exit path
 * and the signal path. A step that throws is recorded and the drain CONTINUES,
 * so every later (earlier-registered) step still runs and no failed cleanup is
 * reported as success.
 */
export class CleanupOwner {
	#steps: CleanupStep[] = [];
	#handlers = new Map<SignalName, () => void>();
	#drained: Promise<boolean> | null = null;
	#failures: string[] = [];
	#signal: SignalName | null = null;

	add(name: string, run: () => Promise<void> | void): void {
		this.#steps.push({ name, run });
	}

	install(): void {
		if (this.#handlers.size > 0) return;
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			const handler = (): void => {
				this.#signal ??= signal;
				void this.run().then((ok) => process.exit(ok ? SIGNAL_EXIT[signal] : 1));
			};
			this.#handlers.set(signal, handler);
			process.on(signal, handler);
		}
	}

	/**
	 * Hand ownership to another owner (the re-exec child): drop every step and
	 * detach the signal handlers so a late parent signal or exit can never race
	 * the child's own teardown of the same resources.
	 */
	disown(): void {
		for (const [signal, handler] of this.#handlers) process.off(signal, handler);
		this.#handlers.clear();
		this.#steps = [];
		this.#drained = Promise.resolve(true);
	}

	get interrupted(): SignalName | null {
		return this.#signal;
	}

	get failures(): readonly string[] {
		return this.#failures;
	}

	/** Idempotent: the first caller drains; every other caller awaits that run. */
	run(): Promise<boolean> {
		this.#drained ??= this.#drain();
		return this.#drained;
	}

	async #drain(): Promise<boolean> {
		for (const step of [...this.#steps].reverse()) {
			try {
				await step.run();
			} catch (cause) {
				this.#failures.push(`${step.name}: ${sanitize(messageOf(cause))}`);
			}
		}
		return this.#failures.length === 0;
	}
}

// ---------------------------------------------------------------------------
// Acceptance harness
// ---------------------------------------------------------------------------

export class Acceptance<Phase extends string> {
	readonly cleanup = new CleanupOwner();
	#phase: Phase;
	#pending: string[] = [];

	constructor(initialPhase: Phase) {
		this.#phase = initialPhase;
	}

	enter(phase: Phase): void {
		this.#phase = phase;
	}

	get phase(): Phase {
		return this.#phase;
	}

	check(name: string, ok: boolean, detail = ""): void {
		if (ok) {
			console.log(`ok   ${name}`);
			return;
		}
		const line = detail === "" ? name : `${name} — ${detail}`;
		this.#pending.push(line);
		console.error(`FAIL ${sanitize(line)}`);
	}

	/** Record a check and stop the phase immediately when it failed. */
	require(name: string, ok: boolean, detail = ""): void {
		this.check(name, ok, detail);
		if (!ok) throw new BlockedError(this.#phase, detail === "" ? name : `${name}: ${detail}`);
	}

	/** Return `value` when present; block the current phase otherwise. */
	expect<T>(value: T | null | undefined, detail: string): T {
		if (value === null || value === undefined) {
			throw new BlockedError(this.#phase, detail);
		}
		return value;
	}

	/** Throw once per phase when any check in it failed. */
	settle(): void {
		if (this.#pending.length === 0) return;
		throw new BlockedError(this.#phase, this.#pending.splice(0).join("; "));
	}
}
