import { createSignal, type Component } from "solid-js";
import { copyText } from "./Markdown";

/** How long the transient "copied"/"failed" label shows before reverting to "copy". */
export const COPY_FEEDBACK_MS = 1200;

/**
 * Copy-to-clipboard button that flips its label to "copied" briefly after a
 * successful copy. `text` may be an accessor so callers can resolve the
 * payload at click time (e.g. a still-streaming assistant message).
 */
export const CopyButton: Component<{
	text: string | (() => string);
	title?: string;
	class?: string;
}> = (props) => {
	const [copied, setCopied] = createSignal(false);
	return (
		<button
			class={props.class}
			type="button"
			title={props.title}
			onClick={(e) => {
				e.stopPropagation();
				const text = typeof props.text === "function" ? props.text() : props.text;
				void copyText(text).then((ok) => {
					setCopied(ok);
					setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
				});
			}}
		>
			{copied() ? "copied" : "copy"}
		</button>
	);
};
