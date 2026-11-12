import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CompactMode } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { findCompactMode } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import type { ShakeMode, ShakeResult } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { formatShakeSummary } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	canUseRemoteCompaction,
	resolveMethodSettings,
} from "@oh-my-pi/pi-coding-agent/session/compaction-methods";

/**
 * G13 explicit compaction + context maintenance (server-side domain adapter).
 *
 * Pure domain helpers + thin SDK execution wrappers. No wire imports: this
 * module never touches lib/wire, apps/session/methods.ts, or client delivery.
 * It reuses the installed SDK 18.19.0 behavior (compact-modes grammar,
 * CompactOptions, shake types, wire-vision gate) instead of reimplementing it.
 */

// ---------------------------------------------------------------------------
// Eligibility (explicit refuse, never silent fallback)
// ---------------------------------------------------------------------------

/** Caller-supplied context for an eligibility check. */
export interface CompactionEligibilityContext {
	/** An active model is selected (local summarize + handoff need one). */
	hasModel: boolean;
	/** Provider/model API label for refusal messages, when known. */
	modelApi?: string;
	/** A turn is currently streaming. */
	streaming: boolean;
	/** Post-prompt delivery work is pending (async-job result, retry, …). */
	hasPostPromptWork: boolean;
	/**
	 * Server-advertised remote-compaction support. `undefined` = unknown
	 * (no capability advertised yet): refuse explicitly, never guess.
	 */
	providerSupportsRemote?: boolean;
	/**
	 * Whether the current route can read images back. `undefined` = unknown:
	 * refuse explicitly. snapcompact archives history onto dense bitmap
	 * images, so a text-only route cannot use it.
	 */
	visionCapable?: boolean;
	/** Manual/automatic maintenance already owns the context. */
	compacting?: boolean;
}

export interface CompactionEligibility {
	eligible: boolean;
	reason?: string;
	/**
	 * True when the run would interrupt a live turn. The SDK permits manual
	 * compact during a turn (it aborts the turn itself), so this stays
	 * eligible — the caller confirms before proceeding.
	 */
	interruptsTurn?: boolean;
}

/** Refusals every manual compaction shares, whichever method runs. */
function sharedRefusal(ctx: CompactionEligibilityContext): CompactionEligibility | undefined {
	if (ctx.compacting)
		return { eligible: false, reason: "Context maintenance is already in progress." };
	if (!ctx.hasModel) {
		return {
			eligible: false,
			reason: "No model selected — compaction needs the active model to summarize locally.",
		};
	}
	if (ctx.hasPostPromptWork) {
		return {
			eligible: false,
			reason:
				"Post-prompt work is still pending (a delivery turn has not finished). " +
				"Wait for it to settle before compacting so the pass does not race the delivery turn.",
		};
	}
	return undefined;
}

/**
 * Eligibility for a run in the configured `compaction.methodOrder` (bare
 * `/compact`): only the shared gates apply, because the SDK itself skips a
 * method the route cannot run and tries the next one.
 */
export function configuredOrderEligibility(
	ctx: CompactionEligibilityContext,
): CompactionEligibility {
	return sharedRefusal(ctx) ?? { eligible: true, interruptsTurn: ctx.streaming };
}

/**
 * Eligibility for one explicit mode. Unsupported mode/model/backend is an
 * explicit refusal with a reason; modes never silently fall back to each other.
 */
export function eligibilityFor(
	mode: string,
	ctx: CompactionEligibilityContext,
): CompactionEligibility {
	const def = findCompactMode(mode);
	if (!def) {
		return {
			eligible: false,
			reason: `unsupported compaction mode "${mode}" (expected soft, remote, or snapcompact)`,
		};
	}
	const refusal = sharedRefusal(ctx);
	if (refusal) return refusal;
	const interruptsTurn = ctx.streaming;
	if (def.name === "remote") {
		if (ctx.providerSupportsRemote === true) return { eligible: true, interruptsTurn };
		if (ctx.providerSupportsRemote === false) {
			return {
				eligible: false,
				reason:
					`The current backend${ctx.modelApi ? ` (${ctx.modelApi})` : ""} exposes no server compaction ` +
					"(no endpoint or native route). Use soft instead — modes never silently fall back.",
			};
		}
		return {
			eligible: false,
			reason:
				"Remote compaction availability is unknown for this provider/route " +
				"(no server capability advertised yet). Use soft, or wait for capability advertisement.",
		};
	}
	if (def.name === "snapcompact") {
		if (ctx.visionCapable === true) return { eligible: true, interruptsTurn };
		if (ctx.visionCapable === false) {
			return {
				eligible: false,
				reason:
					`snapcompact cannot run on this route${ctx.modelApi ? ` (${ctx.modelApi})` : ""}: ` +
					"it archives history onto dense bitmap images the model must read back, " +
					"which needs a vision-capable route. Use soft or remote instead.",
			};
		}
		return {
			eligible: false,
			reason:
				"snapcompact needs a vision-capable route (history is archived onto bitmap images), " +
				"and this route has not advertised one. Use soft, or wait for capability advertisement.",
		};
	}
	return { eligible: true, interruptsTurn };
}

