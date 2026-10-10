import { DirectoryPicker } from "../../../../web/components/fleet/workspaces/DirectoryPicker";
import { rosterProjects } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-workspaces-directory-picker",
	title: "DirectoryPicker",
	component: {
		file: "apps/web/components/fleet/workspaces/DirectoryPicker.tsx",
		export: "DirectoryPicker",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Home directory",
			render: () => (
				<div class="ds-frame">
					<DirectoryPicker onSelect={() => undefined} />
				</div>
			),
		},
		{
			name: "Inside omp-web",
			render: () => (
				<div class="ds-frame">
					<DirectoryPicker onSelect={() => undefined} initialPath={rosterProjects[0].path} />
				</div>
			),
		},
		{
			name: "Missing directory",
			render: () => (
				<div class="ds-frame">
					<DirectoryPicker onSelect={() => undefined} initialPath="/home/joshua/missing" />
				</div>
			),
		},
	],
});
