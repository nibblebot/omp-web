import type { Component } from "solid-js";
import { Modal } from "../ui/Modal";
import { SessionTreePanel } from "./SessionTreePanel";

/** Session tree overlay: the Modal shell around the shell-less SessionTreePanel. */
export const SessionTreeDialog: Component<{ onClose: () => void }> = (props) => (
	<Modal title="Session tree" onClose={props.onClose}>
		<SessionTreePanel onClose={props.onClose} />
	</Modal>
);
