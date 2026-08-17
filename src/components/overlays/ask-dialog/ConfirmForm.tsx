import { type Component } from "solid-js";
import { cancelUiRequest, sendUiResponse } from "../../../state";
import { DialogActions } from "../../shared";
import { Modal } from "../../shared/Modal";

/** confirm fallback: OK/Cancel returning a boolean. */
export const ConfirmForm: Component<{ id: string; params: unknown }> = (props) => {
	const p = () => props.params as { title: string; message: string };
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<p class="ask-message">{p().message}</p>
			<DialogActions
				onCancel={() => sendUiResponse(props.id, false)}
				onPrimary={() => sendUiResponse(props.id, true)}
				primaryLabel="OK"
			/>
		</Modal>
	);
};
