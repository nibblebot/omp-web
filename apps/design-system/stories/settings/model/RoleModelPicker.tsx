import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { RoleModelPicker } from "../../../../web/components/settings/RoleModelPicker";
import { setState } from "../../../../web/state";
import { modelInfos } from "../../../fixtures/overlays";
import { defineStory } from "../../../registry";

const noop = (): void => undefined;
const noopAsync = async (): Promise<boolean> => true;

const assigned = modelInfos[0];
const assignedSelector = `${assigned.provider}/${assigned.id}`;

/** The fixture catalog with its second model locked, to show the disabled option and its reason. */
const lockedBrowser: ModelBrowserEntry[] = modelInfos.map((model, index) =>
	index === 1 ? { ...model, locked: "credentials" } : model,
);

export default defineStory({
	id: "settings-role-model-picker",
	title: "RoleModelPicker",
	component: {
		file: "apps/web/components/settings/RoleModelPicker.tsx",
		export: "RoleModelPicker",
	},
	variants: [
		{
			name: "Role row, closed",
			description:
				"The role's model on a button; the searchable list stays closed until the row is opened.",
			seed: () => setState("modelBrowser", modelInfos),
			render: () => (
				<RoleModelPicker
					role="advisor"
					name="Advisor"
					selector={assignedSelector}
					open={false}
					disabled={false}
					onOpen={noop}
					onClose={noop}
					onPick={noopAsync}
					onClear={noopAsync}
				/>
			),
		},
		{
			name: "Role row, open with locked models",
			description:
				"Opened inline: Clear (inherit), the composer's search list with the assigned model marked current, and locked models disabled with their reason.",
			seed: () => setState("modelBrowser", lockedBrowser),
			render: () => (
				<RoleModelPicker
					role="advisor"
					name="Advisor"
					selector={assignedSelector}
					open={true}
					disabled={false}
					onOpen={noop}
					onClose={noop}
					onPick={noopAsync}
					onClear={noopAsync}
				/>
			),
		},
	],
});
