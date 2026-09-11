import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "./session-entry";
import type { QuiesceWriterEntry } from "../shared/callback-protocol";
import type { CallbackErrorCode } from "../shared/callback-protocol";

/**
 * All-writer flush capture (P4.5). The SDK's dispose/release swallow
 * descendant and advisor-recorder close failures (allSettled / try-catch in
 * the pinned 17.1.8 sources), so dispose resolution alone is NOT flush
 * evidence: before ANY dispose this captures and flushes every reachable live
 * writer, failing closed on a live writer or any rejected flush. Writers the
 * SDK already released (null sessions) are recorded parked/disposed and
 * covered by the structural JSONL read verification afterwards.
 */

/** A registry-visible agent ref with its live session (if any). */
export interface WriterRef {
	id: string;
	kind: "main" | "sub" | "advisor";
	sessionFile: string | null;
	session: AgentSession | null;
	status: string;
}

/** Outcome of the explicit all-writer flush at quiesce (P4.5). */
export interface WriterFlushResult {
	ok: boolean;
	descendants: QuiesceWriterEntry[];
	advisors: "caught_up" | "inactive";
	error?: string;
	/** Documented SDK ceiling note (descendant dispose errors are swallowed). */
	note?: string;
}

/**
 * Per-writer flush state: the public entry of
 * {@link flushReachableWriters} and the internal per-writer attempt shape
 * both reports are built from.
 */
export interface ReachableWriterState {
	id: string;
	kind: "main" | "sub" | "advisor";
	sessionFile: string | null;
	state: "flushed" | "parked" | "disposed" | "failed";
	/** Present when the writer's explicit flush rejected (state "failed"). */
	error?: string;
}

/**
 * Full per-writer flush report for the Kubernetes quiesce branch, which must
 * persist one evidence entry per reachable writer (main first) rather than a
 * bare descendant list. `ok` stays fail-closed: false when the main writer is
 * busy or any reachable writer's flush rejected.
 */
export interface ReachableWriterFlushReport {
	ok: boolean;
	/** One entry per reachable writer, main first, in registry capture order. */
	writers: ReachableWriterState[];
	advisors: "caught_up" | "inactive";
	error?: string;
	note?: string;
}

/** Registry id of the boot (main) writer; every other ref is a descendant. */
const MAIN_WRITER_ID = "s1";

/** Operator-facing notes; identical across both flush reports (P4.5). */
const MAIN_FLUSH_BLOCKED =
	"main flush rejected or persistence indeterminate — deletion blocked (P4.5)";
const DESCENDANT_FLUSH_BLOCKED =
	"descendant flush rejected or persistence indeterminate — deletion blocked (P4.5)";
const ADVISOR_FLUSH_BLOCKED = "advisor recorder catch-up unresolved — deletion blocked";
const DISPOSE_CEILING_NOTE =
	"SDK 17.1.8 ceiling: dispose suppresses descendant/advisor errors; flush here is the explicit evidence, and structural read verification of every declared JSONL runs after dispose.";

/** Capture the writer surface of one session entry. */
export function captureWriters(
	entry: SessionEntry,
	registry: AgentRegistry,
	mainSessionFile: string | null,
): { main: AgentSession; descendants: WriterRef[] } {
	const refs = registry.list();
	const descendants: WriterRef[] = refs
		.filter((ref) => ref.id !== MAIN_WRITER_ID && (ref.kind === "sub" || ref.kind === "advisor"))
		.map((ref) => ({
			id: ref.id,
			kind: ref.kind,
			sessionFile: ref.sessionFile,
			session: ref.session,
			status: ref.status,
		}));
	return { main: entry.session, descendants };
}

/** Internal statement of one full writer-surface flush. */
interface WriterFlushSurface {
	ok: boolean;
	main: ReachableWriterState;
	descendants: ReachableWriterState[];
	advisors: "caught_up" | "inactive";
	error?: string;
	note?: string;
}

/**
 * Fail-closed writer precondition + explicit flush of every reachable
 * SessionManager. Returns WriterFlushResult with per-descendant states.
 * Any live writer (main streaming/queued, a sub/advisor ref running, or a
 * flush rejection) fails closed with `writer_active` / `unavailable` —
 * deletion is refused, never inferred from dispose resolution.
 */
