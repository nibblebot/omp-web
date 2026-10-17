import { DockPane } from "../../../web/components/ui/DockPane";
import { defineStory } from "../../registry";

const body = (
	<div class="ds-frame">
		<p>Dock body content scrolls inside the pane.</p>
	</div>
);

export default defineStory({
	id: "ui-dock-pane",
	title: "DockPane",
	component: { file: "apps/web/components/ui/DockPane.tsx", export: "DockPane" },
	variants: [
		{
			name: "Default width",
			description: "A side pane with a title, a close button, and a resize handle.",
			render: () => (
				<DockPane
					title="Git review"
					width={480}
					minWidth={320}
					maxWidth={900}
					onWidth={() => undefined}
					onClose={() => undefined}
				>
					{body}
				</DockPane>
			),
		},
		{
			name: "With actions",
			description: "Header actions sit between the title and the close button.",
			render: () => (
				<DockPane
					title="Git review"
					width={480}
					minWidth={320}
					maxWidth={900}
					onWidth={() => undefined}
					onClose={() => undefined}
					actions={<button type="button">Refresh</button>}
				>
					{body}
				</DockPane>
			),
		},
		{
			name: "Minimum width",
			description: "At the minimum width the pane still shows the full header.",
			render: () => (
				<DockPane
					title="Git review"
					width={320}
					minWidth={320}
					maxWidth={900}
					onWidth={() => undefined}
					onClose={() => undefined}
				>
					{body}
				</DockPane>
			),
		},
	],
});
