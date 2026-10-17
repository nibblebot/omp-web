import type { Component } from "solid-js";
import { state, toggleToolsExpanded } from "../../../state";
import { ExpandIcon } from "../../ui/icons";
import { KebabMenu } from "../../ui/KebabMenu";

/** Header kebab: the one global control for tool cards (expand or collapse all). */
export const ToolCardsMenu: Component = () => (
	<span class="tool-cards-menu">
		<KebabMenu label="Transcript">
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
		</KebabMenu>
	</span>
);