export async function flushAllWriters(input: {
	entry: SessionEntry;
	registry: AgentRegistry;
	mainSessionFile: string | null;
}): Promise<WriterFlushResult> {
	const surface = await flushWriterSurface(input, false);
	return {
		ok: surface.ok,
		descendants: surface.descendants
			.filter((attempt) => attempt.state !== "failed")
			.map((attempt) => ({
				id: attempt.id,
				kind: attempt.kind,
				sessionFile: attempt.sessionFile,
				state: attempt.state as QuiesceWriterEntry["state"],
			})),
		advisors: surface.advisors,
		...(surface.error !== undefined ? { error: surface.error } : {}),
		...(surface.note !== undefined ? { note: surface.note } : {}),
	};
}

/**
 * Flush every reachable writer and report one entry per writer, including the
 * main writer and any writer whose flush rejected. Fail-closed exactly as
 * {@link flushAllWriters} (`ok:false` on a live writer or any flush
 * rejection), but every descendant is attempted so a failure is reported per
 * writer instead of short-circuiting. This is the report the Kubernetes
 * quiesce_clone evidence is built from.
 */
export async function flushReachableWriters(input: {
	entry: SessionEntry;
	registry: AgentRegistry;
	mainSessionFile: string | null;
}): Promise<ReachableWriterFlushReport> {
	const surface = await flushWriterSurface(input, true);
	return {
		ok: surface.ok,
		writers: [surface.main, ...surface.descendants].map((attempt) => ({
			id: attempt.id,
			kind: attempt.kind,
			sessionFile: attempt.sessionFile,
			state: attempt.state,
			...(attempt.error !== undefined ? { error: attempt.error } : {}),
		})),
		advisors: surface.advisors,
		...(surface.error !== undefined ? { error: surface.error } : {}),
		...(surface.note !== undefined ? { note: surface.note } : {}),
	};
}

/**
 * Shared core for both public flush functions. `continueOnWriterError` is
 * false for {@link flushAllWriters} (stop at the first descendant rejection,
 * exactly as before) and true for {@link flushReachableWriters} (attempt
 * every descendant and report each). Precondition guards and the advisor
 * catch-up barrier are identical in both modes.
 */
async function flushWriterSurface(
	input: { entry: SessionEntry; registry: AgentRegistry; mainSessionFile: string | null },
	continueOnWriterError: boolean,
): Promise<WriterFlushSurface> {
	const { entry, registry, mainSessionFile } = input;
	const { main, descendants } = captureWriters(entry, registry, mainSessionFile);
	const mainAttempt: ReachableWriterState = {
		id: MAIN_WRITER_ID,
		kind: "main",
		sessionFile: mainSessionFile,
		state: "flushed",
	};
	const failBeforeFlush = (error: string): WriterFlushSurface => ({
		ok: false,
		main: { ...mainAttempt, state: "failed" },
		descendants: [],
		advisors: "inactive",
		error,
	});

	// Precondition gate: no live writer may remain (P7.3 "refuse active
	// work"). The main session's own busy state is the primary signal.
	if (main.isStreaming || main.queuedMessageCount > 0) {
		return failBeforeFlush("main session is streaming or has queued messages");
	}
	for (const ref of descendants) {
		if (ref.status === "running" || ref.status === "idle") {
			return failBeforeFlush(
				`descendant writer ${ref.id} (${ref.kind}) is still live (${ref.status})`,
			);
		}
	}

	// Explicit flush of every reachable SessionManager BEFORE dispose. The
	// main flush resolves-without-throw only when no persistence failure is
	// latched; a rejection (incl. SessionPersistenceIndeterminateError) is a
	// hard block.
	const flushMain = await flushSession(main);
	if (!flushMain.ok) {
		return {
			ok: false,
			main: { ...mainAttempt, state: "failed", error: flushMain.error },
			descendants: [],
			advisors: "inactive",
			error: `main session flush failed: ${flushMain.error}`,
			note: MAIN_FLUSH_BLOCKED,
		};
	}

	const attempts: ReachableWriterState[] = [];
	let firstFailure: string | undefined;
	for (const ref of descendants) {
		if (ref.session !== null) {
			const flushed = await flushSession(ref.session);
			if (!flushed.ok) {
				if (!continueOnWriterError) {
					return {
						ok: false,
						main: mainAttempt,
						descendants: attempts,
						advisors: "inactive",
						error: `descendant ${ref.id} flush failed: ${flushed.error}`,
						note: DESCENDANT_FLUSH_BLOCKED,
					};
				}
				attempts.push({
					id: ref.id,
					kind: ref.kind,
					sessionFile: ref.sessionFile,
					state: "failed",
					error: flushed.error,
				});
				firstFailure ??= `descendant ${ref.id} flush failed: ${flushed.error}`;
				continue;
			}
			attempts.push({
				id: ref.id,
				kind: ref.kind,
				sessionFile: ref.sessionFile,
				state: "flushed",
			});
		} else {
			attempts.push({
				id: ref.id,
				kind: ref.kind,
				sessionFile: ref.sessionFile,
				state: ref.status === "aborted" ? "disposed" : "parked",
			});
		}
	}
	if (firstFailure !== undefined) {
		return {
			ok: false,
			main: mainAttempt,
			descendants: attempts,
			advisors: "inactive",
			error: firstFailure,
			note: DESCENDANT_FLUSH_BLOCKED,
		};
	}

	const advisorState = await advisorCaughtUp(main);
	if (!advisorState.ok) {
		return {
			ok: false,
			main: mainAttempt,
			descendants: attempts,
			advisors: advisorState.state,
			error: `advisor catch-up barrier failed: ${advisorState.error}`,
			note: ADVISOR_FLUSH_BLOCKED,
		};
	}
	return {
		ok: true,
		main: mainAttempt,
		descendants: attempts,
		advisors: advisorState.state,
		note: DISPOSE_CEILING_NOTE,
	};
}

