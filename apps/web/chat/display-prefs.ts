import { settingValue } from "../store/settings";

/**
 * Transcript display preferences, read from the SDK settings model through
 * `settingValue`. Every getter is reactive when called inside a tracking
 * scope (JSX, createMemo, createEffect), so a toggle changes the surface
 * without a reload. Fallbacks are the SDK registry defaults (modes/settings.ts
 * and session/settings.ts), applied until the model loads and in fixture
 * surfaces with no model.
 */
const flag = (path: string, fallback: boolean): boolean => {
	const v = settingValue<boolean>(path);
	return typeof v === "boolean" ? v : fallback;
};

/** hideThinkingBlock: omit thinking blocks from assistant messages. */
export const hideThinkingBlock = (): boolean => flag("hideThinkingBlock", false);
/** expandThinkingBlocks: keep finished thinking blocks open instead of collapsed. */
export const expandThinkingBlocks = (): boolean => flag("expandThinkingBlocks", false);
/** proseOnlyThinking: elide fenced code in thinking with an ellipsis. */
export const proseOnlyThinking = (): boolean => flag("proseOnlyThinking", true);
/** display.hideToolActivity: hide model-initiated tool calls and results. */
export const hideToolActivity = (): boolean => flag("display.hideToolActivity", false);
/** display.showTokenUsage: per-turn usage row under assistant messages. */
export const showTokenUsage = (): boolean => flag("display.showTokenUsage", false);
/** display.showTurnTime: prompt-to-completion time on the usage row. */
export const showTurnTime = (): boolean => flag("display.showTurnTime", false);
/** display.cacheMissMarker: divider after a turn that lost the prompt cache. */
export const cacheMissMarker = (): boolean => flag("display.cacheMissMarker", false);
/** display.shellVisualization: offer the execution visualization on bash cards (the TUI draws bash calls as it by default). */
export const shellVisualization = (): boolean => flag("display.shellVisualization", true);
/** terminal.showImages: render tool-result images inline. */
export const showImages = (): boolean => flag("terminal.showImages", true);
/** display.smoothStreaming: paced reveal of streamed assistant text. */
export const smoothStreaming = (): boolean => flag("display.smoothStreaming", true);

export type ShimmerMode = "classic" | "kitt" | "disabled";
/** display.shimmer: animation style for the working label. */
export const shimmerMode = (): ShimmerMode => {
	const v = settingValue<string>("display.shimmer");
	return v === "kitt" || v === "disabled" ? v : "classic";
};
