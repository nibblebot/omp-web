import { createSignal, Show, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

/**
 * A bar button that owns its open popover, as ActivityBar does: pressing it again, Escape or an outside
 * press closes the popover. Sits at the foot of the frame's right edge like the bar's buttons, so the
 * popover opens above it.
 */
export function PopoverAnchor(props: {
	label: string;
	popover: Component<{ anchor: HTMLElement; onClose: () => void }>;
}): JSX.Element {
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(true);
	return (
		<div class="ds-frame ds-frame-bar ds-popover-host" data-x="end">
			<button
				type="button"
				class="activity-bar-button"
				ref={setAnchor}
				aria-haspopup="dialog"
				aria-expanded={open()}
				onClick={() => setOpen(!open())}
			>
				{props.label}
			</button>
			<Show when={open() ? anchor() : undefined}>
				{(el) => <Dynamic component={props.popover} anchor={el()} onClose={() => setOpen(false)} />}
			</Show>
		</div>
	);
}
