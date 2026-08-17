import { For, type Component } from "solid-js";
import { cancelUiRequest, sendUiResponse } from "../../../state";
import { DialogActions } from "../../shared";
import { Modal } from "../../shared/Modal";
import { PickerRow } from "../../shared/PickerRow";
import type { AskOption } from "./types";

/** select fallback: single option list, click answers with the option label. */
export const SelectForm: Component<{ id: string; params: unknown }> = (props) => {
	const p = () => props.params as { title: string; options: (string | AskOption)[] };
	const label = (o: string | AskOption) => (typeof o === "string" ? o : o.label);
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<div class="picker-list">
				<For each={p().options ?? []}>
					{(opt) => (
						<PickerRow
							class="picker-row ask-option"
							onClick={() => sendUiResponse(props.id, label(opt))}
						>
							<span class="picker-label">{label(opt)}</span>
							{typeof opt !== "string" && opt.description && (
								<span class="picker-detail">{opt.description}</span>
							)}
						</PickerRow>
					)}
				</For>
			</div>
			<DialogActions onCancel={() => cancelUiRequest(props.id)} />
		</Modal>
	);
};
