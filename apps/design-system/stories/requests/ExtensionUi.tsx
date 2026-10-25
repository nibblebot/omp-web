import { ExtensionUi } from "../../../web/components/requests/ExtensionUi";
import { belowEditorRequest } from "../../fixtures/dialogs";
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
