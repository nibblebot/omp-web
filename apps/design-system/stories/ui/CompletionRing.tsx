import { For } from "solid-js";
import { completionTitle } from "../../../web/activities/completion";
import { CompletionRing } from "../../../web/components/ui/CompletionRing";
import { defineStory } from "../../registry";

const PERCENTS = [0, 12, 40, 62, 99];

export default defineStory({
	id: "ui-completion-ring",
	title: "CompletionRing",
	component: { file: "apps/web/components/ui/CompletionRing.tsx", export: "CompletionRing" },
	variants: [
		{
			name: "Bands",
			description:
				"The fill goes clockwise from the top and shifts from the accent toward the success color in four bands (0, 25, 50, 75 and up). Each ring names its percent for screen readers and as its tooltip.",
			render: () => (
				<div class="ds-frame" style={{ display: "flex", gap: "16px", "align-items": "center" }}>
					<For each={PERCENTS}>
						{(percent) => (
							<span style={{ display: "inline-flex", gap: "6px", "align-items": "center" }}>
								<CompletionRing percent={percent} />
								{percent}%
							</span>
						)}
					</For>
				</div>
			),
		},
		{
			name: "Stage tooltip",
			description:
				"A subagent's stage goes in the tooltip (hover the ring) through `completionTitle`.",
			render: () => (
				<div class="ds-frame">
					<CompletionRing percent={40} title={completionTitle(40, "Writing the failing test")} />
				</div>
			),
		},
		{
			name: "Out of range",
			description:
				"Values are rounded and clamped to 0-100, so a stray estimate never overdraws the ring.",
			render: () => (
				<div class="ds-frame" style={{ display: "flex", gap: "16px", "align-items": "center" }}>
					<CompletionRing percent={-8} />
					<CompletionRing percent={62.6} />
					<CompletionRing percent={140} />
				</div>
			),
		},
	],
});
