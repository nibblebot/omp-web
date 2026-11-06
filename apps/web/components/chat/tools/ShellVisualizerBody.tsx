import { createEffect, createSignal, on, onCleanup, Show, untrack, type Component } from "solid-js";
import type { ShellVizDto } from "#lib/wire/protocol";
import {
	shellVizUnavailableNote,
	type ShellVizMode,
	type ShellVizView,
} from "../../../chat/shell-viz";
import { createVisibleInterval } from "../../../page-visibility";
import type { ToolItem } from "../../../state";
import { createDebouncer } from "../../../store/search-debounce";
import { fetchShellViz } from "../../../store/shell-viz";
import { ShellVisualization } from "./ShellVisualization";

type UnavailableReason = Extract<ShellVizDto, { available: false }>["reason"];

/** How often an open visualization of a running call refreshes. */
const LIVE_REFRESH_MS = 1500;
/** Pause after the scrubber stops moving before its replay position is asked for. */
const SCRUB_PAUSE_MS = 120;

let instance = 0;

export interface ShellVisualizerBodyProps {
	item: ToolItem;
	subagentId: string | undefined;
	/** The call settled with nothing to draw: the control goes away. */
	onUnavailable: () => void;
}

/** The body of an opened Visualize: fetches the call's answer, refreshes it while the call runs, and follows the replay scrubber. */
export const ShellVisualizerBody: Component<ShellVisualizerBodyProps> = (props) => {
	const idPrefix = `shell-viz-${++instance}`;
	const [view, setView] = createSignal<ShellVizView>();
	// What the body says instead of a view: why the answer is missing, or that the transport failed.
	const [problem, setProblem] = createSignal<
		{ kind: "failed"; message: string } | { kind: "unavailable"; reason: UnavailableReason }
	>();
	const [mode, setMode] = createSignal<ShellVizMode>("pseudo");
	const [cursor, setCursor] = createSignal<number | undefined>(undefined);
	const [busy, setBusy] = createSignal(false);
	const running = () => props.item.status === "running";
	// Newest request wins: a slow answer to an older cursor or poll never overwrites a newer one.
	let requested = 0;
	const scrub = createDebouncer(SCRUB_PAUSE_MS);
	onCleanup(scrub.cancel);

	async function refresh(): Promise<void> {
		const ordinal = ++requested;
		const at = untrack(cursor);
		setBusy(true);
		try {
			const answer = await fetchShellViz(props.item.toolCallId, props.subagentId, at);
			if (answer === null || ordinal !== requested) return;
			if (answer.available) {
				setProblem(undefined);
				setView(answer);
				return;
			}
			setProblem({ kind: "unavailable", reason: answer.reason });
			if (!untrack(running)) props.onUnavailable();
		} catch (err) {
			if (ordinal === requested)
				setProblem({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
		} finally {
			if (ordinal === requested) setBusy(false);
		}
	}

	// First open fetches; so does the call settling while the body is open (its final answer).
	createEffect(on(running, () => void refresh()));
	createVisibleInterval(() => {
		if (running() && cursor() === undefined) void refresh();
	}, LIVE_REFRESH_MS);

	const shownCursor = (view: ShellVizView): number => cursor() ?? view.timeline.cursor;
	const move = (view: ShellVizView, next: number): void => {
		// The end of the run is the live view: no cursor, so a late refresh keeps following it.
		setCursor(next >= view.timeline.length ? undefined : next);
		scrub.schedule(() => void refresh());
	};

	return (
		<>
			<Show when={view() === undefined && problem() === undefined}>
				<p class="shell-viz-note" role="status">
					Loading…
				</p>
			</Show>
			<Show when={problem()} keyed>
				{(current) =>
					current.kind === "failed" ? (
						<p class="shell-viz-note shell-viz-error" role="alert">
							Could not load the visualization: {current.message}{" "}
							<button type="button" class="tool-collapsed-note" onClick={() => void refresh()}>
								Retry
							</button>
						</p>
					) : (
						<p class="shell-viz-note" role="status">
							{running() ? "Waiting for the first trace." : shellVizUnavailableNote(current.reason)}
						</p>
					)
				}
			</Show>
			<Show when={view()}>
				{(current) => (
					<ShellVisualization
						view={current()}
						mode={mode()}
						onMode={setMode}
						cursor={shownCursor(current())}
						onCursor={(next) => move(current(), next)}
						busy={busy()}
						idPrefix={idPrefix}
					/>
				)}
			</Show>
		</>
	);
};
