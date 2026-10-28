import { createSignal } from "solid-js";
import type { RunJob } from "../../../../web/chat/wait-runs";
import { WaitJobRow } from "../../../../web/components/chat/tools/WaitJobRow";
import { answerCalls } from "../../../session";
import { benchEntry, seedJobWidgets } from "../../../fixtures/job-widget-entries";
import { benchWidget } from "../../../fixtures/job-widgets";
import { waitJobDetail } from "../../../fixtures/tools";
import { defineStory } from "../../../registry";

const NOW = Date.now();

const subagent: RunJob = {
	job: {
		id: "TraceRetry",
		type: "task",
		status: "running",
		label: "Trace the retry path through the outbox",
		durationMs: 94_000,
		stage: "Reading the outbox resend logic",
		completionPercent: 62,
	},
	at: NOW,
};

const evalJob: RunJob = {
	job: {
		id: "bg_1",
		type: "eval",
		status: "running",
		label: "fetch and cache the issue list",
		durationMs: 12_000,
	},
	at: NOW,
};

const failed: RunJob = {
	job: {
		id: "bg_test",
		type: "bash",
		status: "failed",
		label: "bun scripts/test.ts apps/web/test/chat",
		durationMs: 61_000,
		exitCode: 1,
	},
	settledAt: 2,
};

const done: RunJob = {
	job: {
		id: "bg_bench",
		type: "bash",
		status: "completed",
		label: "bun run bench:verb",
		durationMs: 142_000,
	},
	widget: benchWidget,
	settledAt: 0,
};

/** A row that toggles itself, as the card drives it. */
function Interactive(props: { entry: RunJob; onJump?: () => void; open?: boolean }) {
	const [open, setOpen] = createSignal(props.open === true);
	return (
		<ul class="wait-jobs">
			<WaitJobRow
				entry={props.entry}
				now={NOW}
				expanded={open()}
				onToggle={() => setOpen(!open())}
				onJump={props.onJump}
			/>
		</ul>
	);
}

export default defineStory({
	id: "chat-tools-wait-job-row",
	title: "WaitJobRow",
	component: { file: "apps/web/components/chat/tools/WaitJobRow.tsx", export: "WaitJobRow" },
	variants: [
		{
			name: "Running subagent",
			description:
				"Status dot (pulsing: its call is live), type icon, title, the agent's stage, completion ring and clock. Hover the ring for the stage and estimate. Click the row to open it.",
			seed: () => answerCalls({ getJobDetail: () => structuredClone(waitJobDetail) }),
			render: () => (
				<div class="ds-frame">
					<Interactive entry={subagent} />
				</div>
			),
		},
		{
			name: "Running, live widget",
			description:
				"A running job reads its current widget from the store: a mini chart, the headline and its trend sit between the id and the clock.",
			seed: () => {
				seedJobWidgets(1, [benchEntry()]);
				answerCalls({ getJobDetail: () => structuredClone(waitJobDetail) });
			},
			render: () => (
				<div class="ds-frame">
					<Interactive entry={evalJob} />
				</div>
			),
		},
		{
			name: "Failed, opened",
			description:
				"A non-zero exit shows in the error tone. Opened, the row adds the output tail the session answers with, and the Open in Activities action; the jump arrow scrolls to the card that started the job.",
			seed: () => answerCalls({ getJobDetail: () => structuredClone(waitJobDetail) }),
			render: () => (
				<div class="ds-frame">
					<Interactive entry={failed} open onJump={() => undefined} />
				</div>
			),
		},
		{
			name: "Completed, widget kept",
			description:
				"A settled row glances the widget its wait kept. Opened, it shows the whole widget.",
			seed: () => answerCalls({ getJobDetail: () => null }),
			render: () => (
				<div class="ds-frame">
					<Interactive entry={done} open />
				</div>
			),
		},
		{
			name: "No longer listed",
			description: "Opened after the session dropped the job: the row says so.",
			seed: () => answerCalls({ getJobDetail: () => null }),
			render: () => (
				<div class="ds-frame">
					<Interactive entry={failed} open />
				</div>
			),
		},
	],
});
