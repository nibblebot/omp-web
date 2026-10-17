import type { Component } from "solid-js";

/** Shown above the composer while the user has stopped the attached session
 *  process: the transcript stays, and Restart wakes the process again. */
export const StoppedSessionStrip: Component<{ onRestart: () => void }> = (props) => (
	<div class="stopped-session-strip" role="status">
		<p class="stopped-session-text">
			Session process stopped. Restart it to continue this session.
		</p>
		<button
			type="button"
			class="segment segment-button stopped-session-restart"
			onClick={() => props.onRestart()}
			aria-label="Restart session process"
		>
			Restart
		</button>
	</div>
);
