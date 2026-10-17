import { AttachmentChip } from "../../../../web/components/chat/composer/AttachmentChip";
import type { TextAttachment } from "../../../../web/prompt/attachments";
import { defineStory } from "../../../registry";

const readable: TextAttachment = {
	id: "story-readable",
	name: "router.ts",
	size: 1840,
	text: "export const route = () => {};\n",
};

const rejected: TextAttachment = {
	id: "story-rejected",
	name: "build.bin",
	size: 2_400_000,
	error: '"build.bin" is too large (over ~1MB).',
};

export default defineStory({
	id: "chat-composer-attachment-chip",
	title: "AttachmentChip",
	component: {
		file: "apps/web/components/chat/composer/AttachmentChip.tsx",
		export: "AttachmentChip",
	},
	variants: [
		{
			name: "Text file",
			description: "A readable file. Its size shows, and the remove button is keyboard reachable.",
			render: () => (
				<div class="ds-frame">
					<div class="attachment-tray">
						<AttachmentChip attachment={readable} onRemove={() => {}} />
					</div>
				</div>
			),
		},
		{
			name: "Rejected file",
			description:
				"An oversize or unsupported file stays as a chip, with its reason in the error tone. It is never sent.",
			render: () => (
				<div class="ds-frame">
					<div class="attachment-tray">
						<AttachmentChip attachment={rejected} onRemove={() => {}} />
					</div>
				</div>
			),
		},
	],
});
