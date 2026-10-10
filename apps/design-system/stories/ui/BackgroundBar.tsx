import { BackgroundBar } from "../../../web/components/ui/BackgroundBar";
import { defineStory } from "../../registry";

interface StaticRow {
	id: string;
	label: string;
	detail: string;
}

const rows: StaticRow[] = [
	{ id: "build", label: "build", detail: "running for 42s" },
	{ id: "watch", label: "watch", detail: "idle" },
];

function rowContent(row: StaticRow) {
	return (
		<>
			<span>{row.label}</span>
			<span>{row.detail}</span>
		</>
	);
}

export default defineStory({
	id: "ui-background-bar",
	title: "BackgroundBar",
	component: { file: "apps/web/components/ui/BackgroundBar.tsx", export: "BackgroundBar" },
	variants: [
		{
			name: "Plain rows",
			description: "Static rows with no click behavior.",
			render: () => (
				<div class="ds-frame">
					<BackgroundBar items={rows} label="Static background work">
						{rowContent}
					</BackgroundBar>
				</div>
			),
		},
		{
			name: "Clickable rows",
			description: "With onRowClick each row is a keyboard-activatable button.",
			render: () => (
				<div class="ds-frame">
					<BackgroundBar
						items={rows}
						label="Clickable background work"
						onRowClick={() => undefined}
					>
						{rowContent}
					</BackgroundBar>
				</div>
			),
		},
		{
			name: "Empty",
			description: "Renders nothing while items is empty.",
			render: () => (
				<div class="ds-frame">
					<BackgroundBar<StaticRow> items={[]} label="No background work">
						{rowContent}
					</BackgroundBar>
				</div>
			),
		},
	],
});
