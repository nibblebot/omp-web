import { For, type Component } from "solid-js";
import { state } from "../../state";
import { setActivitiesMode, type ActivitiesMode } from "../../store/activities";
import { Rows3Icon, SquareIcon } from "../ui/icons";

const MODES: readonly { mode: ActivitiesMode; label: string; icon: Component }[] = [
	{ mode: "accordion", label: "Accordion view", icon: Rows3Icon },
	{ mode: "detail", label: "Detail view", icon: SquareIcon },
];

/** Segmented control in the Activities dock header: items expand inline in the list, or one item fills the panel. */
export const ActivitiesModeToggle: Component = () => (
	<div class="activities-mode-toggle" role="group" aria-label="Activities view">
		<For each={MODES}>
			{(entry) => (
				<button
					type="button"
					class="segment segment-button"
					classList={{ active: state.activities.mode === entry.mode }}
					aria-pressed={state.activities.mode === entry.mode}
					aria-label={entry.label}
					title={entry.label}
					onClick={() => setActivitiesMode(entry.mode)}
				>
					<entry.icon />
				</button>
			)}
		</For>
	</div>
);
