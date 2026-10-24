import { createEffect, createSignal, on, onCleanup, type Component, type JSX } from "solid-js";
import { afterMotion, type PresencePhase } from "../../../motion/presence";
import { setMenuOpenId, menuOpenId } from "./WorkspaceRow";
import type { RowMode } from "../../../fleet-ui/row-presence";

/** An exiting row is inert, so it must leave the sidebar's roving tab-stop set
 *  (FleetSidebar queries `[data-roster-item]`) or the stop could land on an
 *  element that can never take focus. `held` swaps the marker out; a reopened
 *  row swaps it back. */
function holdRosterItems(root: HTMLElement, held: boolean): void {
	const from = held ? "data-roster-item" : "data-roster-held";
	const to = held ? "data-roster-held" : "data-roster-item";
	for (const node of root.querySelectorAll(`[${from}]`)) {
		node.removeAttribute(from);
		node.setAttribute(to, "");
	}
}

/**
 * Motion shell around one roster row (see fleet-ui/row-presence.ts for which rows get
 * which mode). The shell carries `data-motion` and every transition (height
 * via the grid track, margin, fade, 4px slide; CSS: .row-motion in fleet.css);
 * the clip inside holds the row while it is collapsed.
 *
 * - "open" at mount: rendered settled, nothing plays (page load, refreshes).
 * - "enter" at mount: rendered in the hidden state for two frames, then
 *   flipped to "open" so the transition has a starting style.
 * - "exit": flips to the hidden state (the exact reverse of enter), the row
 *   goes inert, and `onExited` fires once afterMotion resolves.
 * - Back to "open" mid-exit (or mid-enter) just changes the target: the CSS
 *   transition reverses from where it is.
 */
export const RowMotion: Component<{
	id: string;
	mode: RowMode;
	onExited: (id: string) => void;
	children: JSX.Element;
}> = (props) => {
	const [phase, setPhase] = createSignal<PresencePhase>(props.mode);
	let el!: HTMLDivElement;
	let frame = 0;
	let generation = 0;

	const cancelPending = () => {
		generation++;
		if (frame !== 0) cancelAnimationFrame(frame);
		frame = 0;
	};

	createEffect(
		on(
			() => props.mode,
			(mode) => {
				cancelPending();
				if (mode !== "exit") holdRosterItems(el, false);
				if (mode === "open") {
					setPhase("open");
					return;
				}
				if (mode === "enter") {
					// Two frames: the first paints the hidden state, the second flips it.
					const gen = generation;
					setPhase("enter");
					frame = requestAnimationFrame(() => {
						frame = requestAnimationFrame(() => {
							frame = 0;
							if (gen === generation) setPhase("open");
						});
					});
					return;
				}
				// A leaving row must not keep its menu open on itself.
				if (menuOpenId() === props.id) setMenuOpenId(null);
				holdRosterItems(el, true);
				setPhase("exit");
				const gen = generation;
				// After Solid flushes data-motion="exit" to the DOM.
				queueMicrotask(() => {
					if (gen !== generation) return;
					void afterMotion(el).then(() => {
						if (gen === generation) props.onExited(props.id);
					});
				});
			},
		),
	);
	onCleanup(cancelPending);

	return (
		<div ref={el} class="row-motion" data-motion={phase()} inert={phase() === "exit"}>
			<div class="row-motion-clip">{props.children}</div>
		</div>
	);
};
