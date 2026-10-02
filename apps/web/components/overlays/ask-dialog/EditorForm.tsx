import { createSignal, onMount, type Component } from "solid-js";
import { cancelUiRequest, sendUiResponse } from "../../../state";
import { DialogActions } from "../../shared";
import { Modal } from "../../shared/Modal";

/** editor fallback: multiline text (prefilled) returning a string. */
export const EditorForm: Component<{ id: string; params: unknown }> = (props) => {
	const p = () => props.params as { title: string; prefill?: string };
	const [value, setValue] = createSignal(p().prefill ?? "");
	let el!: HTMLTextAreaElement;
	onMount(() => el.focus());
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					sendUiResponse(props.id, value());
				}}
			>
				<textarea
					class="ask-editor"
					ref={el}
					aria-label={p().title}
					value={value()}
					onInput={(e) => setValue(e.currentTarget.value)}
				/>
				<DialogActions
					onCancel={() => cancelUiRequest(props.id)}
					onPrimary={() => sendUiResponse(props.id, value())}
					primaryLabel="Submit"
				/>
			</form>
		</Modal>
	);
};