async function flushSession(session: AgentSession): Promise<{ ok: boolean; error?: string }> {
	try {
		await session.sessionManager.flush();
		return { ok: true };
	} catch (cause) {
		const err = cause instanceof Error ? cause : new Error(String(cause));
		const code = (cause as { code?: unknown })?.code;
		const codeName: CallbackErrorCode =
			typeof code === "string" && isLedgerCode(code) ? code : "unavailable";
		return { ok: false, error: `${codeName}: ${err.message}` };
	}
}

function isLedgerCode(value: string): value is CallbackErrorCode {
	switch (value) {
		case "invalid_request":
		case "invalid_identity":
		case "unauthorized":
		case "forbidden":
		case "unavailable":
		case "conflict":
		case "generation_obsolete":
		case "writer_active":
		case "archive_pending":
		case "archive_conflict":
		case "provider_failed":
		case "retryable":
			return true;
		default:
			return false;
	}
}

/**
 * Advisor catch-up barrier. SessionAdvisors exposes no direct flush promise
 * (recorder close errors are swallowed by dispose's allSettled), so the
 * supported close cousins are: waitForAdvisorCatchup (pending card events)
 * when the API exists, else "inactive" when no advisor is configured/active.
 * `getAdvisorStatusOverview()` reports configured advisors; a configured +
 * active advisor that cannot be drained fails closed.
 */
async function advisorCaughtUp(
	session: AgentSession,
): Promise<{ ok: boolean; state: "caught_up" | "inactive"; error?: string }> {
	try {
		const overview = session.getAdvisorStatusOverview();
		const active = overview.advisors.some(
			(a) => a.status !== "paused" && a.status !== "no_model" && a.status !== "quota_exhausted",
		);
		if (!active) return { ok: true, state: "inactive" };
		// waitForAdvisorCatchup is the supported drain barrier; when the pinned
		// SDK lacks it, a configured advisor fails closed rather than guessing.
		const wait = (
			session as AgentSession & { waitForAdvisorCatchup?: (timeoutMs: number) => Promise<boolean> }
		).waitForAdvisorCatchup;
		if (typeof wait === "function") {
			const ok = await wait.call(session, 10_000);
			if (!ok) return { ok: false, state: "caught_up", error: "advisor catch-up timed out" };
			return { ok: true, state: "caught_up" };
		}
		return {
			ok: false,
			state: "caught_up",
			error: "advisors active but the SDK exposes no catch-up barrier",
		};
	} catch {
		// getAdvisorStatusOverview may not exist on older SDK builds; treat as
		// inactive only when advisors are provably off — otherwise fail closed.
		try {
			const overview = session.getAdvisorStatusOverview();
			if (
				overview.advisors.some(
					(a) => a.status !== "paused" && a.status !== "no_model" && a.status !== "quota_exhausted",
				)
			) {
				return { ok: false, state: "caught_up", error: "cannot verify advisor catch-up" };
			}
		} catch {
			// No overview API at all: nothing we can prove. The structural
			// read verification after dispose still covers __advisor*.jsonl.
		}
		return { ok: true, state: "inactive" };
	}
}
