import { AskBar } from "../../../web/components/requests/AskBar";
import { setState } from "../../../web/state";
import {
	approvalGrantsParams,
	approvalParams,
	approvalSessionParams,
	askChecksQuestion,
	askDialogRequest,
	askFormParams,
	askFormRequest,
	askFormWithDeadline,
	askLongFormParams,
	askLongQuestions,
	askScopeQuestion,
	askTabbedQuestions,
	confirmParams,
	editorParams,
	inputParams,
	secretInputParams,
	selectParams,
} from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

export default [
	defineStory({
		id: "requests-ask-bar",
		title: "AskBar",
		component: { file: "apps/web/components/requests/AskBar.tsx", export: "AskBar" },
		tabs: true,
		variants: [
			{
				name: "Agent asks one question",
				description: "No tabs: picking an option answers at once.",
				seed: () => setState("uiRequest", askDialogRequest("ask_41", [askScopeQuestion])),
				render: () => <AskBar />,
			},
			{
				name: "Agent asks two questions",
				seed: () =>
					setState("uiRequest", askDialogRequest("ask_42", [askScopeQuestion, askChecksQuestion])),
				render: () => <AskBar />,
			},
			{
				name: "Three questions with tabs",
				seed: () => setState("uiRequest", askDialogRequest("ask_44", askTabbedQuestions)),
				render: () => <AskBar />,
			},
			{
				name: "Long questions with previews",
				seed: () => setState("uiRequest", askDialogRequest("ask_43", askLongQuestions)),
				render: () => <AskBar />,
			},
			{
				name: "Agent form",
				description:
					"The ask tool's HTML form in one dock: context with a picture and table, a recommended radio group preselected (with Other), a checkbox group, a select, a number and a textarea. Enter submits from a field.",
				seed: () => setState("uiRequest", askFormRequest("form_61", askFormParams)),
				render: () => <AskBar />,
			},
			{
				name: "Agent form with a deadline",
				description:
					"A timeout from the session: the header counts down and the session submits the form's defaults at the deadline.",
				seed: () =>
					setState(
						"uiRequest",
						askFormRequest("form_62", askFormWithDeadline(Date.now() + 45_000)),
					),
				render: () => <AskBar />,
			},
			{
				name: "Long agent form",
				description:
					"Many sections: the body scrolls while the title, Cancel and Submit stay in view.",
				seed: () => setState("uiRequest", askFormRequest("form_63", askLongFormParams)),
				render: () => <AskBar />,
			},
			{
				name: "Select a model",
				seed: () => setState("uiRequest", { id: "sel_7", method: "select", params: selectParams }),
				render: () => <AskBar />,
			},
			{
				name: "Tool approval",
				description:
					"The approve ui_request: a title line, the call's details with their whitespace, then Approve or Deny.",
				seed: () =>
					setState("uiRequest", { id: "appr_8", method: "approve", params: approvalParams }),
				render: () => <AskBar />,
			},
			{
				name: "Tool approval with session choice",
				description: "The prompt offers to approve the tool for the rest of the session.",
				seed: () =>
					setState("uiRequest", {
						id: "appr_9",
						method: "approve",
						params: approvalSessionParams,
					}),
				render: () => <AskBar />,
			},
			{
				name: "Tool approval with grants",
				description:
					"An always-ask-cached prompt: each grant remembered for this session or across sessions.",
				seed: () =>
					setState("uiRequest", {
						id: "appr_10",
						method: "approve",
						params: approvalGrantsParams,
					}),
				render: () => <AskBar />,
			},
			{
				name: "Confirm",
				seed: () =>
					setState("uiRequest", { id: "conf_3", method: "confirm", params: confirmParams }),
				render: () => <AskBar />,
			},
			{
				name: "Input",
				seed: () => setState("uiRequest", { id: "input_5", method: "input", params: inputParams }),
				render: () => <AskBar />,
			},
			{
				name: "Input (secret)",
				description:
					"The SDK's secret option masks the typed characters; collab guests are never offered it.",
				seed: () =>
					setState("uiRequest", { id: "input_6", method: "input", params: secretInputParams }),
				render: () => <AskBar />,
			},
			{
				name: "Editor",
				seed: () => setState("uiRequest", { id: "edit_2", method: "editor", params: editorParams }),
				render: () => <AskBar />,
			},
		],
	}),
];
