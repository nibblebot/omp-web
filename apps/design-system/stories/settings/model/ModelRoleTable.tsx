import { ModelRoleTable } from "../../../../web/components/settings/ModelRoleTable";
import { setState } from "../../../../web/state";
import { modelInfos, modelRoleCatalog } from "../../../fixtures/overlays";
import { defineStory } from "../../../registry";

const thinkingSelectors = ["off", "minimal", "low", "medium", "high", "xhigh"];

const seedRoles = (storage: "global" | "project"): void => {
	setState("modelBrowser", modelInfos);
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
	],
});
