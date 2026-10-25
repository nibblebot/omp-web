import { Card } from "../../../web/components/ui/Card";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-card",
	title: "Card",
	component: { file: "apps/web/components/ui/Card.tsx", export: "Card" },
	variants: [
		{
			name: "Plain body",
			description: "No header: the panel surface wraps the body directly.",
			render: () => (
				<div class="ds-frame">
					<Card>Body text inside the panel.</Card>
				</div>
			),
		},
		{
			name: "With header",
			description: "A header row sits above the body inside the panel.",
			render: () => (
				<div class="ds-frame">
					<Card header={<span>Header title</span>}>Body text under the header.</Card>
				</div>
			),
		},
		{
			name: "Collapsible, closed",
			description: "The header is the disclosure summary; the body is hidden until opened.",
			render: () => (
				<div class="ds-frame">
					<Card collapsible header={<span>Collapsed by default</span>}>
						Hidden body revealed on toggle.
					</Card>
				</div>
			),
		},
		{
			name: "Collapsible, open",
			description: "Starts expanded via the open prop.",
			render: () => (
				<div class="ds-frame">
					<Card collapsible open header={<span>Expanded by default</span>}>
						Body visible on first render.
					</Card>
				</div>
			),
		},
		{
			name: "With data attributes",
			description:
				"`data` adds `data-*` attributes to the root (here `data-tool-call-id`, the anchor a jump to a tool card finds); undefined values are omitted.",
			render: () => (
				<div class="ds-frame">
					<Card
						data={{ "tool-call-id": "call_12", skipped: undefined }}
						header={<span>Anchored</span>}
					>
						Inspect the root: it carries data-tool-call-id.
					</Card>
				</div>
			),
		},
	],
});
