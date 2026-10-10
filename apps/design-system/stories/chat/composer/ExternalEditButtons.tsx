import { createSignal } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { ExternalEditButtons } from "../../../../web/components/chat/composer/PromptComposer";
import { screenDraft, screenImage, screenLongPaste } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

/** Holds the text and attachments the buttons read and write, as the composer does. */
function EditHarness(props: { initialText: string; initialImages?: ImageArg[] }) {
	const [text, setText] = createSignal(props.initialText);
	const [images] = createSignal<ImageArg[]>(props.initialImages ?? []);
	return (
		<div class="ds-frame">
			<div class="prompt-box">
				<ExternalEditButtons getText={text} getImages={images} setText={setText} />
			</div>
		</div>
	);
}

export default defineStory({
	id: "chat-composer-external-edit-buttons",
	title: "ExternalEditButtons",
	component: {
		file: "apps/web/components/chat/composer/PromptComposer.tsx",
		export: "ExternalEditButtons",
	},
	variants: [
		{
			name: "Draft with attachment",
			description: "Export the draft to an external editor, with a screenshot attached.",
			render: () => <EditHarness initialText={screenDraft} initialImages={[screenImage]} />,
		},
		{
			name: "Large paste",
			description: "A long pasted log, which is easier to edit outside the composer.",
			render: () => <EditHarness initialText={screenLongPaste} />,
		},
		{
			name: "Empty composer",
			render: () => <EditHarness initialText="" />,
		},
	],
});
