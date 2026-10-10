import { CopyButton } from "../../../web/components/ui";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-copy-button",
	title: "CopyButton",
	component: { file: "apps/web/components/ui/CopyButton.tsx", export: "CopyButton" },
	variants: [
		{
			name: "Default",
			description: "Click to copy; the label flips to copied for 1.2s.",
			render: () => <CopyButton text="omp --resume 2026-10-09T11-42-17Z_a1b2c3.jsonl" />,
		},
		{
			name: "Message toolbar",
			description: "The production styling used on chat message cards.",
			render: () => (
				<CopyButton
					class="msg-copy-btn"
					title="Copy message markdown"
					text={() => "Resolved at click time, so streaming text is never stale."}
				/>
			),
		},
	],
});
