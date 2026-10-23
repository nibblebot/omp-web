import { Show, type Component } from "solid-js";

/**
 * One already-highlighted line: the sanitized, span-balanced hljs HTML from
 * `highlightLines`/`highlightCode`, or the plain text when `html` is null.
 */
export const HighlightedLine: Component<{ html: string | null; text: string }> = (props) => (
	<Show when={props.html} fallback={props.text}>
		{(h) => (
			<span
				// eslint-disable-next-line solid/no-innerhtml -- sanitized by DOMPurify in highlightCode
				innerHTML={h()}
			/>
		)}
	</Show>
);
