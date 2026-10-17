import { AddRemoteDialog } from "../../../../web/components/fleet/workspaces/AddRemoteDialog";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

const enrollment = {
	workspaceId: "ws_remote_build",
	generation: 1,
	token: "tok_design_example_only",
	callbackUrl: "https://fleet.example.test/callback",
};

export default defineStory({
	id: "fleet-add-remote-dialog",
	title: "AddRemoteDialog",
	component: {
		file: "apps/web/components/fleet/workspaces/AddRemoteDialog.tsx",
		export: "AddRemoteDialog",
	},
	tabs: true,
	seed: () => seedRosterFleet({ modal: "add-remote" }),
	variants: [
		{
			name: "Form",
			render: () => <AddRemoteDialog onClose={() => {}} />,
		},
		{
			name: "Enrolled, one-time command shown",
			render: () => (
				<AddRemoteDialog
					onClose={() => {}}
					initial={{ daemonId: rosterDaemon.remoteError.daemonId, cwd: "/srv/app", enrollment }}
				/>
			),
		},
	],
});
