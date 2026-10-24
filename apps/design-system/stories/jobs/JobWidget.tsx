import { JobWidget, JobWidgetGlance } from "../../../web/components/jobs/JobWidget";
import {
	authoringWidget,
	benchWidget,
	blockWidgets,
	emptyWidget,
	fallbackWidget,
	subagentWidget,
} from "../../fixtures/job-widgets";
import { defineStory } from "../../registry";

export default defineStory({
	id: "jobs-job-widget",
	title: "JobWidget",
	section: "Job widgets",
	component: [
		{ file: "apps/web/components/jobs/JobWidget.tsx", export: "JobWidget" },
		{ file: "apps/web/components/jobs/JobWidget.tsx", export: "JobWidgetGlance" },
	],
	variants: [
		{
			name: "Everything: head and every block",
			description:
				"A spec-driven benchmark: title, stage and headline with its trend over a spark with reference lines, bars, a meter, stats, a grid and the latest line. Hover the chart for per-point tips.",
			render: () => <JobWidget view={benchWidget} />,
		},
		{
			name: "Spark",
			description:
				"Area and line over the domain, dashed target and baseline, the latest value at the side.",
			render: () => <JobWidget view={blockWidgets.spark} />,
		},
		{
			name: "Bars",
			description:
				"One bar per key against a common maximum; a tone colors the bar and its figure.",
			render: () => <JobWidget view={blockWidgets.bars} />,
		},
		{
			name: "Meter",
			render: () => <JobWidget view={blockWidgets.meter} />,
		},
		{
			name: "Stat",
			description: "Labelled figures; trends are green toward better and red away from it.",
			render: () => <JobWidget view={blockWidgets.stat} />,
		},
		{
			name: "Grid",
			description:
				"One cell per key, one tone each: success, accent, pending, error, muted, warning, info, user, neutral.",
			render: () => <JobWidget view={blockWidgets.grid} />,
		},
		{
			name: "Text",
			render: () => <JobWidget view={blockWidgets.text} />,
		},
		{
			name: "Compact",
			description: "Only the primary block, as in a wait tile.",
			render: () => <JobWidget view={benchWidget} compact />,
		},
		{
			name: "Subagent",
			description: "A subagent's stage in the head over its own progress meter.",
			render: () => <JobWidget view={subagentWidget} />,
		},
		{
			name: "State: authoring",
			description:
				"The cheap model is writing the spec; the model-free fallback shows meanwhile (the badge pulses unless motion is reduced).",
			render: () => <JobWidget view={authoringWidget} />,
		},
		{
			name: "State: fallback",
			description: "No spec: the last line and rates only.",
			render: () => <JobWidget view={fallbackWidget} />,
		},
		{
			name: "Nothing matched yet",
			description: "A live widget whose blocks have no data wait for it.",
			render: () => <JobWidget view={emptyWidget} />,
		},
		{
			name: "Glance",
			description:
				"One line for a row or bar: mini chart and the headline figure with its trend, or the primary figure of a spark or meter.",
			render: () => (
				<>
					<JobWidgetGlance view={benchWidget} />
					<JobWidgetGlance view={blockWidgets.meter} />
					<JobWidgetGlance view={blockWidgets.spark} />
				</>
			),
		},
		{
			name: "Glance without a figure",
			description:
				"The state in words while authoring, the stage for a basic widget, a wait note when nothing came yet.",
			render: () => (
				<>
					<JobWidgetGlance view={authoringWidget} />
					<JobWidgetGlance view={fallbackWidget} />
					<JobWidgetGlance view={{ ...emptyWidget, blocks: [] }} />
				</>
			),
		},
	],
});
