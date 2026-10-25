import { DownloadDialog } from "../../../web/components/requests/DownloadDialog";
import { openDownloadConsent } from "../../../web/store/downloads";
import { downloadManifest } from "../../fixtures/overlays";
import { answerCalls } from "../../session";
import { defineStory } from "../../registry";

export default [
	defineStory({
		id: "requests-download-dialog",
		title: "DownloadDialog",
		component: {
			file: "apps/web/components/requests/DownloadDialog.tsx",
			export: "DownloadDialog",
		},
		tabs: true,
		variants: [
			{
				name: "Reading the manifest",
				seed: () => {
					answerCalls({ downloadManifest: () => new Promise<never>(() => {}) });
					void openDownloadConsent("html");
				},
				render: () => <DownloadDialog />,
			},
			{
				name: "Consent: archive with BTW",
				seed: () => {
					answerCalls({ downloadManifest: () => downloadManifest });
					void openDownloadConsent("archive", { includeBtw: true });
				},
				render: () => <DownloadDialog />,
			},
			{
				name: "Consent: themed HTML",
				seed: () => {
					answerCalls({ downloadManifest: () => downloadManifest });
					void openDownloadConsent("html-themed");
				},
				render: () => <DownloadDialog />,
			},
			{
				name: "Manifest failed",
				seed: () => {
					answerCalls({
						downloadManifest: () => {
							throw new Error("No session is attached, so there is nothing to download.");
						},
					});
					void openDownloadConsent("text");
				},
				render: () => <DownloadDialog />,
			},
		],
	}),
];
