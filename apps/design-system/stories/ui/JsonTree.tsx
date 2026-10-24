import { JsonTree } from "../../../web/components/ui/JsonTree";
import { defineStory } from "../../registry";

const value = {
	name: "omp-web",
	private: true,
	scripts: { dev: "bun scripts/dev.ts", test: "bun scripts/test.ts" },
	workers: [1, 2, 3],
	retry: { max: 3, backoffMs: 250, jitter: null, enabled: true },
	note: "x".repeat(300),
	empty: {},
};

export default defineStory({
	id: "ui-json-tree",
	title: "JsonTree",
	component: { file: "apps/web/components/ui/JsonTree.tsx", export: "JsonTree" },
	variants: [
		{
			name: "Root open, nested folded",
			description:
				"Objects and arrays are disclosure rows with their size; scalars are colored by type.",
			render: () => (
				<div class="ds-frame">
					<JsonTree value={value} />
				</div>
			),
		},
		{
			name: "Two levels open",
			render: () => (
				<div class="ds-frame">
					<JsonTree value={value} openDepth={2} />
				</div>
			),
		},
		{
			name: "Long array, capped at 100 entries",
			render: () => (
				<div class="ds-frame">
					<JsonTree value={Array.from({ length: 130 }, (_, i) => i * 3)} />
				</div>
			),
		},
		{ name: "Scalar root", render: () => <JsonTree value="just a string" /> },
	],
});
