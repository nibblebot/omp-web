import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "./session-entry";
import type { QuiesceWriterEntry } from "#lib/wire/callback-protocol";
import type { CallbackErrorCode } from "#lib/wire/callback-protocol";

/**
 * All-writer flush capture (P4.5; RuntimeMap P0.3 finding). The pinned SDK
 * logs descendant release failures and advisor-recorder teardown failures
 * rather than rejecting its complete disposal cascade. Dispose resolution
 * alone is therefore NOT all-writer flush evidence. Before ANY dispose,
 * capture every reachable writer, drain advisor cards, then explicitly flush
 * each SessionManager. Any rejected flush is a hard deletion block.
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
): { main: AgentSession; descendants: WriterRef[] } {
	const refs = registry.list();
	// Task executors register globally, unlike the boot session's private
	// registry. Only this entry's mirrored ids belong to this lineage.
	for (const id of entry.subagentSnapshots.keys()) {
		const ref = AgentRegistry.global().get(id);
		if (ref && !refs.some((existing) => existing.id === id)) refs.push(ref);
	}
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
}): Promise<WriterFlushResult> {
	const { entry, registry } = input;
	const { main, descendants } = captureWriters(entry, registry);

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

	// Advisor catch-up persists cards into the main transcript. The barrier
	// must precede the explicit flush, including pending cards after a pause.
	const advisorState = await advisorCaughtUp(main);
	if (!advisorState.ok) {
		return {
			ok: false,
			descendants: [],
			advisors: advisorState.state,
			error: `advisor catch-up barrier failed: ${advisorState.error}`,
			note: "advisor recorder catch-up unresolved; deletion blocked",
		};
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

	return {
		ok: true,
		descendants: states,
		advisors: advisorState.state,
		note: "SDK disposal logs descendant/advisor failures; explicit flush and post-dispose structural verification provide the deletion evidence.",
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
 * Always drain pending advisor-card persistence, even when the overview has
 * no active runtime. The current SDK's catch-up barrier covers those cards
 * as well as reviews; a timeout or rejected barrier is never proof of flush.
 */
async function advisorCaughtUp(
	session: AgentSession,
): Promise<{ ok: boolean; state: "caught_up" | "inactive"; error?: string }> {
	try {
		const overview = session.getAdvisorStatusOverview();
		const active = overview.advisors.some(
			(advisor) =>
				advisor.status !== "paused" &&
				advisor.status !== "no_model" &&
				advisor.status !== "quota_exhausted",
		);
		const state = active ? "caught_up" : "inactive";
		const ok = await session.waitForAdvisorCatchup(10_000, { waitThroughRecovery: true });
		if (!ok) return { ok: false, state, error: "advisor catch-up timed out" };
		return { ok: true, state };
	} catch (cause) {
		return {
			ok: false,
			state: "caught_up",
			error: cause instanceof Error ? cause.message : String(cause),
		};
	}
}
