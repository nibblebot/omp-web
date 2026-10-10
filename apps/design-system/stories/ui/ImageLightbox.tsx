import { ImageLightbox } from "../../../web/components/ui/ImageLightbox";
import { chartScreenshot, terminalScreenshot } from "../../fixtures/shared";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-image-lightbox",
	title: "ImageLightbox",
	component: { file: "apps/web/components/ui/ImageLightbox.tsx", export: "ImageLightbox" },
	tabs: true,
	variants: [
		{
			name: "Terminal screenshot",
			description:
				"Full-size preview of a failing type-check run. Portals to the body above the nav.",
			render: () => <ImageLightbox image={terminalScreenshot} onClose={() => undefined} />,
		},
		{
			name: "Chart screenshot",
			description: "Full-size preview of tokens per session over the last seven days.",
			render: () => <ImageLightbox image={chartScreenshot} onClose={() => undefined} />,
		},
	],
});
