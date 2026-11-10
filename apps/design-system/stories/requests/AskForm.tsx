import { AskForm } from "../../../web/components/requests/AskForm";
import {
	askFormParams,
	askFormWithDeadline,
	askLongFormParams,
	askRequiredFormParams,
} from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

/**
 * The ask tool's HTML form, drawn by the AskBar for a `formDialog` ui_request: titled
 * sections, context blocks (text, list, pre, table, pictures) and fields (radio and
 * checkbox groups with an Other answer, selects, inputs, textareas). The AskBar story
 * shows it docked above the composer; these variants render the form itself.
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
