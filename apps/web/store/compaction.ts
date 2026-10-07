import { state, setState } from "../state";
import { call, isSessionSwitchSupersession } from "./transport";

export type CompactionModeName = "soft" | "remote" | "snapcompact";
export type ShakeModeName = "elide" | "images" | "thinking";
export type CompactionPhase = "idle" | "running" | "done" | "error" | "cancelled";
export interface CompactionEligibility {
	eligible: boolean;
	reason?: string;
	interruptsTurn?: boolean;
}
export interface ContextEstimate {
	usedTokens: number;
	contextWindow: number;
}
export interface HandoffAnchor {
	sessionId: string;
	leafId: string | null;
	historyMessages: number | null;
	handoffActive: boolean;
	activeTurnPolicy: "snapshot-without-aborting-turn";
	eligible: boolean;
	reason?: string;
	keepRecentTokens: number;
}
export interface CompactionResultView {
	mode: CompactionModeName;
	appliedMethod?: string;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore?: number;
	tokensAfterEstimate?: number;
	historyRetained: true;
}
export interface MaintenanceView {
	phase: CompactionPhase;
	summary?: string;
	tokensFreed?: number;
	removed?: number;
	error?: string;
}
export interface CompactionSnapshot {
	eligibility: Record<CompactionModeName, CompactionEligibility>;
	context: ContextEstimate | null;
	autoCompactionEnabled: boolean;
	active: boolean;
	handoff: HandoffAnchor;
	remotePolicy: "remote-then-soft";
}
export interface CompactionState {
	selectedMode: CompactionModeName;
	focusText: string;
	eligibility: CompactionEligibility;
	modeEligibility: Record<CompactionModeName, CompactionEligibility>;
	progress: { phase: CompactionPhase; startedAt?: number; cancelRequested?: boolean };
	result: CompactionResultView | null;
	error: string | null;
	preEstimate: ContextEstimate | null;
	postEstimate: ContextEstimate | null;
	anchor: HandoffAnchor | null;
	shake: MaintenanceView;
	dropImages: MaintenanceView;
	autoPending: boolean;
	snapshotPending: boolean;
	active: boolean;
}
export const COMPACTION_MODE_META = [
	{
		name: "soft",
		description: "Summarize locally with the active model (skip server compaction)",
		rejectsFocus: false,
	},
	{
		name: "remote",
		description:
			"Try server compaction, then SDK local-summary fallback; unsupported routes refuse before running",
		rejectsFocus: false,
	},
	{
		name: "snapcompact",
		description: "Archive history onto bitmap images the vision model reads back (no LLM call)",
		rejectsFocus: true,
	},
] as const;
export const SHAKE_MODE_META = [
	{ name: "elide", description: "Drop old tool results and large fenced/XML blocks" },
	{ name: "images", description: "Remove image blocks; originals retained in a session artifact" },
	{ name: "thinking", description: "Drop thinking blocks" },
] as const;
export const ESTIMATE_NOTE =
	"Token figures are estimates from context samplers, not exact accounting.";

/** Initial slice for the application's single Solid store; no module-local mirrors. */
export function createCompactionState(): CompactionState {
	const unavailable = {
		eligible: false,
		reason: "Loading authoritative model and route eligibility…",
	};
	return {
		selectedMode: "soft",
		focusText: "",
		eligibility: { ...unavailable },
		modeEligibility: {
			soft: { ...unavailable },
			remote: { ...unavailable },
			snapcompact: { ...unavailable },
		},
		progress: { phase: "idle" },
		result: null,
		error: null,
		preEstimate: null,
		postEstimate: null,
		anchor: null,
		shake: { phase: "idle" },
		dropImages: { phase: "idle" },
		autoPending: false,
		snapshotPending: false,
		active: false,
	};
}

// Stable view contracts for presentation-only controls.
export const selectedMode = () => state.compaction.selectedMode;
export const focusText = () => state.compaction.focusText;
export const eligibility = () => state.compaction.eligibility;
export const progress = () => state.compaction.progress;
export const result = () => state.compaction.result;
export const compactionError = () => state.compaction.error;
export const preEstimate = () => state.compaction.preEstimate;
export const postEstimate = () => state.compaction.postEstimate;
export const anchor = () => state.compaction.anchor;
export const shakeState = () => state.compaction.shake;
export const dropImagesState = () => state.compaction.dropImages;
export const autoPending = () => state.compaction.autoPending;
export const modeEligibility = (mode: CompactionModeName) => state.compaction.modeEligibility[mode];
export const maintenanceBusy = () =>
	state.compaction.active ||
	progress().phase === "running" ||
	shakeState().phase === "running" ||
	dropImagesState().phase === "running";

function computeEligibility(): CompactionEligibility {
	let gate = modeEligibility(selectedMode());
	if (selectedMode() === "snapcompact" && focusText().trim()) {
		gate = {
			eligible: false,
			reason:
				"/compact snapcompact does not take focus instructions (it archives history without an LLM summary).",
		};
	} else if (maintenanceBusy()) {
		gate = { eligible: false, reason: "Context maintenance is already in progress." };
	}
	setState("compaction", "eligibility", gate);
	return gate;
}

export function selectCompactionMode(mode: CompactionModeName): void {
	setState("compaction", "selectedMode", mode);
	computeEligibility();
}
export function setCompactionFocus(text: string): void {
	setState("compaction", "focusText", text);
	computeEligibility();
}

