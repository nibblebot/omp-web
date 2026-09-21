import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "./session-entry";
import type { QuiesceWriterEntry } from "../shared/callback-protocol";
import type { CallbackErrorCode } from "../shared/callback-protocol";

/**
 * All-writer flush capture (P4.5; RuntimeMap P0.3 finding). The SDK's
 * AgentSession.dispose and AgentLifecycleManager.release swallow descendant
 * and advisor-recorder close failures (allSettled / try-catch in the pinned
 * 17.1.8 sources), so dispose resolution alone is NOT all-writer flush
 * evidence. Before ANY dispose, this captures every reachable live writer,
 * the boot session's own SessionManager plus every registered sub/advisor
 * ref with a live AgentSession, and calls flush() on each. A latched
 * SessionPersistenceIndeterminateError (or any rejected flush) is a hard
 * block, surfaced typed.
 *
 * Writers that the SDK already released (parked/aborted refs with null
 * sessions) are recorded as parked/disposed and covered by the structural
 * read verification of the on-disk JSONL afterwards.
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

/** Capture the writer surface of one session entry. */
export function captureWriters(
	entry: SessionEntry,
	registry: AgentRegistry,
	mainSessionFile: string | null,
): { main: AgentSession; descendants: WriterRef[] } {
	const refs = registry.list();
	const descendants: WriterRef[] = refs
		.filter((ref) => ref.id !== "s1" && (ref.kind === "sub" || ref.kind === "advisor"))
		.map((ref) => ({
			id: ref.id,
			kind: ref.kind,
			sessionFile: ref.sessionFile,
			session: ref.session,
			status: ref.status,
		}));
	return { main: entry.session, descendants };
}

/**
 * Fail-closed writer precondition + explicit flush of every reachable
 * SessionManager. Returns WriterFlushResult with per-descendant states.
 * Any live writer (main streaming/queued, a sub/advisor ref running, or a
 * flush rejection) fails closed with `writer_active` / `unavailable`;
 * deletion is refused, never inferred from dispose resolution.
 */
export async function flushAllWriters(input: {
	entry: SessionEntry;
	registry: AgentRegistry;
	mainSessionFile: string | null;
}): Promise<WriterFlushResult> {
	const { entry, registry, mainSessionFile } = input;
	const { main, descendants } = captureWriters(entry, registry, mainSessionFile);

	// Precondition gate: no live writer may remain (P7.3 "refuse active
	// work"). The main session's own busy state is the primary signal.
	if (main.isStreaming || main.queuedMessageCount > 0) {
		return {
			ok: false,
			descendants: [],
			advisors: "inactive",
			error: "main session is streaming or has queued messages",
		};
	}
	// mainSessionFile is reserved for the structural-verification pass that
	// runs after dispose (the main JSONL path is derived from the sessions
	// tree, not this handle).
	for (const ref of descendants) {
		if (ref.status === "running" || ref.status === "idle") {
			return {
				ok: false,
				descendants: [],
				advisors: "inactive",
				error: `descendant writer ${ref.id} (${ref.kind}) is still live (${ref.status})`,
			};
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
			descendants: [],
			advisors: "inactive",
			error: `main session flush failed: ${flushMain.error}`,
			note: "main flush rejected or persistence indeterminate; deletion blocked (P4.5)",
		};
	}
	const states: QuiesceWriterEntry[] = [];
	for (const ref of descendants) {
		if (ref.session !== null) {
			const flushed = await flushSession(ref.session);
			if (!flushed.ok) {
				return {
					ok: false,
					descendants: states,
					advisors: "inactive",
					error: `descendant ${ref.id} flush failed: ${flushed.error}`,
					note: "descendant flush rejected or persistence indeterminate; deletion blocked (P4.5)",
				};
			}
			states.push({ id: ref.id, kind: ref.kind, sessionFile: ref.sessionFile, state: "flushed" });
		} else {
			states.push({
				id: ref.id,
				kind: ref.kind,
				sessionFile: ref.sessionFile,
				state: ref.status === "aborted" ? "disposed" : "parked",
			});
		}
	}

	const advisorState = await advisorCaughtUp(main);
	if (!advisorState.ok) {
		return {
			ok: false,
			descendants: states,
			advisors: advisorState.state,
			error: `advisor catch-up barrier failed: ${advisorState.error}`,
			note: "advisor recorder catch-up unresolved; deletion blocked",
		};
	}
	return {
		ok: true,
		descendants: states,
		advisors: advisorState.state,
		note: "SDK 17.1.8 ceiling: dispose suppresses descendant/advisor errors; flush here is the explicit evidence, and structural read verification of every declared JSONL runs after dispose.",
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
		// inactive only when advisors are provably off, otherwise fail closed.
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
