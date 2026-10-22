import { SessionSettings } from "../../../web/components/settings/SessionSettings";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

export default defineStory({
	id: "settings-session-settings",
	title: "SessionSettings",
	component: {
		file: "apps/web/components/settings/SessionSettings.tsx",
		export: "SessionSettings",
	},
	seed: { currentSessionId: "sess_09a41c" },
	variants: [
		{
			name: "Defaults",
			description: "Fast Mode off; Auto-Retry and Auto-Compact on.",
			seed: {
				fastModeEnabled: false,
				autoRetryEnabled: true,
				autoCompactionEnabled: true,
			},
			render: () => <SessionSettings />,
		},
		{
			name: "All overridden",
			description: "Fast Mode on; Auto-Retry and Auto-Compact off.",
			seed: {
				fastModeEnabled: true,
				autoRetryEnabled: false,
				autoCompactionEnabled: false,
			},
			render: () => <SessionSettings />,
		},
		{
			name: "Fast Mode unsupported",
			description:
				"The model has no fast mode: switching Fast Mode on answers unsupported and the error banner shows.",
			seed: () => answerCalls({ setFastMode: () => false }),
			render: () => <SessionSettings />,
		},
	],
});
