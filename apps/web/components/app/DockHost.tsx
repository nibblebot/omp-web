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
import { featureDock, type DockPanel } from "../../features/registry";
import { ActivitiesModeToggle } from "../activities/ActivitiesModeToggle";
import { ActivitiesPanel } from "../activities/ActivitiesPanel";
import { SessionTreePanel } from "../sessions/SessionTreePanel";
import { afterMotion, createPresence } from "../../motion/presence";
import { applyDockWidth, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH } from "../../prefs/dock";
import { backFromDock, dismissDock, setDockWidth } from "../../store/dock";
import { state } from "../../state";

/** Core dock panel kinds, keyed by the route's `<kind>` segment; features add theirs through the registry (`featureDock`). */
const DOCK_KINDS: Record<string, DockPanel> = {
	tree: { title: "Session tree", body: SessionTreePanel },
	activities: {
		title: "Activities",
		body: ActivitiesPanel,
		flush: true,
		actions: ActivitiesModeToggle,
	},
};

/**
 * Mounts the open dock panel beside the main pane. Unknown kinds render nothing.
 *
 * Motion: opening mounts the dock as an overlay at the right edge of the app
 * body and slides it in; when the slide ends it joins the flex row at
 * `--dock-w` (one reflow). Closing takes it out of the row first (the main
 * pane widens in one step underneath), then slides it out over the pane and
 * unmounts it. Switching panel kind while open fades the content out, swaps
 * it, and fades it in; the width never changes (one shared `--dock-w`). The
 * Activities panel's own view changes (mode toggle, detail) are not kind
 * switches: the panel re-renders in place.
 */
export const DockHost: Component = () => {
	onMount(() => applyDockWidth(state.dockWidth));
	const entry = () => {
		const dock = state.dock;
		if (dock === null) return undefined;
		// hasOwn: a kind such as `constructor` must not match an inherited key.
		if (Object.hasOwn(DOCK_KINDS, dock.kind)) return DOCK_KINDS[dock.kind];
		// A saved layout or route can name a panel whose feature is off; it stays closed.
		return featureDock(dock.kind);
	};
	const presence = createPresence(() => entry() !== undefined);

	// Content: the last open panel stays through the slide-out, and a kind
	// switch lags the store by the fade-out. `swapId` drops stale async swaps.
	const [shown, setShown] = createSignal<DockPanel | undefined>();
	const [swapping, setSwapping] = createSignal(false);
	let swapId = 0;
	let body: HTMLElement | undefined;
	createComputed(
		on(entry, (next, prev) => {
			if (next === undefined) return;
			const current = shown();
			if (prev === undefined || current === undefined) {
				// Opening: no fade, the slide is the motion.
				swapId++;
				setSwapping(false);
				setShown(next);
				return;
			}
			if (next === current && !swapping()) return;
			const mine = ++swapId;
			setSwapping(true);
			// After the fade-out reaches the DOM; the latest target wins.
			queueMicrotask(async () => {
				if (body) await afterMotion(body);
				if (mine !== swapId) return;
				setShown(entry() ?? next);
				setSwapping(false);
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

	return (
		<Show when={presence.mounted() ? shown() : undefined}>
			{(kind) => (
				<DockPane
					title={kind().title}
					width={state.dockWidth}
					minWidth={DOCK_MIN_WIDTH}
					maxWidth={DOCK_MAX_WIDTH}
					onWidth={setDockWidth}
					flush={kind().flush}
					actions={
						<Show when={kind().actions}>{(actions) => <Dynamic component={actions()} />}</Show>
					}
					onBack={backFromDock}
					onClose={dismissDock}
					phase={presence.phase()}
					overlay={!docked()}
					swapping={swapping()}
					paneRef={(el) => {
						pane = el;
						presence.ref(el);
					}}
					bodyRef={(el) => (body = el)}
				>
					<Dynamic component={kind().body} />
				</DockPane>
			)}
		</Show>
	);
};
