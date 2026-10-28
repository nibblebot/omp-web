import { Show, type Component } from "solid-js";

/**
 * A one-line progress label with a highlight sweeping across its glyphs (styles/chat.css, `.shimmer-text`).
 * The sweep is a second, aria-hidden copy of the text inside a sliding window, so it animates by transform
 * only (compositor, no main-thread paint) and exists only while there is text to light up. The look follows
 * `data-shimmer` on an ancestor (`kitt`, `disabled`) and prefers-reduced-motion.
 */
export const ShimmerText: Component<{ text: string }> = (props) => (
	<span class="shimmer-text">
		{props.text}
		<Show when={props.text !== ""}>
			<span class="shimmer-band" aria-hidden="true">
				<span class="shimmer-copy">{props.text}</span>
			</span>
		</Show>
	</span>
);
