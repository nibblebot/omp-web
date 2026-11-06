import {
	createContext,
	createSignal,
	ErrorBoundary,
	Show,
	useContext,
	type Component,
} from "solid-js";
import { shellVisualization } from "../../../chat/display-prefs";
import { shellVizOffered } from "../../../chat/shell-viz";
import type { ToolItem } from "../../../state";
import {
	rememberShellVizUnavailable,
	shellVizKey,
	shellVizUnavailable,
} from "../../../store/shell-viz";
import { createLazyOpen } from "../../ui/lazy-open";
import { lazyComponent } from "../../ui/lazy";
import type { ShellVisualizerBodyProps } from "./ShellVisualizerBody";

/** The subagent whose transcript a bash card belongs to; absent in the session's own transcript. */
export const ShellVizSubagentContext = createContext<string>();

/** The body (the visualization view and the session fetch) loads with its own chunk, on first open. */
const ShellVisualizerBody = lazyComponent<ShellVisualizerBodyProps>(() =>
	import("./ShellVisualizerBody").then((module) => module.ShellVisualizerBody),
);

/** The body once its chunk is here; "Loading…" until then. A failed load throws to the boundary above. */
const LoadedBody: Component<ShellVisualizerBodyProps> = (props) => {
	const [loaded, setLoaded] = createSignal(false);
	// The rejection reaches the boundary through the body's own render; this call only marks arrival.
	ShellVisualizerBody.preload().then(
		() => setLoaded(true),
		() => undefined,
	);
	return (
		<>
			<Show when={!loaded()}>
				<p class="shell-viz-note" role="status">
					Loading…
				</p>
			</Show>
			<ShellVisualizerBody {...props} />
		</>
	);
};

/**
 * Visualize control of a bash card: a closed `<details>` whose body mounts, and asks the session for
 * the call's visualization, only when first opened. The browser frames carry no shell trace; the
 * session renders it on demand. The control shows for a running call and for a settled result that carries
 * the session's `details.shellTrace` marker, and not at all while `display.shellVisualization` is off; a
 * settled call the session still has no visualization for hides it.
 */
export const ShellVisualizer: Component<{ item: ToolItem }> = (props) => {
	const subagentId = useContext(ShellVizSubagentContext);
	const key = () => shellVizKey(props.item.toolCallId, subagentId);
	const lazy = createLazyOpen(false);
	return (
		<Show
			when={
				shellVisualization() &&
				props.item.toolCallId &&
				shellVizOffered(props.item) &&
				!shellVizUnavailable(key())
			}
		>
			<details class="shell-viz" onToggle={lazy.onToggle} onClick={lazy.onClick}>
				<summary class="shell-viz-summary">Visualize</summary>
				<Show when={lazy.opened()}>
					<ErrorBoundary
						fallback={(error, reset) => (
							<p class="shell-viz-note shell-viz-error" role="alert">
								Could not load the visualization:{" "}
								{error instanceof Error ? error.message : String(error)}{" "}
								<button type="button" class="tool-collapsed-note" onClick={reset}>
									Retry
								</button>
							</p>
						)}
					>
						<LoadedBody
							item={props.item}
							subagentId={subagentId}
							onUnavailable={() => rememberShellVizUnavailable(key())}
						/>
					</ErrorBoundary>
				</Show>
			</details>
		</Show>
	);
};
