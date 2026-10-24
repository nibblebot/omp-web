/**
 * Display helpers for subagent rows: the slice of the SDK's `AgentProgress`
 * the web renders, the model line, and the live tool line. Pure, so they stay
 * testable without a DOM.
 */

/** The `AgentProgress` fields the web keeps per subagent (see `pickProgress`). */
export interface SubagentProgressView {
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolIntent?: string;
	currentToolStartMs?: number;
	/** The newest finished tool call (the daemon's wire projection; no bulk history). */
	lastTool?: { tool: string; args?: string; intent?: string; isError?: boolean };
	/** The agent's latest stated intent, kept after its tool call finishes. */
	lastIntent?: string;
	/** The agent's current step in its own words, from its periodic completion probe; preferred over `lastIntent` while running. */
	stage?: string;
	/** `<provider>/<id>`, suffixed with `:<level>` when the level was set explicitly. */
	resolvedModel?: string;
	/** Provider/id including routing, with no thinking suffix. */
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: string;
	advisor?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Narrow a raw `progress` payload to the fields the web renders; undefined when it is not an object. */
export function pickProgress(raw: unknown): SubagentProgressView | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const p = raw as Record<string, unknown>;
	const last =
		typeof p.lastTool === "object" && p.lastTool !== null
			? (p.lastTool as Record<string, unknown>)
			: undefined;
	const tool = str(last?.tool);
	const lastTool =
		tool === undefined
			? undefined
			: { tool, args: str(last?.args), intent: str(last?.intent), isError: last?.isError === true };
	return {
		status: str(p.status),
		currentTool: str(p.currentTool),
		currentToolArgs: str(p.currentToolArgs),
		currentToolIntent: str(p.currentToolIntent),
		currentToolStartMs: typeof p.currentToolStartMs === "number" ? p.currentToolStartMs : undefined,
		lastTool,
		lastIntent: str(p.lastIntent),
		stage: str(p.stage),
		resolvedModel: str(p.resolvedModel),
		resolvedModelIdentity: str(p.resolvedModelIdentity),
		resolvedThinkingLevel: str(p.resolvedThinkingLevel),
		advisor: p.advisor === true ? true : undefined,
	};
}

// ---------------------------------------------------------------------------
// Model line
// ---------------------------------------------------------------------------

/** What a row shows for the model a subagent resolved to. */
export interface SubagentModelView {
	/** Model id without provider or `:level` suffix, e.g. `claude-sonnet-5-5`. */
	id: string;
	/** Full `provider/id` (no `:level` suffix), for tooltips. */
	identity: string;
	/** Explicit thinking level (`high`); undefined when inherited or unset. */
	thinking?: string;
}

/** Levels a `:level` suffix may carry. Any other colon belongs to the model id (`llama3:8b`). */
const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
	inherit: true,
};

/**
 * The model of a subagent from its live progress: `resolvedModelIdentity`, else `resolvedModel`.
 * The thinking level is `resolvedThinkingLevel`, else the `:level` suffix of the raw string.
 * Undefined when the model is unknown.
 */
export function modelView(
	progress: SubagentProgressView | undefined,
): SubagentModelView | undefined {
	const raw = (progress?.resolvedModelIdentity ?? progress?.resolvedModel)
		// eslint-disable-next-line no-control-regex
		?.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!raw) return undefined;
	const colon = raw.lastIndexOf(":");
	const suffix = colon > 0 ? raw.slice(colon + 1) : undefined;
	const hasLevel = suffix !== undefined && THINKING_LEVELS[suffix] === true;
	const identity = hasLevel ? raw.slice(0, colon) : raw;
	const id = identity.slice(identity.lastIndexOf("/") + 1);
	if (id === "") return undefined;
	const level = progress?.resolvedThinkingLevel ?? (hasLevel ? suffix : undefined);
	return { id, identity, thinking: level && level !== "inherit" ? level : undefined };
}

// ---------------------------------------------------------------------------
// Live line
// ---------------------------------------------------------------------------

/** The live line of a running subagent: its stage, and/or a tool and an intent; never arguments. */
export interface SubagentLiveLine {
	/** The agent's current step in its own words; replaces the intent in the formatted line. */
	stage?: string;
	tool?: string;
	intent?: string;
	isError?: boolean;
}

function toolLiveLine(progress: SubagentProgressView): SubagentLiveLine | undefined {
	if (progress.currentTool !== undefined) {
		return { tool: progress.currentTool, intent: progress.currentToolIntent };
	}
	if (progress.lastTool !== undefined) {
		return {
			tool: progress.lastTool.tool,
			intent: progress.lastTool.intent,
			isError: progress.lastTool.isError === true ? true : undefined,
		};
	}
	if (progress.lastIntent !== undefined) return { intent: progress.lastIntent };
	return undefined;
}

/**
 * Precedence: the in-flight tool with its intent; else the last finished tool with its intent
 * (flagged when it errored); else the last intent alone; else nothing. A stage rides along
 * and, in the formatted line, takes the intent's place.
 */
export function liveLineOf(
	progress: SubagentProgressView | undefined,
): SubagentLiveLine | undefined {
	if (!progress) return undefined;
	const live = toolLiveLine(progress);
	return progress.stage === undefined ? live : { ...live, stage: progress.stage };
}

/** `stage · tool` when the agent reported a stage, else `tool · intent`, skipping whichever part is missing. */
export function formatLiveLine(live: SubagentLiveLine): string {
	const parts = live.stage === undefined ? [live.tool, live.intent] : [live.stage, live.tool];
	return parts.filter((part) => part !== undefined && part !== "").join(" · ");
}
