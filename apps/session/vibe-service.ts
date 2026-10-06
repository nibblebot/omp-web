// Vibe director choreography mirrors SDK interactive mode. Worker operations
// execute SDK-created tools, retaining their real ToolSession and permissions.

import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VIBE_CLI_AGENT, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { VibeParentSession } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type {
	VibeCli,
	VibeScreenSnapshot,
	VibeSessionState,
	VibeToolDetails,
	VibeSendOutcome,
	VibeKillOutcome,
} from "@oh-my-pi/pi-tui/tools/vibe";
import type { SessionEntry } from "./session-entry";

export interface VibeWorkerDto {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	model?: string;
	turns: number;
	queued: number;
	lastActivity?: string;
	lastActivityAt: number;
	killed?: boolean;
	outputTail?: string[];
	trace?: string[];
}

function toDto(screen: VibeScreenSnapshot): VibeWorkerDto {
	return {
		id: screen.id,
		cli: screen.cli,
		state: screen.state,
		model: screen.model,
		turns: screen.turns,
		queued: screen.queued,
		lastActivity: screen.lastActivity,
		lastActivityAt: screen.lastActivityAt,
		killed: screen.killed,
		outputTail: [...screen.outputTail],
		trace: [...screen.trace],
	};
}

// Minimal VibeParentSession over the live AgentSession: owner scope (ownerId +
// parentSessionId + resolved parent file) plus persistence/rehydration access.
// Mirrors the TUI's #vibeParentSession (interactive-mode.ts).
function parentSession(entry: SessionEntry): VibeParentSession {
	const session = entry.session;
	return {
		getAgentId: () => session.getAgentId() ?? null,
		getSessionId: () => session.sessionManager.getSessionId(),
		getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
		sessionManager: session.sessionManager,
		asyncJobManager: session.asyncJobManager,
		settings: session.settings,
		getActiveModelString: () => undefined,
	};
}

export function getVibeState(entry: SessionEntry): { enabled: boolean } {
	const getVibe = entry.session.getVibeModeState;
	const enabled =
		typeof getVibe === "function" ? (getVibe.call(entry.session)?.enabled ?? false) : false;
	return { enabled };
}

/** Explicit consent is required for entry, but not for exiting or reconnecting. */
export async function setVibeMode(
	entry: SessionEntry,
	enabled: boolean,
	options?: { consent?: boolean },
): Promise<{ enabled: boolean }> {
	if (enabled && options?.consent !== true)
		throw new Error("Vibe director start requires explicit consent");
	await mutateMode(entry, async () => {
		if (enabled) await enterDirector(entry);
		else await exitDirector(entry);
	});
	return getVibeState(entry);
}

interface DirectorState {
	sessionId: string;
	previousTools?: string[];
	tail: Promise<void>;
}

const directors = new WeakMap<SessionEntry["session"], DirectorState>();

function directorState(entry: SessionEntry): DirectorState {
	const sessionId = entry.session.sessionManager.getSessionId();
	let state = directors.get(entry.session);
	if (!state || state.sessionId !== sessionId) {
		state = { sessionId, tail: Promise.resolve() };
		directors.set(entry.session, state);
	}
	return state;
}

async function mutateMode(entry: SessionEntry, change: () => Promise<void>): Promise<void> {
	const state = directorState(entry);
	const operation = state.tail.then(change);
	state.tail = operation.catch(() => {});
	await operation;
}

function persistedPreviousTools(entry: SessionEntry): string[] | undefined {
	const context = entry.session.sessionManager.buildSessionContext();
	const tools = context.mode === "vibe" ? context.modeData?.previousTools : undefined;
	return Array.isArray(tools) && tools.every((tool) => typeof tool === "string")
		? [...tools]
		: undefined;
}

async function enterDirector(entry: SessionEntry, reconnect = false): Promise<void> {
	const session = entry.session;
	const state = directorState(entry);
	if (getVibeState(entry).enabled && session.getToolForEvalBridge("vibe_spawn")) return;
	const context = session.sessionManager.buildSessionContext();
	if (
		session.getPlanModeState()?.enabled ||
		session.getPlanModeState()?.reentry ||
		context.mode === "plan" ||
		context.mode === "plan_paused"
	) {
		throw new Error("Exit plan mode before starting Vibe");
	}
	if (
		session.getGoalModeState()?.enabled ||
		context.mode === "goal" ||
		context.mode === "goal_paused"
	) {
		throw new Error("Exit goal mode before starting Vibe");
	}
	const previousTools =
		reconnect || context.mode === "vibe"
			? persistedPreviousTools(entry)
			: session.getEnabledToolNames();
	if (!previousTools) throw new Error("Persisted Vibe mode is missing its previous toolset");
	const registry = VibeSessionRegistry.global();
	registry.activateScope(registry.ownerScope(parentSession(entry)));
	const baseTools = ["read"];
	if (session.hasBuiltInTool("todo")) baseTools.push("todo");
	await session.activateVibeTools(baseTools);
	state.previousTools = previousTools;
	session.setVibeModeState({ enabled: true });
	if (!reconnect) session.sessionManager.appendModeChange("vibe", { previousTools });
	if (session.isStreaming) await session.sendVibeModeContext({ deliverAs: "steer" });
}