/** A scope switch replaces the slice, invalidating every in-flight continuation. */
export async function refreshCompactionEligibility(post = false): Promise<void> {
	const owner = state.compaction;
	setState("compaction", "snapshotPending", true);
	try {
		const snapshot = (await call("compactionSnapshot")) as CompactionSnapshot;
		if (state.compaction !== owner) return;
		setState("compaction", "modeEligibility", snapshot.eligibility);
		setState("compaction", "active", snapshot.active);
		setState("compaction", "anchor", snapshot.handoff);
		setState("compaction", post ? "postEstimate" : "preEstimate", snapshot.context);
		setState("autoCompactionEnabled", snapshot.autoCompactionEnabled);
		computeEligibility();
	} catch (error) {
		if (state.compaction !== owner || isSessionSwitchSupersession(error)) return;
		const reason = error instanceof Error ? error.message : String(error);
		const refusal = { eligible: false, reason };
		setState("compaction", {
			error: reason,
			eligibility: refusal,
			modeEligibility: { soft: refusal, remote: refusal, snapcompact: refusal },
		});
	} finally {
		if (state.compaction === owner) setState("compaction", "snapshotPending", false);
	}
}
export function refreshHandoffAnchor(): void {
	void refreshCompactionEligibility();
}

interface Outcome<T> {
	ok: boolean;
	data?: T;
	error?: string;
	failureKind?: "cancelled" | "unavailable" | "invalid_request" | "retryable";
}

export async function startCompaction(): Promise<void> {
	if (maintenanceBusy()) return;
	const owner = state.compaction;
	await refreshCompactionEligibility();
	if (state.compaction !== owner) return;
	const gate = computeEligibility();
	if (!gate.eligible) {
		setState("compaction", {
			error: gate.reason ?? "Compaction is unavailable.",
			progress: { phase: "error" },
		});
		return;
	}
	const mode = selectedMode();
	const instructions = focusText().trim() || undefined;
	setState("compaction", {
		result: null,
		error: null,
		postEstimate: null,
		progress: { phase: "running", startedAt: Date.now() },
	});
	try {
		const outcome = (await call(
			"compactEx",
			[{ mode, instructions }],
			300_000,
		)) as Outcome<CompactionResultView>;
		if (state.compaction !== owner) return;
		if (!outcome.ok || !outcome.data) {
			setState("compaction", {
				error: outcome.error ?? "Compaction returned no result.",
				progress: { phase: outcome.failureKind === "cancelled" ? "cancelled" : "error" },
			});
		} else {
			setState("compaction", { result: outcome.data, progress: { phase: "done" } });
		}
	} catch (error) {
		if (state.compaction !== owner || isSessionSwitchSupersession(error)) return;
		setState("compaction", {
			error: error instanceof Error ? error.message : String(error),
			progress: { phase: "error" },
		});
	} finally {
		if (state.compaction === owner) await refreshCompactionEligibility(true);
	}
}

/** Abort acknowledgement is not completion: only the run's real outcome settles its phase. */
export async function cancelCompaction(): Promise<void> {
	if (progress().phase !== "running" || progress().cancelRequested) return;
	const owner = state.compaction;
	setState("compaction", "progress", "cancelRequested", true);
	try {
		await call("abortCompaction", [{ reason: "Compaction cancelled by operator" }], 5_000);
	} catch (error) {
		if (state.compaction !== owner || isSessionSwitchSupersession(error)) return;
		setState("compaction", "error", error instanceof Error ? error.message : String(error));
		setState("compaction", "progress", "cancelRequested", false);
	}
}

async function maintain(kind: "shake" | "dropImages", mode?: ShakeModeName): Promise<void> {
	if (maintenanceBusy()) return;
	const owner = state.compaction;
	if (state.streaming) {
		setState("compaction", kind, {
			phase: "error",
			error: "Wait for the active turn before mechanically trimming context.",
		});
		return;
	}
	await refreshCompactionEligibility();
	if (state.compaction !== owner || maintenanceBusy()) return;
	setState("compaction", kind, { phase: "running", error: undefined });
	try {
		const outcome = (await call(kind, mode ? [{ mode }] : [], 120_000)) as Outcome<MaintenanceView>;
		if (state.compaction !== owner) return;
		if (!outcome.ok || !outcome.data) {
			setState("compaction", kind, {
				phase: outcome.failureKind === "cancelled" ? "cancelled" : "error",
				error: outcome.error ?? "Maintenance returned no result.",
			});
		} else {
			setState("compaction", kind, { ...outcome.data, phase: "done" });
		}
	} catch (error) {
		if (state.compaction !== owner || isSessionSwitchSupersession(error)) return;
		setState("compaction", kind, {
			phase: "error",
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		if (state.compaction === owner) await refreshCompactionEligibility(true);
	}
}
export function runShake(mode: ShakeModeName): void {
	void maintain("shake", mode);
}
export function runDropImages(): void {
	void maintain("dropImages");
}
export async function toggleAutoCompaction(enabled: boolean): Promise<void> {
	if (autoPending()) return;
	const owner = state.compaction;
	setState("compaction", "autoPending", true);
	try {
		await call("setAutoCompaction", [enabled], 15_000);
		if (state.compaction === owner) await refreshCompactionEligibility();
	} catch (error) {
		if (state.compaction === owner && !isSessionSwitchSupersession(error))
			setState("compaction", "error", error instanceof Error ? error.message : String(error));
	} finally {
		if (state.compaction === owner) setState("compaction", "autoPending", false);
	}
}
