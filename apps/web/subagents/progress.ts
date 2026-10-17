/**
 * Display helpers for subagent rows: the slice of the SDK's `AgentProgress`
 * the web renders and the resolved-model badge. Pure, so the setting that
 * drives the badge (`task.showResolvedModelBadge`) stays testable without a DOM.
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
		resolvedModel: str(p.resolvedModel),
		resolvedModelIdentity: str(p.resolvedModelIdentity),
		resolvedThinkingLevel: str(p.resolvedThinkingLevel),
		advisor: p.advisor === true ? true : undefined,
	};
}

// ---------------------------------------------------------------------------

// task.showResolvedModelBadge
// ---------------------------------------------------------------------------

export interface ModelBadge {
	/** Sanitized model identity, e.g. `anthropic/claude-sonnet-5-5`. */
	model: string;
	/** Explicit thinking level (`high`); undefined when inherited or unset. */
	thinking?: string;
	advisor: boolean;
}

/** The badge for a subagent's resolved model; undefined when the model could not be resolved. */
export function modelBadge(progress: SubagentProgressView | undefined): ModelBadge | undefined {
	const raw = progress?.resolvedModelIdentity ?? progress?.resolvedModel;
	const model = raw
		// eslint-disable-next-line no-control-regex
		?.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!model) return undefined;
	const level = progress?.resolvedThinkingLevel;
	return {
		model,
		thinking: level && level !== "inherit" ? level : undefined,
		advisor: progress?.advisor === true,
	};
}