async function exitDirector(entry: SessionEntry): Promise<number> {
	if (
		!getVibeState(entry).enabled &&
		entry.session.sessionManager.buildSessionContext().mode !== "vibe"
	)
		return 0;
	const previousTools = directorState(entry).previousTools ?? persistedPreviousTools(entry);
	if (!previousTools) throw new Error("Persisted Vibe mode is missing its previous toolset");
	let killed = 0;
	await entry.session.runModeExitTeardown(async () => {
		if (entry.session.isStreaming) await entry.session.abort();
		killed = await VibeSessionRegistry.global().killAll(parentSession(entry));
		await entry.session.deactivateVibeTools(previousTools);
		entry.session.setVibeModeState(undefined);
	});
	directorState(entry).previousTools = undefined;
	return killed;
}

/**
 * Live screen snapshots for the TV-wall read model. Never throws: when the
 * scope cannot be resolved (no stable parent session id yet), returns the
 * empty roster with a reason.
 */
export async function listVibeWorkers(
	entry: SessionEntry,
): Promise<{ enabled: boolean; workers: VibeWorkerDto[]; reason?: string }> {
	const enabled = getVibeState(entry).enabled;
	try {
		const toolSession = parentSession(entry) as unknown as ToolSession;
		const screens = VibeSessionRegistry.global().screens(toolSession, undefined);
		return { enabled, workers: screens.map(toDto) };
	} catch {
		return { enabled, workers: [], reason: "vibe registry requires tool context" };
	}
}

async function executeVibeTool(
	entry: SessionEntry,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<VibeToolDetails> {
	await directorState(entry).tail;
	if (!getVibeState(entry).enabled)
		throw new Error("Start Vibe director mode before using worker tools");
	const tool = entry.session.getToolForEvalBridge(name);
	if (!tool) throw new Error(`Vibe tool ${name} is not enabled`);
	const id = `web-vibe-${crypto.randomUUID()}`;
	const parameters = validateToolArguments(tool, { type: "toolCall", id, name, arguments: args });
	// Vibe tools retain their SDK-created ToolSession and do not need an
	// AgentToolContext; the permission wrapper is still the normal SDK gate.
	const result = await tool.execute(id, parameters, signal);
	const details = result.details as VibeToolDetails | undefined;
	if (result.isError || !details) throw new Error(`Vibe tool ${name} failed`);
	return details;
}

function checkCli(cli: string): VibeCli {
	if (cli === "fast" || cli === "good") return cli;
	throw new Error(
		`unknown vibe cli "${cli}" (expected one of: ${Object.keys(VIBE_CLI_AGENT).join(", ")})`,
	);
}

export async function spawnVibeWorker(
	entry: SessionEntry,
	input: { cli: VibeCli; prompt: string; name?: string; consent?: boolean },
): Promise<{ id: string; jobId: string }> {
	checkCli(input.cli);
	if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
		throw new Error("prompt is required");
	}
	if (input.consent !== true) throw new Error("Vibe worker spawn requires explicit consent");
	const details = await executeVibeTool(entry, "vibe_spawn", {
		cli: input.cli,
		prompt: input.prompt,
		...(input.name !== undefined ? { name: input.name } : {}),
	});
	if (!details.spawned) throw new Error("Vibe spawn did not return a worker");
	return { id: details.spawned.id, jobId: details.spawned.jobId };
}

export async function sendVibeWorker(
	entry: SessionEntry,
	input: { session: string; message: string; consent?: boolean },
): Promise<VibeSendOutcome> {
	if (typeof input.message !== "string" || input.message.trim().length === 0) {
		throw new Error("message is required");
	}
	if (input.consent !== true) throw new Error("Vibe worker send requires explicit consent");
	const details = await executeVibeTool(entry, "vibe_send", {
		session: input.session,
		message: input.message,
	});
	if (!details.send) throw new Error("Vibe send did not return a delivery outcome");
	return details.send;
}

export async function waitVibeWorkers(
	entry: SessionEntry,
	input?: { sessions?: string[]; timeoutMs?: number; signal?: AbortSignal },
): Promise<NonNullable<VibeToolDetails["wait"]>> {
	const details = await executeVibeTool(
		entry,
		"vibe_wait",
		{
			...(input?.sessions !== undefined ? { sessions: input.sessions } : {}),
			...(input?.timeoutMs !== undefined ? { timeout: input.timeoutMs / 1000 } : {}),
		},
		input?.signal,
	);
	if (!details.wait) throw new Error("Vibe wait did not return an outcome");
	return details.wait;
}

export async function killVibeWorker(entry: SessionEntry, id: string): Promise<VibeKillOutcome> {
	const details = await executeVibeTool(entry, "vibe_kill", { session: id });
	if (!details.killed) throw new Error("Vibe kill did not return an outcome");
	return details.killed;
}

/**
 * Kill every worker and exit the director, restoring the previous toolset.
 * The SDK persists worker tombstones and mode exit together.
 */
export async function killAllVibeWorkers(entry: SessionEntry): Promise<{ killed: number }> {
	let killed = 0;
	await mutateMode(entry, async () => {
		killed = await exitDirector(entry);
	});
	return { killed };
}

/**
 * Reconnect recovery restores durable workers without restarting turns, and
 * restores the director toolset from the persisted mode's original snapshot.
 */
export async function rehydrateVibeWorkers(
	entry: SessionEntry,
): Promise<{ restored: number; reason?: string }> {
	let restored = 0;
	await mutateMode(entry, async () => {
		const registry = VibeSessionRegistry.global();
		restored = await registry.rehydrate(parentSession(entry));
		if (entry.session.sessionManager.buildSessionContext().mode === "vibe")
			await enterDirector(entry, true);
	});
	return { restored };
}
