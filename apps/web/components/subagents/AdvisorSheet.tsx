import type { Component } from "solid-js";
import { Modal } from "../ui/Modal";
import { AdvisorPanel } from "./AdvisorPanel";

/** Advisor sheet, opened from the command palette's Advisor entry (ModalHost mounts it for state.modal "advisor"). */
export const AdvisorSheet: Component<{ onClose: () => void }> = (props) => (
	<Modal variant="sheet" title="Advisor" onClose={props.onClose}>
		<AdvisorPanel />
	</Modal>
);
