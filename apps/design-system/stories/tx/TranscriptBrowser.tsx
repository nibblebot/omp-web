import { TranscriptBrowser } from "../../../web/tx/TranscriptBrowser";
import { defineStory } from "../../registry";

// The app shows this view only in Analysis, so its MainHeader toggle targets txSidebarVisible.
export default defineStory({
	id: "tx-transcript-browser",
	title: "TranscriptBrowser",
	component: { file: "apps/web/tx/TranscriptBrowser.tsx", export: "TranscriptBrowser" },
	variants: [
		{
			name: "Sidebar open",
			seed: { view: "analysis", txSidebarVisible: true },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<TranscriptBrowser />
				</div>
			),
		},
		{
			name: "Sidebar collapsed",
			seed: { view: "analysis", txSidebarVisible: false },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<TranscriptBrowser />
				</div>
			),
		},
	],
});
