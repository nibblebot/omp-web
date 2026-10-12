import { call } from "./transport";
import { asBoolean, asNumber, asRecord, asString } from "./subagents";

// ---------------------------------------------------------------------------
// Goals. goalCreate/goalPause/goalResume/goalDrop exist on the wire;
// Mutations use the daemon-owned goal runtime.
// ---------------------------------------------------------------------------

/** Create a goal (existing goalCreate row); rejects (throws to caller) on failure. */
export function createGoal(objective: string, tokenBudget?: number): Promise<unknown> {
	return call("goalCreate", tokenBudget !== undefined ? [objective, tokenBudget] : [objective]);
}

/** Replace the active goal through the server-owned runtime. */
export function replaceGoal(objective: string, tokenBudget?: number): Promise<unknown> {
	return call("goalReplace", tokenBudget !== undefined ? [objective, tokenBudget] : [objective]);
}

/** Set the budget through goalRuntime.onBudgetMutated. */
export function setGoalBudget(tokenBudget?: number): Promise<unknown> {
	return call("goalBudget", tokenBudget !== undefined ? [tokenBudget] : []);
}

/** Pause the active goal (existing goalPause row); rejects (throws to caller) on failure. */
export function pauseGoal(): Promise<unknown> {
	return call("goalPause", []);
}

/** Resume the paused goal (existing goalResume row); rejects (throws to caller) on failure. */
export function resumeGoal(): Promise<unknown> {
	return call("goalResume", []);
}

/** Drop the active goal (existing goalDrop row); rejects (throws to caller) on failure. */
export function dropGoal(): Promise<unknown> {
	return call("goalDrop", []);
}

// ---------------------------------------------------------------------------
// Loop policy / preview.
// ---------------------------------------------------------------------------

/** Server read; unavailable operations reject to the caller. */
export async function previewLoop(argsText: string): Promise<{
	ok: boolean;
	summary?: string;
	error?: string;
}> {
	try {
		const data = await call("loopPreview", [argsText]);
		const r: Record<string, unknown> = asRecord(data) ?? {};
		const preview: { ok: boolean; summary?: string; error?: string } = {
			ok: asBoolean(r.ok) ?? false,
		};
		const summary = asString(r.summary);
		if (summary !== undefined) preview.summary = summary;
		const error = asString(r.error);
		if (error !== undefined) preview.error = error;
		return preview;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Server read; unavailable operations reject to the caller. */
export async function getLoopPolicy(): Promise<{
	hasPostPromptWork: boolean;
	queuedMessageCount: number;
	isStreaming: boolean;
}> {
	const data = await call("loopPolicy", []);
	const r: Record<string, unknown> = asRecord(data) ?? {};
	return {
		hasPostPromptWork: asBoolean(r.hasPostPromptWork) ?? false,
		queuedMessageCount: asNumber(r.queuedMessageCount) ?? 0,
		isStreaming: asBoolean(r.isStreaming) ?? false,
	};
}

// ---------------------------------------------------------------------------
// Vibe workers. Server DTO read models. State and
// list both read vibeStatus ({ enabled, workers }); each coerces its half.
// ---------------------------------------------------------------------------

/** Server read; unavailable operations reject to the caller. */
export async function getVibeState(): Promise<{ enabled: boolean }> {
	const data = await call("vibeStatus", []);
	const r: Record<string, unknown> = asRecord(data) ?? {};
	return { enabled: asBoolean(r.enabled) ?? false };
}

/** Set vibe mode; rejects (throws to caller) on server failure. */
export function setVibeMode(enabled: boolean): Promise<{ enabled: boolean }> {
	return call("vibeSetMode", [enabled]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { enabled: asBoolean(r.enabled) ?? enabled };
	});
}

export interface VibeWorkerDto {
	id: string;
	cli: "fast" | "good";
	state: string;
	model?: string;
	turns: number;
	queued: number;
	lastActivity?: string;
	lastActivityAt: number;
	killed?: boolean;
}

function coerceVibeWorker(row: unknown): VibeWorkerDto | null {
	const r = asRecord(row);
	if (r === null) return null;
	const id = asString(r.id);
	if (id === undefined || id === "") return null;
	const worker: VibeWorkerDto = {
		id,
		cli: asString(r.cli) === "good" ? "good" : "fast",
		state: asString(r.state) ?? "",
		turns: asNumber(r.turns) ?? 0,
		queued: asNumber(r.queued) ?? 0,
		lastActivityAt: asNumber(r.lastActivityAt) ?? 0,
	};
	const model = asString(r.model);
	if (model !== undefined) worker.model = model;
	const lastActivity = asString(r.lastActivity);
	if (lastActivity !== undefined) worker.lastActivity = lastActivity;
	const killed = asBoolean(r.killed);
	if (killed !== undefined) worker.killed = killed;
	return worker;
}

/** Server read; unavailable operations reject to the caller. */
export async function listVibeWorkers(): Promise<{ enabled: boolean; workers: VibeWorkerDto[] }> {
	const data = await call("vibeStatus", []);
	const root = asRecord(data);
	const field = root === null ? undefined : root.workers;
	const list = Array.isArray(data) ? data : Array.isArray(field) ? field : [];
	const workers: VibeWorkerDto[] = [];
	for (const row of list) {
		const coerced = coerceVibeWorker(row);
		if (coerced !== null) workers.push(coerced);
	}
	return {
		enabled: root === null ? false : (asBoolean(root.enabled) ?? false),
		workers,
	};
}

/** Spawn a vibe worker; rejects (throws to caller) on server failure. */
export function spawnVibeWorker(input: {
	cli: "fast" | "good";
	prompt: string;
	name?: string;
}): Promise<{ id: string; jobId: string }> {
	return call("vibeSpawn", [input]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { id: asString(r.id) ?? "", jobId: asString(r.jobId) ?? "" };
	});
}

/** Send a message to a vibe worker session; rejects (throws to caller) on failure. */
export function sendVibeWorker(input: { session: string; message: string }): Promise<unknown> {
	return call("vibeSend", [input]);
}

/** Wait for vibe workers; rejects (throws to caller) on failure. */
export function waitVibeWorkers(input: {
	sessions?: string[];
	timeoutMs?: number;
}): Promise<unknown> {
	return call("vibeWait", [input]);
}

/** Kill one vibe worker; rejects (throws to caller) on failure. */
export function killVibeWorker(id: string): Promise<unknown> {
	return call("vibeKill", [id]);
}

/** Kill all vibe workers; rejects (throws to caller) on failure. */
export function killAllVibeWorkers(): Promise<{ killed: number }> {
	return call("vibeKillAll", []).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { killed: asNumber(r.killed) ?? 0 };
	});
}

/** Rehydrate vibe workers; rejects (throws to caller) on failure. */
export function rehydrateVibeWorkers(): Promise<{ restored: number }> {
	return call("vibeRehydrate", []).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { restored: asNumber(r.restored) ?? 0 };
	});
}
