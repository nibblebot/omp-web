import { GuestPromptCard } from "../../../web/components/chat/transcript/cards/GuestPromptCard";
import { defineStory } from "../../registry";

export default defineStory({
	id: "collab-guest-prompt-card",
	title: "GuestPromptCard",
	component: {
		file: "apps/web/components/chat/transcript/cards/GuestPromptCard.tsx",
		export: "GuestPromptCard",
	},
	variants: [
		{
			name: "Guest question",
			description: "A prompt sent by a shared-session guest, labeled with the guest's name.",
			render: () => (
				<div class="ds-frame">
					<GuestPromptCard
						item={{
							kind: "guestPrompt",
							id: 1,
							from: "ada",
							text: "Can you also run the migration tests?",
						}}
					/>
				</div>
			),
		},
	],
});
