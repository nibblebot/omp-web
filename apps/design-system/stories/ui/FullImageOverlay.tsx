import { FullImageOverlay } from "../../../web/components/ui/ImageThumbnails";
import { chartScreenshot, terminalScreenshot } from "../../fixtures/shared";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-full-image-overlay",
	title: "FullImageOverlay",
	component: { file: "apps/web/components/ui/ImageThumbnails.tsx", export: "FullImageOverlay" },
	tabs: true,
	variants: [
		{
			name: "Terminal screenshot",
			description:
				"Full-size preview of a failing type-check run. Portals to the body above the nav.",
			render: () => <FullImageOverlay image={terminalScreenshot} onClose={() => undefined} />,
		},
		{
			name: "Chart screenshot",
			description: "Full-size preview of tokens per session over the last seven days.",
			render: () => <FullImageOverlay image={chartScreenshot} onClose={() => undefined} />,
		},
	],
});
