import { EvalTable } from "../../../../web/components/chat/tools/EvalTable";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-eval-table",
	title: "EvalTable",
	component: { file: "apps/web/components/chat/tools/EvalTable.tsx", export: "EvalTable" },
	variants: [
		{
			name: "DataFrame, numeric columns right-aligned",
			render: () => (
				<div class="ds-frame">
					<EvalTable
						columns={[
							{ head: "", numeric: false },
							{ head: "component", numeric: false },
							{ head: "lines", numeric: true },
							{ head: "tests", numeric: true },
						]}
						rows={[
							["0", "ToolCard", "212", "4"],
							["1", "TaskToolCard", "48", "2"],
							["2", "EvalToolCard", "131", "6"],
						]}
					/>
				</div>
			),
		},
		{
			name: "Wide frame, elided cells, scrolls sideways",
			render: () => (
				<div class="ds-frame">
					<EvalTable
						columns={Array.from({ length: 12 }, (_, i) => ({
							head: i === 6 ? "\u2026" : `column_${i}`,
							numeric: i % 2 === 1,
						}))}
						rows={Array.from({ length: 4 }, (_, r) =>
							Array.from({ length: 12 }, (_, c) =>
								c === 6 ? "\u2026" : String((r + 1) * (c + 3) * 1117),
							),
						)}
					/>
				</div>
			),
		},
		{
			name: "Large frame, first rows with a show-more row",
			description:
				"The first 100 rows draw; the last row reveals 500 more per click, so a huge frame stays a small DOM.",
			render: () => (
				<div class="ds-frame">
					<EvalTable
						columns={[
							{ head: "id", numeric: true },
							{ head: "label", numeric: false },
						]}
						rows={Array.from({ length: 1500 }, (_, i) => [String(i), `row ${i}`])}
					/>
				</div>
			),
		},
	],
});
