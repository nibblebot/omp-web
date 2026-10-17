import { onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { DockPane } from "../ui/DockPane";
import { ReviewPanel } from "../review/ReviewPanel";
import { SessionTreePanel } from "../sessions/SessionTreePanel";
import { AgentsPanel } from "../subagents/AgentsPanel";
import { SubagentPanel } from "../subagents/SubagentPanel";
import { applyDockWidth, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH } from "../../prefs/dock";
import { backFromDock, setDockWidth } from "../../store/dock";
import { state } from "../../state";

interface DockKind {
	title: string;
	body: Component<{ id?: string }>;
}

/** Dock panel kinds, keyed by the route's `<kind>` segment. */
const DOCK_KINDS: Record<string, DockKind> = {
	review: { title: "Git review", body: ReviewPanel },
	tree: { title: "Session tree", body: SessionTreePanel },
	agent: { title: "Agent", body: SubagentPanel },
	agents: { title: "Agents", body: AgentsPanel },
};

/** Focus the agents-list row for `id` once the list has mounted. */
function focusDockRow(id: string): void {
	setTimeout(() =>
		document
			.querySelector<HTMLElement>(`.dock-pane [data-subagent-id="${CSS.escape(id)}"]`)
			?.focus(),
	);
}

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
	const onBack = () => {
		// Read the id first: backFromDock merges into the same store object.
		const agentId = state.dock?.kind === "agent" ? state.dock.id : undefined;
		backFromDock();
		if (agentId !== undefined) focusDockRow(agentId);
	};
	return (
		<Show when={entry()} keyed>
			{(kind) => (
				<DockPane
					title={kind.title}
					width={state.dockWidth}
					minWidth={DOCK_MIN_WIDTH}
					maxWidth={DOCK_MAX_WIDTH}
					onWidth={setDockWidth}
					onClose={onBack}
				>
					<Dynamic component={kind.body} id={state.dock?.id} />
				</DockPane>
			)}
		</Show>
	);
};
