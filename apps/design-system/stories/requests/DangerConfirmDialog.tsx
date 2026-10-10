import { DangerConfirmDialog } from "../../../web/components/requests/DangerConfirmDialog";
import { requestDangerConfirm } from "../../../web/prompt/danger-confirm";
import { dangerSamples } from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

export default defineStory({
	id: "requests-danger-confirm-dialog",
	title: "DangerConfirmDialog",
	component: {
		file: "apps/web/components/requests/DangerConfirmDialog.tsx",
		export: "DangerConfirmDialog",
	},
	tabs: true,
	variants: dangerSamples.map((sample) => ({
		name: sample.title,
		seed: () => requestDangerConfirm({ ...sample, onConfirm: () => {} }),
		render: () => <DangerConfirmDialog />,
	})),
});
