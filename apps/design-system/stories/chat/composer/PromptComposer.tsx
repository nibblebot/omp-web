import { createSignal, onMount } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { PromptComposer } from "../../../../web/components/chat/composer/PromptComposer";
import { usePromptAutocomplete } from "../../../../web/components/chat/composer/usePromptAutocomplete";
import {
	screenDraft,
	screenImage,
	screenLongPaste,
	screenSessionSeed,
} from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

/**
 * Owns the message and attachment signals the way PromptBox does, and wires
 * the real autocomplete hook so a leading "/" or "@" opens the real popup.
 * `lift` pushes the composer down so an open popup (max 300px, above the
 * composer) stays inside the frame.
 */
function ComposerHarness(props: {
	initialText: string;
	initialImages?: ImageArg[];
	lift?: boolean;
}) {
	const [message, setMessage] = createSignal(props.initialText);
	const [images, setImages] = createSignal<ImageArg[]>(props.initialImages ?? []);
	let textarea: HTMLTextAreaElement | undefined;
	const ac = usePromptAutocomplete(() => textarea, message, setMessage);
	onMount(() => ac.refreshToken());
	return (
		<div class="ds-frame">
			<div class="prompt-box">
				<div style={{ "margin-top": props.lift ? "320px" : "0" }}>
					<PromptComposer
						message={message}
						setMessage={setMessage}
						images={images}
						setImages={setImages}
						ac={ac}
						onKeyDown={() => {}}
						setTextareaRef={(el) => {
							textarea = el;
						}}
					/>
				</div>
			</div>
		</div>
	);
}

export default defineStory({
	id: "chat-composer-prompt-composer",
	title: "PromptComposer",
	component: {
		file: "apps/web/components/chat/composer/PromptComposer.tsx",
		export: "PromptComposer",
	},
	seed: screenSessionSeed,
	variants: [
		{
			name: "Draft",
			description: "A multi-line message ready to send.",
			render: () => <ComposerHarness initialText={screenDraft} />,
		},
		{
			name: "Slash command picker",
			description: "Typing /mo opens the command completions above the textarea.",
			render: () => <ComposerHarness initialText="/mo" lift />,
		},
		{
			name: "Folded large paste",
			description: "A long pasted log, folded in the composer and sent in full.",
			render: () => <ComposerHarness initialText={screenLongPaste} />,
		},
		{
			name: "With image attachment",
			description: "A screenshot attached as a clip above the text.",
			render: () => (
				<ComposerHarness
					initialText="Compare this against the mock"
					initialImages={[screenImage]}
				/>
			),
		},
	],
});