// ---------------------------------------------------------------------------
// Typed outcome envelope (real failure/cancel, no fake success)
// ---------------------------------------------------------------------------

export type CompactionFailureKind = "cancelled" | "unavailable" | "invalid_request" | "retryable";

export interface CompactionOutcome<T> {
	ok: boolean;
	data?: T;
	error?: string;
	failureKind?: CompactionFailureKind;
}

/**
 * All token figures that cross this adapter are ESTIMATES from the SDK's
 * usage/breakdown samplers, never exact accounting. The note is attached to
 * every shaped result so surfaces cannot present them as exact.
 */
export const CONTEXT_ESTIMATE_NOTE =
	"Token figures are estimates from context samplers, not exact accounting.";

/** Classify an SDK throw into the typed failure envelope. */
export function classifyCompactionError(err: unknown): {
	error: string;
	failureKind: CompactionFailureKind;
} {
	const message = err instanceof Error ? err.message : String(err);
	const name = err instanceof Error ? err.name : "";
	const haystack = `${name} ${message}`;
	if (/cancel|abort/i.test(haystack)) {
		return { error: message || "cancelled", failureKind: "cancelled" };
	}
	if (/nothing to compact|already compacted|no-op|noop/i.test(message)) {
		// An explicit no-op refusal (ManualCompactionNoOpError): surfaced as a
		// failure, never rewritten into a success.
		return { error: message, failureKind: "invalid_request" };
	}
	if (/does not take focus/i.test(message)) {
		return { error: message, failureKind: "invalid_request" };
	}
	if (
		/no model selected|cannot run|text-only|no configured compaction method|exceeds the context budget|would not reduce|could not bring/i.test(
			message,
		)
	) {
		return { error: message, failureKind: "unavailable" };
	}
	return { error: message || "compaction failed", failureKind: "retryable" };
}

