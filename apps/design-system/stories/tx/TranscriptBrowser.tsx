import { TranscriptBrowser } from "../../../web/tx/TranscriptBrowser";
import { closeResumeClone } from "../../../web/tx/components/ResumeCloneDialog";
import { defineStory } from "../../registry";

// TranscriptBrowser mounts ResumeCloneDialog itself, and that dialog's open target is
// module state. Clear it so a resume dialog opened by another story never shows here.
export default defineStory({
	id: "tx-transcript-browser",
	title: "TranscriptBrowser",
	component: { file: "apps/web/tx/TranscriptBrowser.tsx", export: "TranscriptBrowser" },
	seed: () => closeResumeClone(),
	variants: [
		{
			name: "Sidebar open",
			seed: { txSidebarVisible: true },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<TranscriptBrowser />
				</div>
			),
		},
		{
			name: "Sidebar collapsed",
			seed: { txSidebarVisible: false },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<TranscriptBrowser />
				</div>
			),
		},
	],
});
