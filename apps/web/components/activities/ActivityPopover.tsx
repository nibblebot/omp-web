import { Show, type Component, type JSX } from "solid-js";
import { openActivities, type ActivitySectionId } from "../../store/activities";
import { ExternalLinkIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";

/**
 * The frame the four activity popovers share: a titled header with the popout icon, the
 * condensed rows, and a "+N more" that points at the rest. The popout and "+N more" open
 * the Activities panel at the section and close the popover. Anchored above its bar button,
 * aligned to the button's right edge (the buttons sit at the bar's right).
 */
export const ActivityPopover: Component<{
	section: ActivitySectionId;
	title: string;
	anchor: HTMLElement;
	onClose: () => void;
	/** Surface width in px. */
	width?: number;
	/** Rows beyond the cap. */
	more?: number;
	children: JSX.Element;
}> = (props) => {
	const openPanel = () => {
		openActivities({ section: props.section });
		props.onClose();
	};
	return (
		<Popover
			anchor={props.anchor}
			onClose={props.onClose}
			label={props.title}
			class="activity-popover"
			align="end"
			width={props.width ?? 360}
		>
			<header class="activity-popover-head">
				<span class="activity-popover-title">{props.title}</span>
				<button
					type="button"
					class="activity-popover-popout"
					title="Open in Activities"
					aria-label={`Open ${props.title} in the Activities panel`}
					onClick={openPanel}
				>
					<ExternalLinkIcon />
				</button>
			</header>
			<div class="activity-popover-body">{props.children}</div>
			<Show when={(props.more ?? 0) > 0}>
				<button type="button" class="activity-popover-more" onClick={openPanel}>
					{`+${props.more} more`}
				</button>
			</Show>
		</Popover>
	);
};
