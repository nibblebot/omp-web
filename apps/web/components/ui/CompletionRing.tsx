import type { JSX } from "solid-js";
import { clampPercent } from "../../activities/completion";

const RING_RADIUS = 8;

/** Ring fill bands (0 to 4): the ring shifts from the accent toward the success color as the estimate grows. */
const ringBand = (percent: number): number => Math.min(4, Math.floor(percent / 25));

/**
 * A subagent's self-estimated completion as a ring that fills clockwise. The fill
 * animates between estimates (see `.completion-ring-fill`); the title defaults
 * to the label, and callers pass `completionTitle(...)` for a richer tooltip.
 */
export function CompletionRing(props: {
	percent: number;
	title?: string;
	class?: string;
}): JSX.Element {
	const percent = () => clampPercent(props.percent);
	const label = () => `Completion estimate ${percent()}%`;
	return (
		<svg
			class={props.class === undefined ? "completion-ring" : `completion-ring ${props.class}`}
			viewBox="0 0 20 20"
			role="img"
			aria-label={label()}
			data-band={ringBand(percent())}
		>
			<title>{props.title ?? label()}</title>
			<circle class="completion-ring-track" cx="10" cy="10" r={RING_RADIUS} />
			<circle
				class="completion-ring-fill"
				cx="10"
				cy="10"
				r={RING_RADIUS}
				pathLength="100"
				stroke-dasharray="100"
				stroke-dashoffset={100 - percent()}
			/>
		</svg>
	);
}
