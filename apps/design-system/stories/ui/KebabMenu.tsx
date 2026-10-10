import type { JSX } from "solid-js";
import { KebabMenu } from "../../../web/components/ui/KebabMenu";
import { defineStory } from "../../registry";

/** Row actions for a session in the sidebar. */
function sessionMenuItems(): JSX.Element {
	return (
		<>
			<button type="button" role="menuitem" class="sidebar-menu-item">
				Rename session
			</button>
			<button type="button" role="menuitem" class="sidebar-menu-item">
				Copy session id
			</button>
			<button type="button" role="menuitem" class="sidebar-menu-item">
				Export transcript
			</button>
		</>
	);
}

export default defineStory({
	id: "ui-kebab-menu",
	title: "KebabMenu",
	component: { file: "apps/web/components/ui/KebabMenu.tsx", export: "KebabMenu" },
	variants: [
		{
			name: "Closed",
			description:
				"The trigger reveals when its row is hovered, as in the session list. Click it to open; Escape or an outside click closes it.",
			render: () => (
				<div class="daemon-row">
					<KebabMenu label="Session actions">{sessionMenuItems()}</KebabMenu>
				</div>
			),
		},
		{
			name: "Open (pinned)",
			description:
				"Controlled open state, pinned open for the showcase. Outside clicks request close, but the parent ignores them.",
			render: () => (
				<KebabMenu label="Session actions" open={true} onOpenChange={() => undefined}>
					{sessionMenuItems()}
				</KebabMenu>
			),
		},
	],
});
