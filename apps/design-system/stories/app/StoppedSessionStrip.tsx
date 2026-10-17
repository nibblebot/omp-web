import { StoppedSessionStrip } from "../../../web/components/app/StoppedSessionStrip";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-stopped-session-strip",
	title: "StoppedSessionStrip",
	component: {
		file: "apps/web/components/app/StoppedSessionStrip.tsx",
		export: "StoppedSessionStrip",
	},
	variants: [
		{
			name: "Stopped by user",
			description:
				"Above the composer after the user stops the attached session process; Restart wakes it.",
			render: () => (
				<div class="ds-frame">
					<StoppedSessionStrip onRestart={() => {}} />
				</div>
			),
		},
	],
});
