import { createEffect, createSignal, onMount } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import type { TextAttachment } from "../../../../web/prompt/attachments";
import { PromptComposer } from "../../../../web/components/chat/composer/PromptComposer";
import { useGhostText } from "../../../../web/components/chat/composer/useGhostText";
import { usePromptAutocomplete } from "../../../../web/components/chat/composer/usePromptAutocomplete";
import { setState } from "../../../../web/state";
import { screenPredictions } from "../../../fixtures/composer";
import {
	screenDraft,
	screenImage,
	screenLongPaste,
	screenSessionSeed,
} from "../../../fixtures/screen";
import { defineStory } from "../../../registry";
import { answerCalls } from "../../../session";

const screenTextFiles: TextAttachment[] = [
	{ id: "story-ts", name: "router.ts", size: 1840, text: "export const route = () => {};\n" },
	{
		id: "story-bin",
		name: "build.bin",
		size: 2_400_000,
		error: '"build.bin" is too large (over ~1MB).',
	},
];

/**
 * Owns the message and attachment signals the way PromptBox does, and wires
 * the real autocomplete and ghost-text hooks so a leading "/" or "@" opens the
 * real popup and Tab, Right and the predictions list work on the keyboard.
 * `lift` pushes the composer down so an open popup (max 300px, above the
 * composer) stays inside the frame. `endsTurn` ends the streamed turn the
 * seed started, which is when the session predicts the next message;
 * `openList` presses Tab once the hint shows. The session predicts only
 * over an empty draft, so `draftAfterPrediction` is typed once the
 * prediction has arrived.
 */
function ComposerHarness(props: {
	initialText: string;
	initialImages?: ImageArg[];
	initialFiles?: TextAttachment[];
	lift?: boolean;
	endsTurn?: boolean;
	openList?: boolean;
	draftAfterPrediction?: string;
}) {
	const [message, setMessage] = createSignal(props.initialText);
	const [images, setImages] = createSignal<ImageArg[]>(props.initialImages ?? []);
	const [files, setFiles] = createSignal<TextAttachment[]>(props.initialFiles ?? []);
	let textarea: HTMLTextAreaElement | undefined;
	const ac = usePromptAutocomplete(() => textarea, message, setMessage);
	const ghost = useGhostText(() => textarea, message, setMessage);
	onMount(() => {
		ac.refreshToken();
		if (props.endsTurn) setState("streaming", false);
	});
	let typed = false;
	createEffect(() => {
		if (props.draftAfterPrediction !== undefined && !typed && ghost.text() !== "") {
			typed = true;
			setMessage(props.draftAfterPrediction);
		}
	});
	let listed = false;
	createEffect(() => {
		if (props.openList && !listed && ghost.hint() !== "") {
			listed = true;
			ghost.openAlternatives();
		}
	});
	return (
		<div class="ds-frame">
			<div class="prompt-box">
				<div style={{ "margin-top": props.lift ? "320px" : "0" }}>
					<PromptComposer
						message={message}
						setMessage={setMessage}
						images={images}
						setImages={setImages}
						files={files}
						setFiles={setFiles}
						ac={ac}
						ghost={ghost}
						onKeyDown={(e) => {
							// PromptBox's ghost-text keys: the list first, then Tab or Right accepts, Tab lists.
							if (ghost.alternatives.onKeyDown(e)) return;
							if ((e.key === "Tab" && !e.shiftKey) || e.key === "ArrowRight") {
								if (ghost.accept()) e.preventDefault();
								else if (e.key === "Tab" && ghost.openAlternatives()) e.preventDefault();
							}
						}}
						setTextareaRef={(el) => {
							textarea = el;
						}}
						historyOpen={() => false}
						closeHistory={() => {}}
					/>
				</div>
			</div>
		</div>
	);
}

/** A session that has Composer Predictions and Prediction Alternatives on and is mid-turn: the turn ends in the harness, then it predicts. */
function predictionsSeed(): void {
	setState({ streaming: true, settingValues: { "composer.predictions": true } });
	answerCalls({
		predictWord: () => ({ suffix: "" }),
		predictNextMessage: () => ({ text: screenPredictions[0], choices: screenPredictions }),
	});
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
		{
			name: "With text attachments",
			description:
				"A readable file as a removable chip, and an oversize file as a chip with its error in the error tone. Text is sent with the message, not pasted into the draft.",
			render: () => (
				<ComposerHarness
					initialText="Why does the router return a 404 here?"
					initialFiles={screenTextFiles}
				/>
			),
		},
		{
			name: "Prediction ghost",
			description:
				"With Prediction Alternatives on, the turn's prediction request returned four messages. The empty composer ghosts the most likely; Tab or Right inserts it without sending.",
			seed: predictionsSeed,
			render: () => <ComposerHarness initialText="" endsTurn lift />,
		},
		{
			name: "Typed draft keeps a longer ghost",
			description:
				"The ghost follows the first prediction the draft is a prefix of: a typed draft that equals the shorter first prediction still ghosts the longer second.",
			seed: predictionsSeed,
			render: () => (
				<ComposerHarness
					initialText=""
					draftAfterPrediction={screenPredictions[0]!}
					endsTurn
					lift
				/>
			),
		},
		{
			name: "More predictions hint",
			description:
				"A draft that equals a prediction with no longer one to extend to shows the dim ⇥ N more hint; Tab lists them all.",
			seed: predictionsSeed,
			render: () => (
				<ComposerHarness
					initialText=""
					draftAfterPrediction={screenPredictions[3]!}
					endsTurn
					lift
				/>
			),
		},
		{
			name: "Predictions list",
			description:
				"Tab over the hint lists every prediction with the current line selected. Up and Down move, Enter, Tab or Right swap the whole line (never sending), Esc keeps it.",
			seed: predictionsSeed,
			render: () => (
				<ComposerHarness
					initialText=""
					draftAfterPrediction={screenPredictions[2]!}
					endsTurn
					openList
					lift
				/>
			),
		},
	],
});
