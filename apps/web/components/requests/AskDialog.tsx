import { Show, type Component } from "solid-js";
import { cancelUiRequest, state } from "../../state";
import { Modal } from "../ui/Modal";
import { QuestionsForm, ConfirmForm, EditorForm, InputForm, SelectForm } from "./ask";
import type { AskQuestion, UiRequest } from "../../prompt/ask-types";

/**
 * Server-pushed ExtensionUIContext dialogs (Phase 3): the ask tool's
 * multi-question form (askDialog) plus select/confirm/input/editor fallbacks
 * rendered with the same modal. Answers go back as ui_response; cancelling
 * resolves the request undefined, which AskToolCard surfaces as "Ask tool was
 * cancelled by the user".
 *
 * Routing only: the per-method forms live in ./ask-dialog.
 */
export const AskDialog: Component = () => (
	<Show when={state.uiRequest} keyed>
		{(req: UiRequest) => {
			switch (req.method) {
				case "askDialog": {
					const p = req.params as { questions: AskQuestion[] };
					return (
						<Modal title="Agent asks" onClose={() => cancelUiRequest(req.id)}>
							<QuestionsForm id={req.id} questions={p.questions ?? []} />
						</Modal>
					);
				}
				case "select":
					return <SelectForm id={req.id} params={req.params} />;
				case "confirm":
					return <ConfirmForm id={req.id} params={req.params} />;
				case "input":
					return <InputForm id={req.id} params={req.params} />;
				case "editor":
					return <EditorForm id={req.id} params={req.params} />;
				default:
					return null;
			}
		}}
	</Show>
);
