import { Show, type Component } from "solid-js";
import { setState, state } from "../../../state";
import { StatusSegment } from "../../chat/status/StatusSegment";
import { InfoIcon } from "../../ui/icons";

/** Debug status-bar segment. Only in the Analysis view: in Chat the footer button stands in for it. */
export const DebugStatusButton: Component = () => (
	<Show when={state.view !== "chat"}>
		<StatusSegment
			active={state.modal === "debug"}
			onClick={() => setState("modal", state.modal === "debug" ? null : "debug")}
			title="Debug, transport and fleet visibility"
			ariaLabel="Debug, transport and fleet visibility"
		>
			<InfoIcon />
		</StatusSegment>
	</Show>
);
