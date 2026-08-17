/** One row of the step-3 thinking picker. */
export interface ThinkingOption {
	/** Wire value passed to setModelRole's thinkingLevel arg ("" = omit entirely). */
	value: string;
	label: string;
	/** TUI metadata description, rendered dim beside the label. */
	hint?: string;
}

/**
 * TUI label parity (THINKING_LEVEL_METADATA in the SDK's src/thinking.ts):
 * minimal renders as "min"; every other level is its own wire value.
 */
export function thinkingLevelLabel(level: string): string {
	return level === "minimal" ? "min" : level;
}

/** TUI descriptions for the two non-effort selectors (src/thinking.ts metadata). */
const THINKING_HINTS: Record<string, string> = {
	inherit: "Inherit session default",
	off: "No reasoning",
};

/**
 * Thinking options for a model that exposes a controllable effort surface:
 * "inherit" (defer to the session thinking level) and "off" first, then the
 * model's own efforts in catalog order — all with TUI labels. Empty for
 * models without a surface — callers then skip step 3 and assign without a level.
 */
export function thinkingOptions(efforts: readonly string[] | undefined): ThinkingOption[] {
	if (!efforts || efforts.length === 0) return [];
	return [
		{ value: "inherit", label: "inherit", hint: THINKING_HINTS.inherit },
		{ value: "off", label: "off", hint: THINKING_HINTS.off },
		...efforts.map((e) => ({ value: e, label: thinkingLevelLabel(e) })),
	];
}

/** Compact context-window label for model rows, e.g. "ctx 128k" / "ctx 1.2M". */
export function formatCtx(tokens: number | null | undefined): string | undefined {
	if (!tokens || tokens <= 0) return undefined;
	if (tokens >= 1_000_000) return `ctx ${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	return `ctx ${Math.round(tokens / 1000)}k`;
}
