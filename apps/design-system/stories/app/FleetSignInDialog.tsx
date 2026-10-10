import { FleetSignInDialog } from "../../../web/components/app/FleetSignInDialog";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-fleet-sign-in-dialog",
	title: "FleetSignInDialog",
	component: { file: "apps/web/components/app/FleetSignInDialog.tsx", export: "FleetSignInDialog" },
	tabs: true,
	variants: [
		{
			name: "Sign in",
			description: "The default sign-in dialog for fleet browser auth.",
			render: (ctx) => <FleetSignInDialog onClose={ctx.close} />,
		},
		{
			name: "Session expired",
			description: "Opened after a 401 moved the auth store to signed out mid-use.",
			render: (ctx) => <FleetSignInDialog variant="expired" onClose={ctx.close} />,
		},
	],
});
