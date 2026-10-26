import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ThinkingLevelPopover } from "../../../../web/components/chat/status/ThinkingLevelPopover";
import { sessionModel } from "../../../fixtures/overlays";
import { PopoverAnchor } from "../../../fixtures/popover-anchor";
import { defineStory } from "../../../registry";

const thinkingLadder = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TRIGGER = "segment segment-button thinking-segment";

export default defineStory({
	id: "chat-status-thinking-level-popover",
	title: "ThinkingLevelPopover",
	component: {
		file: "apps/web/components/chat/status/ThinkingLevelPopover.tsx",
		export: "ThinkingLevelPopover",
	},
	// Fixed-position surfaces from several variants would stack over each other.
	tabs: true,
	variants: [
		{
			name: "Medium selected",
			description:
				"The levels the model supports, the current one checked, with its place on the ladder above (4 of 6). Arrow keys move, Enter picks, Escape closes and returns focus to the chip.",
			seed: {
				currentWorkspaceId: "sess_09a41c",
				model: sessionModel,
				thinkingSelectors: thinkingLadder,
				thinkingLevel: "medium" as Effort,
			},
			render: () => (
				<PopoverAnchor label="medium" x="start" class={TRIGGER} popover={ThinkingLevelPopover} />
			),
		},
		{
			name: "Auto thinking",
			description: "Auto thinking is current: the auto selector is checked.",
			seed: {
				currentWorkspaceId: "sess_09a41c",
				model: sessionModel,
				thinkingSelectors: ["auto", ...thinkingLadder],
				autoThinking: true,
			},
			render: () => (
				<PopoverAnchor label="auto" x="start" class={TRIGGER} popover={ThinkingLevelPopover} />
			),
		},
		{
			name: "Model without thinking levels",
			description: "A model that does not reason has nothing to pick: the dropdown says so.",
			seed: {
				currentWorkspaceId: "sess_09a41c",
				model: sessionModel,
				thinkingSelectors: [],
			},
			render: () => (
				<PopoverAnchor label="inherit" x="start" class={TRIGGER} popover={ThinkingLevelPopover} />
			),
		},
	],
});
