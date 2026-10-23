import { ModalHost } from "../../../web/ModalHost";
import { setState } from "../../../web/state";
import { openDownloadConsent } from "../../../web/store/downloads";
import { openResumePicker } from "../../../web/store/resume";
import { pushToast } from "../../../web/store/toasts";
import { answerCalls } from "../../daemon";
import { answerBtwHistory, btwAnswered } from "../../fixtures/dialogs";
import {
	browserUiRequests,
	downloadManifest,
	foreignSessionPreviews,
	resumeListReply,
} from "../../fixtures/overlays";
import { rosterDaemon, rosterFleetState } from "../../fixtures/roster";
import { chartScreenshot } from "../../fixtures/shared";
import { extensionCalls } from "../../fixtures/extensions";
import { defineStory } from "../../registry";

/**
 * ModalHost mounts every overlay App shows: one renderer per `state.modal`
 * value, plus dialogs that render once their own store state asks for them.
 * Each variant opens one of them through the real store state or action.
 */
export default defineStory({
	id: "app-modal-host",
	title: "ModalHost",
	component: { file: "apps/web/ModalHost.tsx", export: "ModalHost" },
	tabs: true,
	seed: { currentSessionId: "sess_09a41c" },
	variants: [
		{
			name: "state.modal: help",
			description: "A registry modal: `state.modal` names it and ModalHost renders it.",
			seed: { modal: "help" },
			render: () => <ModalHost />,
		},
		{
			name: "Extensions",
			description:
				'`state.modal` is "integrations" (/mcp, /skills): the Extensions dialog lists skills and MCP servers, plus a Plugins tab while the plugins feature is on.',
			seed: () => {
				answerCalls(extensionCalls());
				setState("modal", "integrations");
			},
			render: () => <ModalHost />,
		},
		{
			name: "Daemon details",
			description:
				"`state.daemonDetailsId` names a roster daemon: DaemonDetailsDialog renders while that daemon is in the roster.",
			seed: { ...rosterFleetState, daemonDetailsId: rosterDaemon.main.daemonId },
			render: () => <ModalHost />,
		},
		{
			name: "Image lightbox",
			description:
				"`state.lightboxImage` set by a thumbnail click: ImageLightbox shows it full size.",
			seed: { lightboxImage: chartScreenshot },
			render: () => <ModalHost />,
		},
		{
			name: "/btw side question",
			description:
				'`state.modal` is "btw" with an answered side question: BtwSheet opens as a sheet.',
			seed: () => {
				answerBtwHistory();
				setState("btw", btwAnswered);
				setState("modal", "btw");
			},
			render: () => <ModalHost />,
		},
		{
			name: "Extension UI modal",
			description: "A browser_ui contribution placed as a modal: ExtensionUi shows the first.",
			seed: { browserUi: { requests: browserUiRequests, error: null } },
			render: () => <ModalHost />,
		},
		{
			name: "Resume picker",
			description:
				"openResumePicker(): ResumePicker resolves a session by id or path and offers Claude/Codex imports.",
			seed: () => {
				answerCalls({
					resumeList: () => resumeListReply,
					foreignList: () => ({ sessions: foreignSessionPreviews }),
				});
				openResumePicker();
			},
			render: () => <ModalHost />,
		},
		{
			name: "Download consent",
			description: "openDownloadConsent(): DownloadDialog asks before exporting the session.",
			seed: () => {
				answerCalls({ downloadManifest: () => downloadManifest });
				void openDownloadConsent("archive", { includeBtw: true });
			},
			render: () => <ModalHost />,
		},
		{
			name: "Toast",
			description: "pushToast(): Toasts stacks notices in the corner.",
			seed: () => pushToast("Session saved to .omp/sessions/sess_09a41c.jsonl"),
			render: () => (
				<div class="ds-frame">
					<ModalHost />
				</div>
			),
		},
	],
});