/** Best-effort pre/post estimate snapshot; undefined when the sampler has no data. */
function sampleContextTokens(session: AgentSession): number | undefined {
	try {
		const usage = session.getContextUsage();
		if (typeof usage?.tokens === "number") return usage.tokens;
		const breakdown = session.getContextBreakdown();
		if (typeof breakdown?.usedTokens === "number") return breakdown.usedTokens;
	} catch {
		// Samplers are best-effort; a throw here must not fail the run.
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Execution wrappers (thin; SDK owns durable agent state)
// ---------------------------------------------------------------------------

export interface ExecuteCompactionArgs {
	/** Explicit mode; absent runs the configured `compaction.methodOrder`, like the SDK's bare `/compact`. */
	mode?: string;
	/** Focus instructions; rejected without an SDK round trip when the grammar rejects focus. */
	instructions?: string;
	/** Runs once the SDK has entered the run (`isCompacting` is true), before it settles. */
	onStarted?: () => void;
}

export interface ShapedCompactionResult {
	/** The explicit mode requested; absent for a configured-order run (see `appliedMethod`). */
	mode?: CompactMode;
	summary: string;
	firstKeptEntryId: string;
	/** SDK-reported pre-compact total (estimate). */
	tokensBefore?: number;
	/** Post-compact sampler estimate, when available (estimate). */
	appliedMethod?: string;
	/** A compaction boundary changes live context, not session identity or journal retention. */
	historyRetained: true;
	tokensAfterEstimate?: number;
	/** Whether the pass interrupted a live turn (SDK aborts the turn itself). */
	interruptedTurn: boolean;
	estimated: true;
	estimateNote: typeof CONTEXT_ESTIMATE_NOTE;
}

/**
 * Why a request can never run, whatever the session's state: an unknown mode, or focus text on a
 * mode that takes none. Absent when the request is well formed; the state-dependent gates
 * (model, route, maintenance) are `eligibilityFor`'s.
 */
export function compactionRequestRefusal(
	args: Pick<ExecuteCompactionArgs, "mode" | "instructions">,
): string | undefined {
	const def = args.mode === undefined ? undefined : findCompactMode(args.mode);
	if (args.mode !== undefined && !def) return `unsupported compaction mode "${args.mode}"`;
	if (def?.rejectsFocus && args.instructions?.trim()) {
		return `/compact ${def.name} does not take focus instructions (it archives history without an LLM summary).`;
	}
	return undefined;
}

/**
 * Run one compaction: an explicit mode maps to CompactOptions{mode}; no mode
 * leaves method selection to the SDK's configured order. Focus text passes
 * through as customInstructions where the grammar allows it. Model-context
 * change (the new summary) is distinguished from retained graph/history via
 * firstKeptEntryId; token figures are labeled estimates.
 */
export async function executeCompaction(
	session: AgentSession,
	args: ExecuteCompactionArgs,
): Promise<CompactionOutcome<ShapedCompactionResult>> {
	const invalid = compactionRequestRefusal(args);
	if (invalid) return { ok: false, error: invalid, failureKind: "invalid_request" };
	const def = args.mode === undefined ? undefined : findCompactMode(args.mode);
	const instructions = args.instructions?.trim() || undefined;
	const ctx = sessionEligibilityContext(session);
	const gate = def ? eligibilityFor(def.name, ctx) : configuredOrderEligibility(ctx);
	if (!gate.eligible) return { ok: false, error: gate.reason, failureKind: "unavailable" };
	const interruptedTurn = session.isStreaming;
	try {
		const options: CompactOptions = def ? { mode: def.name } : {};
		const pending = session.compact(instructions, options);
		args.onStarted?.();
		const result: CompactionResult = await pending;
		const shaped: ShapedCompactionResult = {
			...(def ? { mode: def.name } : {}),
			summary: result?.summary ?? "",
			firstKeptEntryId: result?.firstKeptEntryId ?? "",
			historyRetained: true,
			interruptedTurn,
			estimated: true,
			estimateNote: CONTEXT_ESTIMATE_NOTE,
		};
		if (typeof result?.tokensBefore === "number") shaped.tokensBefore = result.tokensBefore;
		const after = sampleContextTokens(session);
		const committed = session.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "compaction");
		if (committed && "method" in committed && typeof committed.method === "string") {
			shaped.appliedMethod = committed.method;
		}
		if (after !== undefined) shaped.tokensAfterEstimate = after;
		return { ok: true, data: shaped };
	} catch (err) {
		const classified = classifyCompactionError(err);
		return { ok: false, ...classified };
	}
}

export interface ShapedShakeResult extends ShakeResult {
	summary: string;
	estimated: true;
	estimateNote: typeof CONTEXT_ESTIMATE_NOTE;
	tokensBeforeEstimate?: number;
	tokensAfterEstimate?: number;
}

const SHAKE_MODES: readonly ShakeMode[] = ["elide", "images", "thinking"];

/** Reduce stored context with the selected shake strategy (SDK-owned). */
export async function executeShake(
	session: AgentSession,
	mode: ShakeMode,
): Promise<CompactionOutcome<ShapedShakeResult>> {
	if (!SHAKE_MODES.includes(mode)) {
		return {
			ok: false,
			error: `unsupported shake mode "${mode}" (expected elide, images, or thinking)`,
			failureKind: "invalid_request",
		};
	}
	if (session.isStreaming || session.hasPostPromptWork || session.isCompacting) {
		return {
			ok: false,
			error: "Wait for the active turn and context maintenance to finish before shaking.",
			failureKind: "unavailable",
		};
	}
	const before = sampleContextTokens(session);
	try {
		const result = await session.shake(mode);
		return {
			ok: true,
			data: {
				...result,
				summary: formatShakeSummary(result),
				tokensBeforeEstimate: before,
				tokensAfterEstimate: sampleContextTokens(session),
				estimated: true,
				estimateNote: CONTEXT_ESTIMATE_NOTE,
			},
		};
	} catch (err) {
		const classified = classifyCompactionError(err);
		return { ok: false, ...classified };
	}
}

/** Strip image content from the current branch and persist the rewrite. */
export async function executeDropImages(session: AgentSession): Promise<
	CompactionOutcome<{
		removed: number;
		tokensBeforeEstimate?: number;
		tokensAfterEstimate?: number;
		estimated: true;
	}>
> {
	if (session.isStreaming || session.hasPostPromptWork || session.isCompacting) {
		return {
			ok: false,
			error: "Wait for the active turn and context maintenance to finish before dropping images.",
			failureKind: "unavailable",
		};
	}
	const before = sampleContextTokens(session);
	try {
		const result = await session.dropImages();
		return {
			ok: true,
			data: {
				removed: result.removed,
				tokensBeforeEstimate: before,
				tokensAfterEstimate: sampleContextTokens(session),
				estimated: true,
			},
		};
	} catch (err) {
		const classified = classifyCompactionError(err);
		return { ok: false, ...classified };
	}
}

/** Toggle automatic compaction (session-scoped unless persisted). */
export function setAutoCompaction(
	session: AgentSession,
	enabled: boolean,
): CompactionOutcome<{ enabled: boolean }> {
	try {
		session.setAutoCompactionEnabled(enabled);
		return { ok: true, data: { enabled } };
	} catch (err) {
		const classified = classifyCompactionError(err);
		return { ok: false, ...classified };
	}
}

/** Cancel active manual, automatic, and handoff maintenance. */
export function abortCompactionRun(session: AgentSession, reason?: unknown): { ok: true } {
	session.abortCompaction(reason ?? "compaction aborted by operator");
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Handoff preview (read-only anchor reconciliation; no mutation)
// ---------------------------------------------------------------------------

export interface HandoffPreview {
	/** Stable session identity (never a filename or list index). */
	sessionId: string;
	/** Stable leaf identity for anchor reconciliation. */
	leafId: string | null;
	/** Recent-history size for anchor reconciliation. */
	historyMessages: number | null;
	/** True while a handoff document is being generated. */
	handoffActive: boolean;
	activeTurnPolicy: "snapshot-without-aborting-turn";
	eligible: boolean;
	reason?: string;
	keepRecentTokens: number;
	/** Prospective focus text, echoed back unmodified. */
	focus?: string;
}

/**
 * Read-only handoff anchor: identity + recent-history count for the caller to
 * reconcile against its cursor/revision. Never mutates: it does not call
 * handoff() (which commits a compaction entry) and never starts a turn.
 */
export function handoffPreview(session: AgentSession, focus?: string): HandoffPreview {
	let leafId: string | null = null;
	try {
		leafId = session.sessionManager.getLeafId() ?? null;
	} catch {
		leafId = null;
	}
	const historyMessages = session.messages.length;
	const handoffActive = session.isGeneratingHandoff;
	return {
		sessionId: session.sessionId,
		leafId,
		historyMessages,
		handoffActive,
		activeTurnPolicy: "snapshot-without-aborting-turn",
		eligible: !!session.model && !session.isCompacting && !session.hasPostPromptWork,
		...(!session.model
			? { reason: "No model selected for handoff." }
			: session.isCompacting || session.hasPostPromptWork
				? { reason: "Wait for context maintenance and post-prompt work to finish." }
				: {}),
		keepRecentTokens: cfgCompaction.get(session.settings).keepRecentTokens,
		...(focus !== undefined ? { focus } : {}),
	};
}

/** Capability checks use the SDK's actual route/settings, never guessed API labels. */
export function sessionEligibilityContext(session: AgentSession): CompactionEligibilityContext {
	const settings = cfgCompaction.get(session.settings);
	return {
		hasModel: !!session.model,
		modelApi: session.model?.api,
		streaming: session.isStreaming,
		hasPostPromptWork: session.hasPostPromptWork,
		compacting: session.isCompacting,
		providerSupportsRemote: canUseRemoteCompaction(
			session.model,
			resolveMethodSettings(settings, "remote"),
		),
		// The SDK's own snapcompact gate: a route that strips images on the wire
		// (e.g. a text-only Chat Completions SKU declaring image input) is not vision capable.
		visionCapable: !!session.model && sendsImageInputOnWire(session.model),
	};
}

export interface CompactionSnapshot {
	eligibility: Record<CompactMode, CompactionEligibility>;
	context: { usedTokens: number; contextWindow: number } | null;
	autoCompactionEnabled: boolean;
	active: boolean;
	handoff: HandoffPreview;
	remotePolicy: "remote-then-soft";
}

/** Read-only authoritative capabilities and estimates for a scoped browser refresh. */
export function compactionSnapshot(session: AgentSession): CompactionSnapshot {
	const ctx = sessionEligibilityContext(session);
	const breakdown = session.getContextBreakdown();
	return {
		eligibility: {
			soft: eligibilityFor("soft", ctx),
			remote: eligibilityFor("remote", ctx),
			snapcompact: eligibilityFor("snapcompact", ctx),
		},
		context: breakdown
			? { usedTokens: breakdown.usedTokens, contextWindow: breakdown.contextWindow }
			: null,
		autoCompactionEnabled: session.autoCompactionEnabled,
		active: session.isCompacting,
		handoff: handoffPreview(session),
		remotePolicy: "remote-then-soft",
	};
}
