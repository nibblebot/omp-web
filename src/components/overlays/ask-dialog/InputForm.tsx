import { createSignal, onMount, type Component } from "solid-js";
import { cancelUiRequest, sendUiResponse } from "../../../state";
import { DialogActions } from "../../shared";
import { Modal } from "../../shared/Modal";

/** input fallback: single-line text returning a string. */
export const InputForm: Component<{ id: string; params: unknown }> = (props) => {
	const p = () => props.params as { title: string; placeholder?: string };
	const [value, setValue] = createSignal("");
	let el!: HTMLInputElement;
	onMount(() => el.focus());
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					sendUiResponse(props.id, value());
				}}
			>
				<input
					class="picker-filter"
					ref={el}
					aria-label={p().title}
					placeholder={p().placeholder}
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
