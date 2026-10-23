import { createMemo, Show, type Component } from "solid-js";
import { highlightCode } from "../../../text/highlight";

/**
 * Syntax-highlighted inline text: sanitized hljs HTML once highlight.js has
 * loaded and `lang` is registered, the plain (escaped) text otherwise. Renders
 * a fragment, so the caller owns the container (`span.tool-arg`, `pre`).
 */
export const HighlightedText: Component<{ code: string; lang: string | undefined }> = (props) => {
	// highlightCode reads highlightReady(), so the memo re-runs after the lazy load.
	const html = createMemo(() => highlightCode(props.code, props.lang));
	return (
		<Show when={html()} fallback={props.code}>
			{(h) => (
				<span
					// eslint-disable-next-line solid/no-innerhtml -- sanitized by DOMPurify in highlightCode
					innerHTML={h()}
				/>
			)}
		</Show>
	);
};
