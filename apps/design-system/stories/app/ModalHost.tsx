import { ModalHost } from "../../../web/ModalHost";
import { setState } from "../../../web/state";
import { openDownloadConsent } from "../../../web/store/downloads";
import { openResumePicker } from "../../../web/store/resume";
import { pushToast } from "../../../web/store/toasts";
import { answerCalls } from "../../daemon";
import { btwAnswered } from "../../fixtures/dialogs";
import {
	askUiRequest,
	browserUiRequests,
	downloadManifest,
	foreignSessionPreviews,
	resumeCandidates,
} from "../../fixtures/overlays";
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
			name: "Agent ask request",
			description: "`state.uiRequest` set by an agent ask: AskDialog renders the questions.",
			seed: () => setState("uiRequest", askUiRequest),
			render: () => <ModalHost />,
		},
		{
			name: "/btw side question",
			description: "`state.btw` holds an answered side question: BtwPanel opens as a sheet.",
			seed: { btw: btwAnswered },
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
			description: "openResumePicker(): ResumePicker lists resumable and importable sessions.",
			seed: () => {
				answerCalls({
					resumeList: () => ({ candidates: resumeCandidates }),
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
