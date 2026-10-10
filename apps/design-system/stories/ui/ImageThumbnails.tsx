import { ImageThumbnails } from "../../../web/components/ui/ImageThumbnails";
import { chartScreenshot, terminalScreenshot } from "../../fixtures/shared";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-image-thumbnails",
	title: "ImageThumbnails",
	component: { file: "apps/web/components/ui/ImageThumbnails.tsx", export: "ImageThumbnails" },
	tabs: true,
	variants: [
		{
			name: "Two screenshots",
			description:
				"Thumbnails for a tool result with two images. Click one to open the full-size overlay.",
			render: () => <ImageThumbnails images={[terminalScreenshot, chartScreenshot]} />,
		},
		{
			name: "One screenshot",
			description: "A single stats chart attached to an analysis message.",
			render: () => <ImageThumbnails images={[chartScreenshot]} />,
		},
		{
			name: "No images",
			description: "undefined renders nothing, as for a tool result with text only.",
			render: () => <ImageThumbnails images={undefined} />,
		},
	],
});
