import { ExtensionUi } from "../../../web/components/requests/ExtensionUi";
import { setState } from "../../../web/state";
import { setStatusBarHidden } from "../../../web/store/browser-ui";
import { belowEditorRequest, statusBarRequest } from "../../fixtures/dialogs";
import { browserUiRequestFailed, browserUiRequests } from "../../fixtures/overlays";
import { defineStory } from "../../registry";

export default defineStory({
	id: "requests-extension-ui",
	title: "ExtensionUi",
	component: {
		file: "apps/web/components/requests/ExtensionUi.tsx",
		export: "ExtensionUi",
	},
	tabs: true,
	variants: [
		{
			name: "Modal review summary",
			seed: { browserUi: { requests: browserUiRequests, error: null } },
			render: () => <ExtensionUi />,
		},
		{
			name: "Below editor widget",
			seed: { browserUi: { requests: [belowEditorRequest], error: null } },
			render: () => <ExtensionUi placement="belowEditor" />,
		},
		{
			name: "Status bar",
			description:
				"An extension's status line. The Plugins tab's Status Bars toggle stops drawing it in this browser.",
			// That choice lives outside the store, so a re-seed shows the bar again.
			seed: () => {
				setStatusBarHidden(statusBarRequest.contribution.id, false);
				setState("browserUi", { requests: [statusBarRequest], error: null });
			},
			render: () => <ExtensionUi placement="belowEditor" />,
		},
		{
			name: "Action failed",
			seed: { browserUi: { requests: [browserUiRequestFailed], error: null } },
			render: () => <ExtensionUi />,
		},
		{
			name: "Answer rejected offline",
			seed: {
				browserUi: {
					requests: [belowEditorRequest],
					error: "Could not answer checks.summary: the session process is not connected.",
				},
			},
			render: () => <ExtensionUi placement="belowEditor" />,
		},
	],
});
