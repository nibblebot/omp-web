import { For, type Component } from "solid-js";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";
import { PickerRow } from "./PickerRow";

// Values mirror pi-agent-core/src/thinking.ts; kept as literals because the
// const object can't be value-imported without bundling the agent runtime.
export const THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[];

/** Thinking-level picker: all eight levels, current one marked. */
export const ThinkingPicker: Component<{ onClose: () => void }> = props => {
	const choose = (level: ThinkingLevel) => {
		void call("setThinkingLevel", [level]).catch(err => setState("error", String(err)));
		props.onClose();
	};
	return (
		<Modal title="Thinking level" onClose={props.onClose}>
			<div class="picker-list">
				<For each={THINKING_LEVELS}>
					{level => (
						<PickerRow
							class="picker-row"
							classList={{ active: (state.thinkingLevel ?? "inherit") === level }}
							onClick={() => choose(level)}
						>
							<span class="picker-label">{level}</span>
						</PickerRow>
					)}
				</For>
			</div>
		</Modal>
	);
};
