import {
	createComputed,
	createEffect,
	createSignal,
	on,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { DockPane } from "../ui/DockPane";
import { ReviewPanel } from "../review/ReviewPanel";
import { SessionTreePanel } from "../sessions/SessionTreePanel";
import { AgentsDockActions } from "../subagents/AgentsDockActions";
import { AgentsPanel } from "../subagents/AgentsPanel";
import { SubagentPanel } from "../subagents/SubagentPanel";
import { afterMotion, createPresence } from "../../motion/presence";
import { applyDockWidth, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH } from "../../prefs/dock";
import { backFromDock, setDockWidth } from "../../store/dock";
import { state } from "../../state";

interface DockKind {
	title: string;
	body: Component<{ id?: string }>;
	/** The body scrolls and pads itself (see DockPane `flush`). */
	flush?: boolean;
	/** Header controls beside the close button (DockPane `actions`). */
	actions?: Component;
}

/** Dock panel kinds, keyed by the route's `<kind>` segment. */
const DOCK_KINDS: Record<string, DockKind> = {
	review: { title: "Git review", body: ReviewPanel },
	tree: { title: "Session tree", body: SessionTreePanel },
	agent: { title: "Agent", body: SubagentPanel, flush: true, actions: AgentsDockActions },
	agents: { title: "Agents", body: AgentsPanel, flush: true, actions: AgentsDockActions },
};

/** Focus the agents-list row for `id` once the list has mounted. */
function focusDockRow(id: string): void {
	setTimeout(() =>
		document
			.querySelector<HTMLElement>(`.dock-pane [data-subagent-id="${CSS.escape(id)}"]`)
			?.focus(),
	);
}

/** What the dock shows: the panel kind and the id it was opened on. */
interface Shown {
	kind: DockKind;
	id: string | undefined;
}

/**
 * Mounts the open dock panel beside the main pane. Unknown kinds render nothing.
 *
 * Motion: opening mounts the dock as an overlay at the right edge of the app
 * body and slides it in; when the slide ends it joins the flex row at
 * `--dock-w` (one reflow). Closing takes it out of the row first (the main
 * pane widens in one step underneath), then slides it out over the pane and
 * unmounts it. Switching panel kind while open fades the content out, swaps
 * it, and fades it in; the width never changes (one shared `--dock-w`).
 */
export const DockHost: Component = () => {
	onMount(() => applyDockWidth(state.dockWidth));
	const entry = () => {
		const dock = state.dock;
		// hasOwn: a kind such as `constructor` must not match an inherited key.
		return dock !== null && Object.hasOwn(DOCK_KINDS, dock.kind)
			? DOCK_KINDS[dock.kind]
			: undefined;
	};
	const presence = createPresence(() => entry() !== undefined);

	// Content: the last open panel stays through the slide-out, and a kind
	// switch lags the store by the fade-out. `swapId` drops stale async swaps.
	const [shown, setShown] = createSignal<Shown | undefined>();
	const [swapping, setSwapping] = createSignal(false);
	let swapId = 0;
	let body: HTMLElement | undefined;
	let afterSwap: (() => void) | undefined;
	createComputed(
		on([entry, () => state.dock?.id], ([next, id], prev) => {
			if (next === undefined) {
				afterSwap = undefined;
				return;
			}
			const target = { kind: next, id };
			const current = shown();
			if (prev?.[0] === undefined || current === undefined) {
				// Opening: no fade, the slide is the motion.
				swapId++;
				setSwapping(false);
				setShown(target);
				return;
			}
			if (next === current.kind && !swapping()) {
				// Same panel retargeted (another agent): update in place.
				setShown(target);
				return;
			}
			const mine = ++swapId;
			setSwapping(true);
			// After the fade-out reaches the DOM; the latest target wins.
			queueMicrotask(async () => {
				if (body) await afterMotion(body);
				if (mine !== swapId) return;
				setShown({ kind: entry() ?? next, id: state.dock?.id ?? id });
				setSwapping(false);
				const focusAfter = afterSwap;
				afterSwap = undefined;
				if (focusAfter) setTimeout(focusAfter);
			});
		}),
	);

	// Layout: an overlay while it slides in, in the flex row once it has settled,
	// an overlay again the moment it starts to leave.
	const [docked, setDocked] = createSignal(false);
	let pane: HTMLElement | undefined;
	let dockId = 0;
	createEffect(
		on(presence.phase, (phase) => {
			const mine = ++dockId;
			if (phase !== "open") {
				setDocked(false);
				return;
			}
			queueMicrotask(async () => {
				if (pane) await afterMotion(pane);
				if (mine === dockId) setDocked(true);
			});
		}),
	);

	const onBack = () => {
		// Read the id first: backFromDock merges into the same store object.
		const agentId = state.dock?.kind === "agent" ? state.dock.id : undefined;
		backFromDock();
		// The agents list mounts after the content fade; focus its row then.
		if (agentId !== undefined) afterSwap = () => focusDockRow(agentId);
	};
	return (
		<Show when={presence.mounted() ? shown() : undefined}>
			{(content) => (
				<DockPane
					title={content().kind.title}
					width={state.dockWidth}
					minWidth={DOCK_MIN_WIDTH}
					maxWidth={DOCK_MAX_WIDTH}
					onWidth={setDockWidth}
					flush={content().kind.flush}
					actions={
						<Show when={content().kind.actions}>
							{(actions) => <Dynamic component={actions()} />}
						</Show>
					}
					onClose={onBack}
					phase={presence.phase()}
					overlay={!docked()}
					swapping={swapping()}
					paneRef={(el) => {
						pane = el;
						presence.ref(el);
					}}
					bodyRef={(el) => (body = el)}
				>
					<Dynamic component={content().kind.body} id={content().id} />
				</DockPane>
			)}
		</Show>
	);
};
