import { createSignal, type Component } from "solid-js";
import { Tabs, tabPanelId, tabButtonId, type TabItem } from "../../../web/components/ui/Tabs";
import { defineStory } from "../../registry";

/** Owns the selected tab so the controlled `Tabs` can be shown interactively. */
const TabsDemo: Component<{ tabs: TabItem<string>[]; initial: string }> = (props) => {
	const [value, setValue] = createSignal(props.initial);
	return (
		<div class="ds-frame">
			<Tabs
				tabs={props.tabs}
				value={value()}
				onChange={setValue}
				label="Demo sections"
				idPrefix="demo"
			/>
			<div
				role="tabpanel"
				id={tabPanelId("demo", value())}
				aria-labelledby={tabButtonId("demo", value())}
			>
				Panel for {value()}.
			</div>
		</div>
	);
};

export default defineStory({
	id: "ui-tabs",
	title: "Tabs",
	component: { file: "apps/web/components/ui/Tabs.tsx", export: "Tabs" },
	variants: [
		{
			name: "Three sections",
			description: "Horizontal tablist. Arrow keys move and select; Home and End jump to the ends.",
			render: () => (
				<TabsDemo
					initial="overview"
					tabs={[
						{ id: "overview", label: "Overview" },
						{ id: "context", label: "Context" },
						{ id: "tools", label: "Tools (12)" },
					]}
				/>
			),
		},
		{
			name: "Narrow, overflowing",
			description: "Labels that do not fit the width scroll the strip instead of wrapping.",
			render: () => (
				<TabsDemo
					initial="commands"
					tabs={[
						{ id: "commands", label: "Commands" },
						{ id: "shortcuts", label: "Shortcuts" },
						{ id: "providers", label: "Provider windows" },
						{ id: "history", label: "History and exports" },
					]}
				/>
			),
		},
	],
});
