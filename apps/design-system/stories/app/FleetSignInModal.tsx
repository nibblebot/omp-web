import { FleetSignInModal } from "../../../web/components/app/FleetSignInModal";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-fleet-sign-in-modal",
	title: "FleetSignInModal",
	component: { file: "apps/web/components/app/FleetSignInModal.tsx", export: "FleetSignInModal" },
	tabs: true,
	variants: [
		{
			name: "Sign in",
			description: "The default sign-in dialog for fleet browser auth.",
			render: () => <FleetSignInModal onClose={() => undefined} />,
		},
		{
			name: "Session expired",
			description: "Opened after a 401 moved the auth store to signed out mid-use.",
			render: () => <FleetSignInModal variant="expired" onClose={() => undefined} />,
		},
	],
});
