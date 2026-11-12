import { onMount, type Component } from "solid-js";
import { AskForm } from "../../../web/components/requests/AskForm";
import {
	askFormParams,
	askFormWithDeadline,
	askLongFormParams,
	askRequiredFormParams,
} from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

/** The agent form with the preselected option's note open and typed into, as a user would. */
const FormWithNote: Component = () => {
	let host!: HTMLDivElement;
	onMount(() => {
		// After the stage has attached the form: its controls answer real clicks and input.
		setTimeout(() => {
			host.querySelector<HTMLButtonElement>(".ask-form-note-toggle")?.click();
			const note = host.querySelector<HTMLTextAreaElement>(".ask-form-note-input");
			if (note === null) return;
			note.value = "Keep the file next to the session logs so backups pick it up.";
			note.dispatchEvent(new Event("input", { bubbles: true }));
		}, 0);
	});
	return (
		<div ref={host}>
			<AskForm id="form_75" params={askFormParams} />
		</div>
	);
};

/**
 * The ask tool's HTML form, drawn by the AskBar for a `formDialog` ui_request: titled
 * sections, context blocks (text, list, pre, table, pictures) and fields (radio and
 * checkbox groups with an Other answer, selects, inputs, textareas). A chosen option
 * offers a Note button. The AskBar story shows it docked above the composer; these
 * variants render the form itself.
 */
export default defineStory({
	id: "requests-ask-form",
	title: "AskForm",
	component: { file: "apps/web/components/requests/AskForm.tsx", export: "AskForm" },
	variants: [
		{
			name: "Agent form",
			description:
				"A recommended radio option preselected, a checkbox group, a select, a number and a textarea, with a picture and a table as context.",
			render: () => <AskForm id="form_71" params={askFormParams} />,
		},
		{
			name: "Writing a note on a chosen option",
			description:
				"Note on the picked store opened and typed into: the note goes to the agent with the answer while that option stays chosen. Pick another option and the note stays as a draft that is not sent.",
			render: () => <FormWithNote />,
		},
		{
			name: "Required and out-of-range fields",
			description:
				"Submit validates with the SDK's field rules: a missing version, an unchecked required group and a rollout over its maximum.",
			render: () => <AskForm id="form_72" params={askRequiredFormParams} />,
		},
		{
			name: "With a deadline",
			description: "The header counts down to the deadline the session set.",
			render: () => <AskForm id="form_73" params={askFormWithDeadline(Date.now() + 90_000)} />,
		},
		{
			name: "Long form",
			description: "Eight sections: the body scrolls inside the dock.",
			render: () => <AskForm id="form_74" params={askLongFormParams} />,
		},
	],
});
