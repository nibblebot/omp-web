import { ModelPresetPopover } from "../../../../web/components/chat/status/ModelPresetPopover";
import { PopoverAnchor } from "../../../fixtures/popover-anchor";
import { defineStory } from "../../../registry";

const TRIGGER = "segment segment-button preset-segment";

export default defineStory({
	id: "chat-status-model-preset-popover",
	title: "ModelPresetPopover",
	component: {
		file: "apps/web/components/chat/status/ModelPresetPopover.tsx",
		export: "ModelPresetPopover",
	},
	// Fixed-position surfaces from several variants would stack over each other.
	tabs: true,
	variants: [
		{
			name: "Active preset",
			description:
				"Every saved preset with the active one checked; a pick applies it and closes the dropdown. 'Manage presets…' opens the Models dialog on its Presets tab.",
			seed: {
				modelPresets: { names: ["fast", "review-heavy", "scratch"], active: "review-heavy" },
			},
			render: () => (
				<PopoverAnchor
					label="review-heavy"
					x="start"
					class={TRIGGER}
					popover={ModelPresetPopover}
				/>
			),
		},
		{
			name: "Custom roles",
			description:
				"Presets exist but the current roles match none: nothing is checked and the chip reads 'custom'.",
			seed: { modelPresets: { names: ["fast", "review-heavy"] } },
			render: () => (
				<PopoverAnchor label="custom" x="start" class={TRIGGER} popover={ModelPresetPopover} />
			),
		},
		{
			name: "No presets",
			description:
				"Nothing saved yet: the chip reads 'presets' and the dropdown only offers 'Manage presets…'.",
			seed: { modelPresets: undefined },
			render: () => (
				<PopoverAnchor label="presets" x="start" class={TRIGGER} popover={ModelPresetPopover} />
			),
		},
	],
});
