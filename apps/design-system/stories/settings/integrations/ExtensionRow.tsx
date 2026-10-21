import { createSignal, type Component } from "solid-js";
import { ExtensionRow } from "../../../../web/components/settings/integrations/ExtensionRow";
import { defineStory } from "../../../registry";

/** One row in a plain list; the switch and selection answer locally like the store would. */
const Demo: Component<{
	name: string;
	source: string;
	badge?: string;
	status?: "connected" | "connecting" | "disconnected" | "disabled";
	enabled: boolean;
	selected?: boolean;
	busy?: boolean;
}> = (props) => {
	const [enabled, setEnabled] = createSignal(props.enabled);
	const [selected, setSelected] = createSignal(props.selected ?? false);
	return (
		<ul class="extensions-list" aria-label="Extensions">
			<ExtensionRow
				name={props.name}
				source={props.source}
				badge={props.badge}
				status={props.status}
				enabled={enabled()}
				selected={selected()}
				busy={props.busy ?? false}
				onSelect={() => setSelected(true)}
				onToggle={setEnabled}
			/>
		</ul>
	);
};

export default defineStory({
	id: "settings-integrations-extension-row",
	title: "ExtensionRow",
	component: {
		file: "apps/web/components/settings/integrations/ExtensionRow.tsx",
		export: "ExtensionRow",
	},
	variants: [
		{
			name: "Skill",
			description: "Name, provider, and the switch.",
			render: () => <Demo name="pdf-extract" source="OMP (project)" enabled />,
		},
		{
			name: "Hidden skill, off",
			render: () => <Demo name="changelog" source="Agents (user)" badge="hidden" enabled={false} />,
		},
		{
			name: "MCP server, selected",
			description: "Connection dot and status ahead of the config source.",
			render: () => (
				<Demo name="filesystem" source="project config" status="connected" enabled selected />
			),
		},
		{
			name: "MCP server, disabled",
			render: () => (
				<Demo name="postgres" source="project config" status="disabled" enabled={false} />
			),
		},
		{
			name: "Write in flight",
			description: "The switch waits for the write to land.",
			render: () => <Demo name="linear" source="user config" status="connecting" enabled busy />,
		},
	],
});
