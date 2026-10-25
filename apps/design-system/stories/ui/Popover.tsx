import { createSignal, Show, type JSX } from "solid-js";
import { Popover } from "../../../web/components/ui/Popover";
import { defineStory } from "../../registry";

/** A trigger that owns an open popover, as every popover's trigger does; re-click, Esc and an outside press close it. */
function Anchored(props: {
	side?: "above" | "below";
	align?: "start" | "end";
	width?: number;
	/** Which side of its frame the trigger sits on. */
	x: "start" | "end";
	/** At the head of the frame instead of the foot. */
	top?: boolean;
}): JSX.Element {
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(true);
	return (
		<div
			class={`ds-frame ds-frame-bar ds-popover-host${props.top === true ? " ds-frame-bar-top" : ""}`}
			data-x={props.x}
		>
			<button type="button" ref={setAnchor} aria-expanded={open()} onClick={() => setOpen(!open())}>
				Anchor
			</button>
			<Show when={open() ? anchor() : undefined}>
				{(el) => (
					<Popover
						anchor={el()}
						onClose={() => setOpen(false)}
						label="Example popover"
						side={props.side}
						align={props.align}
						width={props.width}
					>
						<p class="ds-popover-note">
							Surface only: placement, close and focus behavior. Content brings its own layout.
						</p>
					</Popover>
				)}
			</Show>
		</div>
	);
}

export default defineStory({
	id: "ui-popover",
	title: "Popover",
	component: { file: "apps/web/components/ui/Popover.tsx", export: "Popover" },
	// Fixed-position surfaces from several variants would stack over each other.
	tabs: true,
	variants: [
		{
			name: "Above (default)",
			description:
				"Opens above the anchor, left edge aligned. Escape or an outside press closes it; Escape with focus inside returns focus to the anchor.",
			render: () => <Anchored x="start" />,
		},
		{
			name: "Below",
			description: "The preferred side is below the anchor.",
			render: () => <Anchored x="start" top side="below" />,
		},
		{
			name: "Aligned to the end",
			description: "The popover's right edge lines up with the anchor's.",
			render: () => <Anchored x="end" align="end" />,
		},
		{
			name: "Clamped to the viewport",
			description: "An anchor near the right edge: the popover stays inside the viewport margin.",
			render: () => <Anchored x="end" width={420} />,
		},
		{
			name: "Flips when short of room",
			description:
				"The anchor at the top of its frame: when the room above is short the popover flips below; scroll the page to see it choose.",
			render: () => <Anchored x="start" top />,
		},
	],
});
