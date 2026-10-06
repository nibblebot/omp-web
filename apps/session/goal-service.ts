// Goal service: validation + GoalRuntime passthroughs + /loop preview/policy.
//
// Server owns durable agent state; this module is the pure service layer.
// No side effects at import time. Errors are plain Errors naming at most the
// agent id (never session-file paths).

import { describeLoopCondition } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { describeLoopLimit, parseLoopArgs } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { SessionEntry } from "./session-entry";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { getAutonomyAdapter } from "./autonomy-adapter";
import type { AutonomyAdapter, LoopSnapshot } from "./autonomy-adapter";

const MAX_OBJECTIVE_CHARS = 4000;
const MAX_TOKEN_BUDGET = 10_000_000;

export function validateObjective(objective: unknown): string {
	if (typeof objective !== "string" || objective.trim().length === 0) {
		throw new Error("objective is required");
	}
	const trimmed = objective.trim();
	if (trimmed.length > MAX_OBJECTIVE_CHARS) {
		throw new Error(`objective exceeds ${MAX_OBJECTIVE_CHARS} characters`);
	}
	return trimmed;
}

export function validateTokenBudget(budget: unknown): number | undefined {
	if (budget === undefined || budget === null) return undefined;
	if (!Number.isInteger(budget) || (budget as number) <= 0) {
		throw new Error("goal token_budget must be a positive integer when provided");
	}
	if ((budget as number) > MAX_TOKEN_BUDGET) {
		throw new Error(`goal token_budget exceeds ${MAX_TOKEN_BUDGET}`);
	}
	return budget as number;
}

function guardModeExclusion(entry: SessionEntry): void {
	if (!cfgGoalEnabled.get(entry.session.settings))
		throw new Error("Goal mode is disabled (goal.enabled)");
	const loop = getAutonomyAdapter(entry).snapshot();
	if (loop.status === "running" || loop.status === "paused")
		throw new Error("Cancel the current loop before starting a goal");
	if (entry.session.getPlanModeState()?.enabled === true) {
		throw new Error("Exit plan mode first");
	}
	const getVibe = entry.session.getVibeModeState;
	if (typeof getVibe === "function" && getVibe.call(entry.session)?.enabled === true) {
		throw new Error("Exit vibe mode first");
	}
}

// The SDK headless controller owns tool-set entry/exit and continuation policy.
// Creating/replacing/resuming execution always requires explicit operator consent.

export async function createGoal(
	entry: SessionEntry,
	input: { objective: string; tokenBudget?: number; consent?: boolean },
): Promise<unknown> {
	if (input.consent !== true) throw new Error("Explicit goal execution consent is required");
	const adapter = getAutonomyAdapter(entry);
	await adapter.ready;
	guardModeExclusion(entry);
	const result = await adapter.goal.handle({
		op: "create",
		objective: validateObjective(input.objective),
		token_budget: validateTokenBudget(input.tokenBudget),
	});
	return result.state;
}

export async function replaceGoal(
	entry: SessionEntry,
	input: { objective: string; tokenBudget?: number; consent?: boolean },
): Promise<unknown> {
	if (input.consent !== true) throw new Error("Explicit goal execution consent is required");
	const adapter = getAutonomyAdapter(entry);
	await adapter.ready;
	guardModeExclusion(entry);
	if (!entry.session.getGoalModeState()?.enabled)
		throw new Error("Resume the paused goal before replacing its objective");
	return entry.session.goalRuntime.replaceGoal({
		objective: validateObjective(input.objective),
		tokenBudget: validateTokenBudget(input.tokenBudget),
	});
}

export async function setBudget(entry: SessionEntry, tokenBudget?: number): Promise<unknown> {
	return entry.session.goalRuntime.onBudgetMutated(validateTokenBudget(tokenBudget));
}

export async function pauseGoal(entry: SessionEntry): Promise<unknown> {
	const adapter = getAutonomyAdapter(entry);
	await adapter.ready;
	return (await adapter.goal.handle({ op: "pause" })).state;
}

export async function resumeGoal(
	entry: SessionEntry,
	input?: { consent?: boolean },
): Promise<unknown> {
	if (input?.consent !== true) throw new Error("Explicit goal resume consent is required");
	const adapter = getAutonomyAdapter(entry);
	await adapter.ready;
	guardModeExclusion(entry);
	return (await adapter.goal.handle({ op: "resume" })).state;
}

export async function dropGoal(entry: SessionEntry): Promise<unknown> {
	const adapter = getAutonomyAdapter(entry);
	await adapter.ready;
	return (await adapter.goal.handle({ op: "drop" })).state;
}

export type LoopPreview = { ok: true; summary: string } | { ok: false; error: string };

/**
 * Preview `/loop` args without starting anything. Never throws.
 *
 * A count, duration, until or while rule is mandatory at start. Preview does
 * not execute shell conditions or admit any autonomous turn.
 */
export function previewLoop(argsText: string): LoopPreview {
	const parsed = parseLoopArgs(argsText);
	if (typeof parsed === "string") return { ok: false, error: parsed };
	const parts: string[] = [];
	if (parsed.limit) parts.push(`limit: ${describeLoopLimit(parsed.limit)}`);
	if (parsed.condition) parts.push(`condition: ${describeLoopCondition(parsed.condition)}`);
	if (parsed.prompt) parts.push(`prompt: ${parsed.prompt}`);
	if (!parsed.limit && !parsed.condition)
		return { ok: false, error: "A loop count, duration, until or while rule is required" };
	return { ok: true, summary: parts.join("; ") };
}

/**
 * Daemon-owned execution survives browser reconnects. Policy is a read model,
 * not permission to submit another prompt from the browser.
 */
export function getLoopPolicy(entry: SessionEntry): {
	hasPostPromptWork: boolean;
	queuedMessageCount: number;
	isStreaming: boolean;
	loop: LoopSnapshot;
	capabilities: AutonomyAdapter["capabilities"];
} {
	try {
		return {
			hasPostPromptWork: entry.session.hasPostPromptWork === true,
			queuedMessageCount: entry.session.queuedMessageCount ?? 0,
			isStreaming: entry.session.isStreaming === true,
			loop: getAutonomyAdapter(entry).snapshot(),
			capabilities: getAutonomyAdapter(entry).capabilities,
		};
	} catch {
		throw new Error("Loop policy is unavailable");
	}
}

export function startLoop(
	entry: SessionEntry,
	input: { argsText: string; prompt?: string; consent?: boolean },
) {
	return getAutonomyAdapter(entry).start(input);
}
export function pauseLoop(entry: SessionEntry) {
	return getAutonomyAdapter(entry).pause();
}
export function cancelLoop(entry: SessionEntry) {
	return getAutonomyAdapter(entry).cancel();
}
export function resumeLoop(entry: SessionEntry, input: { consent?: boolean }) {
	return getAutonomyAdapter(entry).resume(input);
}
