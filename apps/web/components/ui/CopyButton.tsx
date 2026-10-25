import { createSignal, type Component } from "solid-js";
import { copyText } from "../../text/clipboard";
import { CheckIcon, ClipboardIcon } from "./icons";

/** How long the transient "copied"/"failed" label shows before reverting to "copy". */
export const COPY_FEEDBACK_MS = 1200;

/** Marks the element whose empty space the icon-mode `copiedLabel` may use:
 *  everything between its start edge and the button. */
const COPY_FEEDBACK_BOUNDS_ATTR = "data-copy-feedback-bounds";

/** Whether the label fits between the button and the bounds' start edge. */
function labelFits(button: HTMLElement, label: HTMLElement): boolean {
	const bounds = button.closest(`[${COPY_FEEDBACK_BOUNDS_ATTR}]`) ?? button.parentElement ?? button;
	const room = button.getBoundingClientRect().left - bounds.getBoundingClientRect().left;
	return room >= label.offsetWidth;
}

/**
 * Copy-to-clipboard button that flips its label to "copied" briefly after a
 * successful copy. `text` may be an accessor so callers can resolve the
 * payload at click time (e.g. a still-streaming assistant message). `icon`
 * swaps the label for a clipboard glyph that flips to a check mark, with
 * `copiedLabel` beside it when given: out of flow, so nothing moves, and shown
 * only when it fits in the free space between the button and the start edge of
 * an ancestor marked `data-copy-feedback-bounds` (never over other content;
 * the check alone confirms otherwise). `copiedLabel`, then `title`, is the
 * button's accessible name, so the confirmation reaches screen readers either way.
 */
export const CopyButton: Component<{
	text: string | (() => string);
	title?: string;
	class?: string;
	icon?: boolean;
	/** Icon mode: text shown beside the check mark while the copy feedback lasts. */
	copiedLabel?: string;
}> = (props) => {
	const [copied, setCopied] = createSignal(false);
	const [fits, setFits] = createSignal(true);
	let label: HTMLSpanElement | undefined;
	return (
		<button
			class={props.class}
			type="button"
			title={props.title}
			aria-label={
				props.icon
					? copied()
						? (props.copiedLabel ?? "Copied")
						: (props.title ?? "Copy")
					: undefined
			}
			data-copied={copied() ? "" : undefined}
			onClick={(e) => {
				e.stopPropagation();
				const button = e.currentTarget;
				const text = typeof props.text === "function" ? props.text() : props.text;
				void copyText(text).then((ok) => {
					setCopied(ok);
					// The label mounted synchronously above; measure it before the next paint.
					if (ok && label) setFits(labelFits(button, label));
					setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
				});
			}}
		>
			{props.icon ? (
				copied() ? (
					<>
						<CheckIcon />
						{props.copiedLabel && (
							<span class="copy-feedback-label" data-overflow={fits() ? undefined : ""} ref={label}>
								{props.copiedLabel}
							</span>
						)}
					</>
				) : (
					<ClipboardIcon />
				)
			) : copied() ? (
				"copied"
			) : (
				"copy"
			)}
		</button>
	);
};
