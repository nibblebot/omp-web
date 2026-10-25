import { createSignal, type Component } from "solid-js";
import { state, toggleToolsExpanded } from "../../../state";
import { openShareSheet } from "../../../store/collab";
import { ExpandIcon } from "../../ui/icons";
import { KebabMenu } from "../../ui/KebabMenu";

/** Header kebab: expand or collapse all tool cards, and open the share sheet. */
export const ToolCardsMenu: Component = () => {
	const [open, setOpen] = createSignal(false);
	const guests = () =>
		state.collabStatus.state === "live"
			? state.collabStatus.participants.filter((p) => p.role === "guest").length
			: null;
	return (
		<span class="tool-cards-menu">
			<KebabMenu label="Session actions" open={open()} onOpenChange={setOpen}>
				<button
					type="button"
					role="menuitemcheckbox"
					class="sidebar-menu-item"
					aria-checked={state.toolsExpanded}
					title="Expand all tool cards (Ctrl+O)"
					onClick={() => toggleToolsExpanded()}
				>
					<ExpandIcon /> expand all tool cards
				</button>
				<button
					type="button"
					role="menuitem"
					class="sidebar-menu-item"
					title={guests() !== null ? "Shared session: open the share sheet" : "Share this session"}
					onClick={() => {
						setOpen(false);
						openShareSheet();
					}}
				>
					{guests() !== null ? `share session (live · ${guests()})` : "share session"}
				</button>
			</KebabMenu>
		</span>
	);
};
