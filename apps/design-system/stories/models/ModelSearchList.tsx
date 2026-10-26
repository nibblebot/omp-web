import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { ModelSearchList } from "../../../web/components/models/ModelSearchList";
import { seedRecentModels } from "../../../web/store/models";
import { modelInfos, sessionModel } from "../../fixtures/overlays";
import { defineStory } from "../../registry";
import { setState } from "../../../web/state";

/** Browser rows: every fixture model usable, except row 3 locked to show the disabled state. */
const browserEntries: ModelBrowserEntry[] = modelInfos.map((model, index) =>
	index === 3 ? { ...model, locked: "credentials" } : model,
);
const recentSelectors = modelInfos.slice(1, 3).map((model) => `${model.provider}/${model.id}`);
const accept = async (): Promise<boolean> => true;
const current = `${sessionModel.provider}/${sessionModel.id}`;

export default defineStory({
	id: "models-model-search-list",
	title: "ModelSearchList",
	component: { file: "apps/web/components/models/ModelSearchList.tsx", export: "ModelSearchList" },
	seed: { currentWorkspaceId: "sess_09a41c" },
	variants: [
		{
			name: "Browser loaded",
			description: "Recent rows first, one locked row with its reason, the current model marked.",
			seed: () => {
				seedRecentModels(recentSelectors);
				setState("modelBrowser", browserEntries);
			},
			render: () => (
				<ModelSearchList
					label="Search models"
					placeholder="Search models"
					currentSelector={current}
					onPick={accept}
					onPicked={() => undefined}
				/>
			),
		},
		{
			name: "Empty catalog",
			description: "No model rows at all.",
			render: () => (
				<ModelSearchList
					label="Search models"
					placeholder="Search models"
					onPick={accept}
					onPicked={() => undefined}
				/>
			),
		},
	],
});
