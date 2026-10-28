import type { Component } from "solid-js";
import { createNow } from "../../../activities/clock";
import { state } from "../../../state";

/** "last frame" readout with its own 1s tick. Isolated so the per-second
 *  `now` update re-renders only this fact, not the fleet tables or log rings:
 *  the ticking clock text reads `now()` locally; everything else consumes
 *  static data (fleet payload, transport ring, lastFrameAt). */
export const LastFrameClock: Component = () => {
	const now = createNow();

	const secondsSinceLastFrame = () => {
		if (state.lastFrameAt <= 0) return null;
		return Math.max(0, Math.round((now() - state.lastFrameAt) / 1000));
	};

	return (
		<div class="debug-fact">
			<span class="debug-label">last frame</span>
			<span class="debug-value">
				{secondsSinceLastFrame() === null ? "never" : `${secondsSinceLastFrame()}s ago`}
			</span>
		</div>
	);
};
