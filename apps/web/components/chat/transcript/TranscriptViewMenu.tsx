import { For, type Component } from "solid-js";
import { setState, state } from "../../../state";
import { ExpandIcon } from "../../ui/icons";
import { KebabMenu } from "../../ui/KebabMenu";

export const TOOL_CARD_VIEWS = ["expanded", "collapsed", "consolidated"] as const;

/** Transcript view toggles (tool-card view, expand-all) folded into a menu for
 *  the MainHeader actions slot. Mirrors the inline `.stream-toolbar` controls,
 *  which hide below 768px; this menu is shown only below 768px (chat.css). */
export const TranscriptViewMenu: Component = () => (
	<span class="transcript-view-menu">
		<KebabMenu label="Transcript view">
			<For each={TOOL_CARD_VIEWS}>
				{(mode) => (
					<button
						type="button"
						role="menuitemradio"
						class="sidebar-menu-item"
						aria-checked={state.toolCardsView === mode}
						title={`Show tool cards: ${mode}`}
						onClick={() => setState("toolCardsView", mode)}
					>
						{mode}
					</button>
				)}
			</For>
			<button
				type="button"
				role="menuitemcheckbox"
				class="sidebar-menu-item"
				aria-checked={state.toolsExpanded}
				title="Expand all tool outputs (Ctrl+O)"
				onClick={() => setState("toolsExpanded", (v) => !v)}
			>
				<ExpandIcon /> expand
			</button>
		</KebabMenu>
	</span>
);
