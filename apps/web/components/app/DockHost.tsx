import { onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { DockPane } from "../ui/DockPane";
import { ReviewPanel } from "../review/ReviewPanel";
import { applyDockWidth, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH } from "../../prefs/dock";
import { closeDock, setDockWidth } from "../../store/dock";
import { state } from "../../state";

interface DockKind {
	title: string;
	body: Component<{ id?: string }>;
}

/** Dock panel kinds, keyed by the route's `<kind>` segment. */
const DOCK_KINDS: Record<string, DockKind> = {
	review: { title: "Git review", body: ReviewPanel },
};

/** Mounts the open dock panel beside the main pane. Unknown kinds render nothing. */
export const DockHost: Component = () => {
	onMount(() => applyDockWidth(state.dockWidth));
	const entry = () => {
		const dock = state.dock;
		// hasOwn: a kind such as `constructor` must not match an inherited key.
		return dock !== null && Object.hasOwn(DOCK_KINDS, dock.kind)
			? DOCK_KINDS[dock.kind]
			: undefined;
	};
	return (
		<Show when={entry()}>
			{(kind) => (
				<DockPane
					title={kind().title}
					width={state.dockWidth}
					minWidth={DOCK_MIN_WIDTH}
					maxWidth={DOCK_MAX_WIDTH}
					onWidth={setDockWidth}
					onClose={closeDock}
				>
					<Dynamic component={kind().body} id={state.dock?.id} />
				</DockPane>
			)}
		</Show>
	);
};
