import type { SettingsItem, SettingsModel } from "#lib/wire/protocol";
import { setState, state } from "../../web/state";
import { answerCalls } from "../session";
import { settingsCalls } from "./settings";

/**
 * The SDK display settings the Appearance sheet owns (APPEARANCE_SDK_SETTINGS), with the
 * labels, descriptions and defaults the SDK ships, so the sheet renders real rows.
 */
const flag = (path: string, label: string, description: string, value: boolean): SettingsItem => ({
	path,
	label,
	description,
	type: "boolean",
	value,
	changed: false,
});

const sdkItems: SettingsItem[] = [
	flag(
		"hideThinkingBlock",
		"Hide Thinking Blocks",
		"Hide thinking blocks in assistant responses",
		false,
	),
	flag(
		"expandThinkingBlocks",
		"Expand Thinking Blocks",
		"Keep finished thinking blocks expanded instead of collapsing them when the turn ends",
		false,
	),
	flag(
		"proseOnlyThinking",
		"Prose Only Thinking",
		"Omit code blocks from thinking summaries and replace them with an ellipsis",
		true,
	),
	flag(
		"display.hideToolActivity",
		"Hide Tool Activity",
		"Hide model-initiated tool calls and results from the transcript",
		false,
	),
	flag("terminal.showImages", "Show Inline Images", "Render images inline in the terminal", true),
	flag(
		"display.showTokenUsage",
		"Show Token Usage",
		"Show per-turn token usage on assistant messages",
		false,
	),
	flag(
		"display.showTurnTime",
		"Show Turn Time",
		"Show the total prompt-to-yield time (including tool calls) on assistant message usage rows",
		false,
	),
	flag(
		"display.cacheMissMarker",
		"Cache Miss Marker",
		"Show a divider after an assistant turn whose request lost (missed) the prompt cache",
		false,
	),
	flag(
		"display.smoothStreaming",
		"Smooth Streaming",
		"Reveal assistant text and streamed tool input smoothly while chunks arrive",
		true,
	),
	{
		path: "display.shimmer",
		label: "Shimmer",
		description: "Animation style for working/loading messages",
		type: "submenu",
		value: "classic",
		changed: false,
		options: [
			{
				value: "classic",
				label: "Classic",
				description: "Soft cosine wave sweeping across the text",
			},
			{
				value: "kitt",
				label: "KITT Scanner",
				description: "Knight Rider 1982 red light bouncing left-right",
			},
			{ value: "disabled", label: "Disabled", description: "No animation; static muted text" },
		],
	},
];

/** A fresh settings model holding every Appearance sheet SDK row at its default. */
export function appearanceSettingsModel(): SettingsModel {
	return {
		revision: 1,
		target: "current-session",
		tabs: [
			{
				id: "appearance",
				label: "Appearance",
				groups: [{ name: "Display", items: structuredClone(sdkItems) }],
			},
		],
	};
}

/**
 * Attach a session (unless the story already has one) whose settings model carries the Appearance
 * sheet's SDK rows; writes stick (`settingsCalls`).
 */
export function seedAppearanceSettings(): void {
	const model = appearanceSettingsModel();
	if (state.currentWorkspaceId === "") setState("currentWorkspaceId", "sess_09a41c");
	setState("settingsModel", model);
	answerCalls(settingsCalls(model));
}
