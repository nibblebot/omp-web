import { pushNotice } from "./chat";
import { call } from "./transport";
import { asBoolean, asNumber, asRecord, asString } from "./subagents";
import { state } from "../state";

/**
 * Goals store (goals feature). Owns every goal, loop, and vibe wire call made
 * from the web client. Components mutate server state only through these
 * exports. Arg shapes match apps/session/methods.ts positionally.
 */

export const GOAL_OBJECTIVE_MAX = 4000;
export const GOAL_BUDGET_MAX = 10_000_000;

const LOOP_COUNT = /^[1-9]\d*$/;
const LOOP_DURATION = /^(?:[1-9]\d*(?:s|m|h))+$/;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Positive integer token budget within the server limit, else an error message. */
export function parseGoalBudget(raw: string): { tokenBudget: number } | { error: string } {
	const text = raw.trim();
	if (!/^\d+$/.test(text)) return { error: "goal budget must be a positive integer token count" };
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value < 1 || value > GOAL_BUDGET_MAX) {
		return {
			error: `goal budget must be between 1 and ${GOAL_BUDGET_MAX.toLocaleString()} tokens`,
		};
	}
	return { tokenBudget: value };
}

export function validateObjective(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return "objective is required";
	if (trimmed.length > GOAL_OBJECTIVE_MAX) {
		return `objective must be at most ${GOAL_OBJECTIVE_MAX} characters`;
	}
	return undefined;
}

/** Loop limit text for count/duration modes. */
export function validLoopLimit(mode: LoopMode, limit: string): boolean {
	if (mode === "count") return LOOP_COUNT.test(limit);
	if (mode === "duration") return LOOP_DURATION.test(limit);
	return true;
}

export type LoopMode = "count" | "duration" | "until" | "while";

/** Wire args for `goalCreate`: the object form carries the budget and consent. */
export function goalCreateArgs(
	objective: string,
	tokenBudget: number | undefined,
): [{ objective: string; tokenBudget?: number; consent: true }] {
	return [
		tokenBudget === undefined
			? { objective, consent: true }
			: { objective, tokenBudget, consent: true },
	];
}

/** Wire args for `goalReplace`: the objective, then the budget and consent options. */
export function goalReplaceArgs(
	objective: string,
	tokenBudget: number | undefined,
): [string, { tokenBudget?: number; consent: true }] {
	return [
		objective,
		tokenBudget === undefined ? { consent: true } : { tokenBudget, consent: true },
	];
}

/** Start the goal, then send the objective as the first turn (TUI parity). */
async function launchGoal(
	method: "goalCreate" | "goalReplace",
	objective: string,
	tokenBudget: number | undefined,
): Promise<boolean> {
	const text = objective.trim();
	const invalid = validateObjective(text);
	if (invalid) {
		pushNotice("error", `Goal ${invalid}`);
		return false;
	}
	try {
		if (method === "goalCreate") {
			await call("goalCreate", goalCreateArgs(text, tokenBudget));
		} else {
			await call("goalReplace", goalReplaceArgs(text, tokenBudget));
		}
	} catch (err) {
		pushNotice("error", errorMessage(err));
		return false;
	}
	pushNotice("info", `Goal active: ${text}`);
	try {
		await call(state.streaming ? "steer" : "prompt", [text]);
	} catch (err) {
		pushNotice("error", `Goal set, but work did not start: ${errorMessage(err)}`);
	}
	return true;
}

export function startGoal(objective: string, tokenBudget?: number): Promise<boolean> {
	return launchGoal("goalCreate", objective, tokenBudget);
}

export function replaceGoal(objective: string, tokenBudget?: number): Promise<boolean> {
	return launchGoal("goalReplace", objective, tokenBudget);
}

/** Set the token budget, or clear it when `tokenBudget` is undefined. */
export async function setGoalBudget(tokenBudget?: number): Promise<void> {
	try {
		await call("goalBudget", tokenBudget === undefined ? [] : [tokenBudget]);
	} catch (err) {
		pushNotice("error", errorMessage(err));
		return;
	}
	pushNotice(
		"info",
		tokenBudget === undefined
			? "Goal budget cleared"
			: `Goal budget set to ${tokenBudget.toLocaleString()} tokens`,
	);
}

export async function pauseGoal(): Promise<void> {
	try {
		await call("goalPause", []);
		pushNotice("info", "Goal paused");
	} catch (err) {
		pushNotice("error", errorMessage(err));
	}
}

export async function resumeGoal(): Promise<void> {
	try {
		await call("goalResume", [{ consent: true }]);
		pushNotice("info", "Goal resumed");
	} catch (err) {
		pushNotice("error", errorMessage(err));
	}
}

export async function dropGoal(): Promise<void> {
	try {
		await call("goalDrop", []);
		pushNotice("info", "Goal dropped");
	} catch (err) {
		pushNotice("error", errorMessage(err));
	}
}

// ---------------------------------------------------------------------------
// Loops. Server DTO read models and wire calls.

