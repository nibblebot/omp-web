import type { Component } from "solid-js";
import { Modal } from "../ui/Modal";
import { AdvisorPanel } from "./AdvisorPanel";

/** Advisor notes sheet, opened from an advisor transcript card (ModalHost mounts it for state.modal "advisor"). */
export const AdvisorSheet: Component<{ onClose: () => void }> = (props) => (
	<Modal variant="sheet" title="Advisor" onClose={props.onClose}>
		<AdvisorPanel />
	</Modal>
);
