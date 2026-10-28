import { ShimmerText } from "../../../web/components/ui/ShimmerText";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-shimmer-text",
	title: "ShimmerText",
	component: { file: "apps/web/components/ui/ShimmerText.tsx", export: "ShimmerText" },
	variants: [
		{
			name: "Sweep",
			description:
				"The default look: a highlight band sweeps across the label. It moves by transform only, so it costs no main-thread paint. Reduced motion shows the plain label.",
			render: () => (
				<div class="ds-frame">
					<ShimmerText text="Working on the failing test…" />
				</div>
			),
		},
		{
			name: "Scanner",
			description:
				"`display.shimmer` set to kitt: a narrow band travels back and forth inside the label.",
			render: () => (
				<div class="ds-frame" data-shimmer="kitt">
					<ShimmerText text="Working on the failing test…" />
				</div>
			),
		},
		{
			name: "Off",
			description: "`display.shimmer` set to disabled: the label holds still.",
			render: () => (
				<div class="ds-frame" data-shimmer="disabled">
					<ShimmerText text="Working on the failing test…" />
				</div>
			),
		},
		{
			name: "Truncated",
			description:
				"A label wider than its box ends in an ellipsis; the highlight copy truncates the same way.",
			render: () => (
				<div class="ds-frame" style={{ width: "140px" }}>
					<ShimmerText text="Working on the failing test in the parser…" />
				</div>
			),
		},
		{
			name: "Empty",
			description: "No text, no highlight copy and no running animation.",
			render: () => (
				<div class="ds-frame">
					<ShimmerText text="" />
				</div>
			),
		},
	],
});
