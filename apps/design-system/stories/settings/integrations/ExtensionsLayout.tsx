import type { JSX } from "solid-js";
import { ExtensionsLayout } from "../../../../web/components/settings/integrations/ExtensionsLayout";
import { setState } from "../../../../web/state";
import { defineStory } from "../../../registry";

/** A column host like the dialog's body; `narrow` squeezes it so the layout drills. */
const Host = (props: { narrow?: boolean; children: JSX.Element }) => (
	<div
		class="ds-frame ds-frame-column ds-frame-panel"
		classList={{ "ds-frame-narrow": props.narrow }}
	>
		{props.children}
	</div>
);

/** Plain placeholder slots: the tabs fill them with rows, notices, and a detail panel. */
const Layout = (props: { actions?: boolean }) => (
	<ExtensionsLayout
		search="Search items"
		actions={
			props.actions ? (
				<button type="button" class="settings-control-btn">
					Add
				</button>
			) : undefined
		}
		list={<div class="tool-collapsed-note">The list goes here.</div>}
		detail={<div class="tool-collapsed-note">The selected item's detail goes here.</div>}
	/>
);

export default defineStory({
	id: "settings-integrations-extensions-layout",
	title: "ExtensionsLayout",
	component: {
		file: "apps/web/components/settings/integrations/ExtensionsLayout.tsx",
		export: "ExtensionsLayout",
	},
	variants: [
		{
			name: "Wide",
			description: "Search over the list, the detail beside it.",
			render: () => (
				<Host>
					<Layout />
				</Host>
			),
		},
		{
			name: "With an action",
			description: "A button beside the search, as the MCP tab's Add server.",
			render: () => (
				<Host>
					<Layout actions />
				</Host>
			),
		},
		{
			name: "Narrow, detail",
			description: "The detail replaces the list, with Back above it.",
			seed: () => setState("integrations", "extensionsDrill", true),
			render: () => (
				<Host narrow>
					<Layout />
				</Host>
			),
		},
	],
});
