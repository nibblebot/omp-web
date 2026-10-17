/**
 * Display helpers for the pinned subagent list: the slice of the SDK's
 * `AgentProgress` the web renders, the pinned layout, the live-preview row and
 * the resolved-model badge. Pure, so the settings that drive them
 * (`display.pinnedAgents`, `display.subagentLivePreview`,
 * `task.showResolvedModelBadge`) stay testable without a DOM.
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
// display.pinnedAgents
// ---------------------------------------------------------------------------

export type PinnedAgentsMode = "off" | "collapsed" | "full";

/** The SDK default (`display.pinnedAgents`), used until the settings model loads. */
export const DEFAULT_PINNED_AGENTS: PinnedAgentsMode = "collapsed";

/** Rows the collapsed pinned list shows before its expander (the SDK's SUBAGENT_HUD_COLLAPSED_LIMIT). */
export const PINNED_COLLAPSED_LIMIT = 3;

export function pinnedAgentsMode(value: unknown): PinnedAgentsMode {
	return value === "off" || value === "collapsed" || value === "full"
		? value
		: DEFAULT_PINNED_AGENTS;
}

export interface PinnedLayout {
	/** How many subagent rows to list. */
	rows: number;
	/** The extra row: expand (hidden agents), collapse (list is expanded), or none (all fit). */
	toggle?: "expand" | "collapse";
}

/**
 * Pinned list layout: at most `PINNED_COLLAPSED_LIMIT` rows collapsed, with an
 * expander; every row expanded, with a collapse row. `expanded` is true when the
 * list is expanded (the user's toggle, or `full` mode).
 */
export function layoutPinned(total: number, expanded: boolean): PinnedLayout {
	if (total <= PINNED_COLLAPSED_LIMIT) return { rows: total };
	return expanded
		? { rows: total, toggle: "collapse" }
		: { rows: PINNED_COLLAPSED_LIMIT, toggle: "expand" };
}

// ---------------------------------------------------------------------------
// display.subagentLivePreview
// ---------------------------------------------------------------------------

/** A running call earns an elapsed marker once it outlasts this (the SDK's SUBAGENT_PREVIEW_ELAPSED_MIN_MS). */
export const PREVIEW_ELAPSED_MIN_MS = 5000;

export interface ToolPreview {
	tool: string;
	/** The call's own intent, else its args; never an earlier call's intent. */
	detail?: string;
	/** True while the call is in flight; false for the most recent finished call. */
	running: boolean;
	/** Finished call ended in error. */
	isError: boolean;
	/** `currentToolStartMs`, only for a running call. */
	startedAt?: number;
}

/** The current (or, between calls, most recent) tool call of a running subagent; undefined before its first call. */
export function toolPreview(progress: SubagentProgressView | undefined): ToolPreview | undefined {
	if (progress?.status !== "running") return undefined;
	const recent = progress.lastTool;
	const running = progress.currentTool !== undefined;
	const tool = progress.currentTool ?? recent?.tool;
	if (!tool) return undefined;
	const intent = running ? progress.currentToolIntent : recent?.intent;
	const args = running ? progress.currentToolArgs : recent?.args;
	const detail = intent ?? args;
	return {
		tool,
		detail: detail
			? detail
					.replace(/\s*[\r\n]+\s*/g, " ↵ ")
					.replace(/\t/g, " ")
					.trim()
			: undefined,
		running,
		isError: !running && recent?.isError === true,
		startedAt: running ? progress.currentToolStartMs : undefined,
	};
}

/** Elapsed marker (`12s`, `1m05s`) for a running call past `PREVIEW_ELAPSED_MIN_MS`; undefined otherwise. */
export function elapsedLabel(startedAt: number | undefined, now: number): string | undefined {
	if (startedAt === undefined) return undefined;
	const ms = now - startedAt;
	if (ms <= PREVIEW_ELAPSED_MIN_MS) return undefined;
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
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
	// eslint-disable-next-line no-control-regex
	const model = raw
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
