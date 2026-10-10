import { AskDialog } from "../../../web/components/requests/AskDialog";
import { QuestionsForm } from "../../../web/components/requests/ask/QuestionsForm";
import { ConfirmForm } from "../../../web/components/requests/ask/ConfirmForm";
import { EditorForm } from "../../../web/components/requests/ask/EditorForm";
import { InputForm } from "../../../web/components/requests/ask/InputForm";
import { SelectForm } from "../../../web/components/requests/ask/SelectForm";
import { Modal } from "../../../web/components/ui/Modal";
import { setState } from "../../../web/state";
import {
	askChecksQuestion,
	askDialogRequest,
	askLongQuestions,
	askScopeQuestion,
	confirmParams,
	editorParams,
	inputParams,
	selectParams,
} from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

export default [
	defineStory({
		id: "requests-ask-dialog",
		title: "AskDialog",
		component: { file: "apps/web/components/requests/AskDialog.tsx", export: "AskDialog" },
		tabs: true,
		variants: [
			{
				name: "Agent asks two questions",
				seed: () =>
					setState("uiRequest", askDialogRequest("ask_42", [askScopeQuestion, askChecksQuestion])),
				render: () => <AskDialog />,
			},
			{
				name: "Long questions with previews",
				seed: () => setState("uiRequest", askDialogRequest("ask_43", askLongQuestions)),
				render: () => <AskDialog />,
			},
			{
				name: "Select a model",
				seed: () => setState("uiRequest", { id: "sel_7", method: "select", params: selectParams }),
				render: () => <AskDialog />,
			},
			{
				name: "Confirm",
				seed: () =>
					setState("uiRequest", { id: "conf_3", method: "confirm", params: confirmParams }),
				render: () => <AskDialog />,
			},
		],
	}),
	defineStory({
		id: "requests-ask-questions-form",
		title: "QuestionsForm",
		component: {
			file: "apps/web/components/requests/ask/QuestionsForm.tsx",
			export: "QuestionsForm",
		},
		tabs: true,
		variants: [
			{
				name: "Two questions",
				render: (ctx) => (
					<Modal title="Agent question" onClose={ctx.close}>
						<QuestionsForm id="ask_42" questions={[askScopeQuestion, askChecksQuestion]} />
					</Modal>
				),
			},
			{
				name: "Long questions with previews",
				render: (ctx) => (
					<Modal title="Agent question" onClose={ctx.close}>
						<QuestionsForm id="ask_43" questions={askLongQuestions} />
					</Modal>
				),
			},
		],
	}),
	defineStory({
		id: "requests-ask-confirm-form",
		title: "ConfirmForm",
		component: {
			file: "apps/web/components/requests/ask/ConfirmForm.tsx",
			export: "ConfirmForm",
		},
		tabs: true,
		variants: [
			{
				name: "Discard unsaved draft",
				render: () => <ConfirmForm id="conf_3" params={confirmParams} />,
			},
		],
	}),
	defineStory({
		id: "requests-ask-select-form",
		title: "SelectForm",
		component: {
			file: "apps/web/components/requests/ask/SelectForm.tsx",
			export: "SelectForm",
		},
		tabs: true,
		variants: [
			{
				name: "Reviewer model",
				render: () => <SelectForm id="sel_7" params={selectParams} />,
			},
		],
	}),
	defineStory({
		id: "requests-ask-input-form",
		title: "InputForm",
		component: {
			file: "apps/web/components/requests/ask/InputForm.tsx",
			export: "InputForm",
		},
		tabs: true,
		variants: [
			{
				name: "Branch name",
				render: () => <InputForm id="input_5" params={inputParams} />,
			},
		],
	}),
	defineStory({
		id: "requests-ask-editor-form",
		title: "EditorForm",
		component: {
			file: "apps/web/components/requests/ask/EditorForm.tsx",
			export: "EditorForm",
		},
		tabs: true,
		variants: [
			{
				name: "Prefilled handoff note",
				render: () => <EditorForm id="edit_2" params={editorParams} />,
			},
		],
	}),
];
