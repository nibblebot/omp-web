import { SettingStepper } from "../../../../web/components/settings/controls/SettingStepper";
import { defineStory } from "../../../registry";

const contextLines = [
	{ value: "default", label: "Default" },
	{ value: "1", label: "1 line" },
	{ value: "2", label: "2 lines" },
	{ value: "5", label: "5 lines" },
];

export default [
	defineStory({
		id: "settings-control-stepper",
		title: "SettingStepper",
		component: {
			file: "apps/web/components/settings/controls/SettingStepper.tsx",
			export: "SettingStepper",
		},
		variants: [
			{
				name: "Option list",
				description: "Numeric submenu: steps through the listed options.",
				render: () => (
					<SettingStepper
						label="Context before"
						path="grep.contextBefore"
						value={2}
						options={contextLines}
						onChange={() => Promise.resolve(true)}
					/>
				),
			},
			{
				name: "Typed number with unit",
				description: "Number row: the unit comes from the path suffix (ms).",
				render: () => (
					<SettingStepper
						label="Startup timeout"
						path="mcp.startupTimeoutMs"
						value={30000}
						onChange={() => Promise.resolve(true)}
					/>
				),
			},
			{
				name: "Typed fraction",
				render: () => (
					<SettingStepper
						label="Temperature"
						path="model.temperature"
						value={0.7}
						onChange={() => Promise.resolve(true)}
					/>
				),
			},
		],
	}),
];
