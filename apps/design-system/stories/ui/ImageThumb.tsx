import type { ImageArg } from "#lib/wire/protocol";
import { ImageThumb } from "../../../web/components/ui/ImageThumb";
import { ModalHost } from "../../../web/ModalHost";
import { openLightbox } from "../../../web/state";
import { chartScreenshot } from "../../fixtures/shared";
import { defineStory } from "../../registry";

const unresolved: ImageArg = {
	type: "image",
	data: `blob:sha256:${"ab".repeat(32)}`,
	mimeType: "image/webp",
};

export default defineStory({
	id: "ui-image-thumb",
	title: "ImageThumb",
	component: { file: "apps/web/components/ui/ImageThumb.tsx", export: "ImageThumb" },
	tabs: true,
	variants: [
		{
			name: "Resolved image",
			description: "Decodable data renders the thumbnail; click opens the lightbox.",
			render: () => (
				<>
					<ImageThumb image={chartScreenshot} alt="stats chart" onZoom={openLightbox} />
					<ModalHost />
				</>
			),
		},
		{
			name: "Unresolved blob ref",
			description:
				"A subagent transcript image still pointing at `blob:sha256:<hash>` (loading, too large, or gone) shows an [image] chip, never a broken <img>.",
			render: () => <ImageThumb image={unresolved} alt="stats chart" onZoom={openLightbox} />,
		},
	],
});