export interface LoopPolicy {
	status: string;
	iteration: number;
	queuedMessageCount: number;
	isStreaming: boolean;
	hasPostPromptWork: boolean;
	stopReason?: string;
	/** Epoch milliseconds of the next scheduled iteration. */
	nextRunAt?: number;
	pauseAllUnavailableReason?: string;
	boundedLoop: boolean;
}

function coerceLoopPolicy(raw: unknown): LoopPolicy | undefined {
	const root = asRecord(raw);
	if (!root) return undefined;
	const loop = asRecord(root.loop);
	const capabilities = asRecord(root.capabilities);
	return {
		status: asString(loop?.status) ?? "idle",
		iteration: asNumber(loop?.iteration) ?? 0,
		queuedMessageCount: asNumber(root.queuedMessageCount) ?? 0,
		isStreaming: asBoolean(root.isStreaming) ?? false,
		hasPostPromptWork: asBoolean(root.hasPostPromptWork) ?? false,
		stopReason: asString(loop?.stopReason),
		nextRunAt: asNumber(loop?.nextRunAt),
		pauseAllUnavailableReason: asString(capabilities?.pauseAllUnavailableReason),
		boundedLoop: asBoolean(capabilities?.boundedLoop) ?? false,
	};
}

export type LoopPreviewResult = { ok: true; summary: string } | { ok: false; error: string };

export async function previewLoop(argsText: string): Promise<LoopPreviewResult> {
	try {
		const raw = asRecord(await call("loopPreview", [argsText]));
		if (raw?.ok === true) return { ok: true, summary: asString(raw.summary) ?? "" };
		return { ok: false, error: asString(raw?.error) ?? "loop preview failed" };
	} catch (err) {
		return { ok: false, error: errorMessage(err) };
	}
}

export async function getLoopPolicy(): Promise<LoopPolicy | undefined> {
	try {
		return coerceLoopPolicy(await call("loopPolicy", []));
	} catch {
		return undefined;
	}
}

/** Start a bounded loop. `prompt` is the per-iteration prompt. */
export async function startLoop(argsText: string, prompt: string): Promise<string | undefined> {
	try {
		await call("loopStart", [argsText, { prompt, consent: true }]);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function pauseLoop(): Promise<string | undefined> {
	try {
		await call("loopPause", []);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function resumeLoop(): Promise<string | undefined> {
	try {
		await call("loopResume", [{ consent: true }]);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function cancelLoop(): Promise<string | undefined> {
	try {
		await call("loopCancel", []);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

// ---------------------------------------------------------------------------
// Vibe. Server DTO read models and wire calls.

export interface VibeWorkerDto {
	id: string;
	name: string;
	cli: string;
	state: string;
	turns: number;
	queued: number;
}

export interface VibeStatus {
	enabled: boolean;
	workers: VibeWorkerDto[];
	reason?: string;
}

function coerceVibeWorker(raw: unknown): VibeWorkerDto | undefined {
	const root = asRecord(raw);
	const id = asString(root?.id) ?? asString(root?.name);
	if (!root || !id) return undefined;
	return {
		id,
		name: asString(root.name) ?? id,
		cli: asString(root.cli) ?? "",
		state: asString(root.state) ?? "",
		turns: asNumber(root.turns) ?? 0,
		queued: asNumber(root.queued) ?? 0,
	};
}

export async function getVibeStatus(): Promise<VibeStatus | undefined> {
	try {
		const root = asRecord(await call("vibeStatus", []));
		if (!root) return undefined;
		const workers = Array.isArray(root.workers)
			? root.workers.map(coerceVibeWorker).filter((w): w is VibeWorkerDto => w !== undefined)
			: [];
		return { enabled: asBoolean(root.enabled) ?? false, workers, reason: asString(root.reason) };
	} catch {
		return undefined;
	}
}

/** Enable or disable Vibe mode. Enabling is consent-gated server-side. */
export async function setVibeMode(enabled: boolean): Promise<string | undefined> {
	try {
		await call("vibeSetMode", [enabled, { consent: true }]);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function spawnVibeWorker(input: {
	cli: "fast" | "good";
	prompt: string;
	name?: string;
}): Promise<string | undefined> {
	try {
		await call("vibeSpawn", [{ ...input, consent: true }]);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function sendVibeWorker(
	session: string,
	message: string,
): Promise<string | undefined> {
	try {
		await call("vibeSend", [{ session, message, consent: true }]);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function waitVibeWorker(
	session: string,
	timeoutMs = 20_000,
): Promise<string | undefined> {
	try {
		await call("vibeWait", [{ sessions: [session], timeoutMs }]);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function killVibeWorker(id: string): Promise<string | undefined> {
	try {
		await call("vibeKill", [id]);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function killAllVibeWorkers(): Promise<string | undefined> {
	try {
		await call("vibeKillAll", []);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}

export async function rehydrateVibeWorkers(): Promise<string | undefined> {
	try {
		await call("vibeRehydrate", []);
		return undefined;
	} catch (err) {
		return errorMessage(err);
	}
}
