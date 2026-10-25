import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { ModelRoleTable } from "../../../../web/components/settings/ModelRoleTable";
import { setState } from "../../../../web/state";
import { modelInfos, modelRoleCatalog } from "../../../fixtures/overlays";
import { defineStory } from "../../../registry";
import { answerCalls } from "../../../session";

const thinkingSelectors = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** The fixture catalog with its second model locked, to show the disabled option and its reason. */
const lockedBrowser: ModelBrowserEntry[] = modelInfos.map((model, index) =>
	index === 1 ? { ...model, locked: "credentials" } : model,
);

const seedRoles = (storage: "global" | "project"): void => {
	answerCalls({ getModelBrowser: () => modelInfos });
	setState("modelRoleCatalog", modelRoleCatalog);
	setState("modelRoleStorage", storage);
	setState("thinkingSelectors", thinkingSelectors);
};

export default defineStory({
	id: "settings-model-role-table",
	title: "ModelRoleTable",
	component: {
		file: "apps/web/components/settings/ModelRoleTable.tsx",
		export: "ModelRoleTable",
	},
	variants: [
		{
			name: "Roles, global storage",
			description:
				"Assigned, unassigned and hidden roles from project and global layers; the table is saved to global config.yml.",
			seed: () => seedRoles("global"),
			render: () => <ModelRoleTable />,
		},
		{
			name: "Roles, project storage",
			description: "Same catalog with modelRoleStorage set to project.",
			seed: () => seedRoles("project"),
			render: () => <ModelRoleTable />,
		},
		{
			name: "Roles, locked models",
			description:
				"Models without credentials are disabled in every role's model list, with the reason.",
			seed: () => {
				seedRoles("global");
				answerCalls({ getModelBrowser: () => lockedBrowser });
			},
			render: () => <ModelRoleTable />,
		},
	],
});
