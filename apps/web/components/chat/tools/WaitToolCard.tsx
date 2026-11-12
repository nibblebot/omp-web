import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { WireWaitJob } from "#lib/wire/protocol";
import { jumpToToolCard } from "../../../chat/tool-jump";
import { waitCounts, type WaitAgent } from "../../../chat/wait-details";
import { mergeWaitRun, waitMarksText, waitSummary } from "../../../chat/wait-runs";
import { createVisibleInterval } from "../../../page-visibility";
import type { ToolItem } from "../../../state";
import { openActivities } from "../../../store/activities";
import { formatDuration } from "../../../subagents/format";
import { CollapsibleOutput, ToolCallIdContext, ToolCardShell } from "./ToolCardShell";
import { WaitJobRow } from "./WaitJobRow";

/** Job rows a card shows before it counts the rest; rows the reader opened stay visible regardless. */
const ROWS_SHOWN = 8;

/** Progress bar segments, in the order they fill from the left. */
const BAR_ORDER: readonly WireWaitJob["status"][] = ["completed", "failed", "cancelled", "running"];

const BAR_WIDTH = 100;

const WaitAgentRow: Component<{ agent: WaitAgent }> = (props) => (
	<li class="wait-agent">
		<span class="wait-agent-badge" data-live={props.agent.live ? "" : undefined}>
			{props.agent.live ? "agent" : "agent \u00b7 no turn"}
		</span>
		<span class="wait-agent-id">{props.agent.id}</span>
		<Show when={props.agent.activity}>
			<span class="wait-agent-activity">{props.agent.activity}</span>
		</Show>
		<Show when={props.agent.parentId}>
			<span class="wait-agent-parent">{`\u2190 ${props.agent.parentId}`}</span>
		</Show>
		<span class="wait-job-clock">{formatDuration(props.agent.ageMs)}</span>
	</li>
);

/** The jobs' outcome as one slim bar: done, failed, cancelled and running in proportion to the job count. */
const WaitProgressBar: Component<{ counts: Record<WireWaitJob["status"], number> }> = (props) => {
	const total = () => BAR_ORDER.reduce((sum, status) => sum + props.counts[status], 0);
	const segments = () => {
		let x = 0;
		return BAR_ORDER.flatMap((status) => {
			const count = props.counts[status];
			if (count === 0) return [];
			const width = (count / total()) * BAR_WIDTH;
			const segment = { status, x, width };
			x += width;
			return [segment];
		});
	};
	return (
		<svg
			class="wait-bar"
			viewBox={`0 0 ${BAR_WIDTH} 4`}
			preserveAspectRatio="none"
			role="img"
			aria-label={`${props.counts.completed} done, ${props.counts.failed} failed, ${props.counts.cancelled} cancelled, ${props.counts.running} running of ${total()} jobs`}
		>
			<rect class="wait-bar-track" width={BAR_WIDTH} height="4" />
			<For each={segments()}>
				{(segment) => (
					<rect
						class="wait-bar-segment"
						data-status={segment.status}
						x={segment.x}
						width={segment.width}
						height="4"
					/>
				)}
			</For>
		</svg>
	);
};

/**
 * Clock of a running call's rows: ticks each second while a job of the live
 * frame runs, so a row's clock advances between frames.
 */
function createRowClock(ticking: () => boolean): () => number {
	const [now, setNow] = createSignal(Date.now());
	createEffect(() => {
		if (!ticking()) return;
		setNow(Date.now());
		createVisibleInterval(() => setNow(Date.now()), 1000);
	});
	return now;
}

/**
 * wait tool: every job the agent waited on across consecutive wait calls, one
 * compact row each (status, kind, title, glance, ring, clock), under a header
 * with the summary, a segmented progress bar and the counts. A row opens in
 * place to its widget, output tail and actions. The calls of a run are folded
 * by `chat/wait-runs.ts`; the card renders at the first and stays mounted as
 * the run grows. A wait that returned a peer message (`details.waited`, only in
 * transcripts before SDK 18.18.9; since then the message is its own
 * `AgentMessageCard` and the wait just reads interrupted), or found nothing to
 * wait for, shows its result text. `originOf` lets a row find the card that
 * started its job.
 */
export const WaitToolCard: Component<{
	calls: readonly ToolItem[];
	originOf?: (jobId: string) => ToolItem | undefined;
}> = (props) => {
	const view = createMemo(() => mergeWaitRun(props.calls));
	const counts = createMemo(() => waitCounts(view().jobs.map((entry) => entry.job)));
	const now = createRowClock(() =>
		view().jobs.some((entry) => entry.job.status === "running" && entry.at !== undefined),
	);
	const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
	const toggle = (id: string) =>
		setExpanded((open) => {
			const next = new Set(open);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const shown = createMemo(() =>
		view()
			.jobs.filter((entry, index) => index < ROWS_SHOWN || expanded().has(entry.job.id))
			.map((entry) => entry.job.id),
	);
	const hidden = () => view().jobs.length - shown().length;
	const entryOf = (id: string) => view().jobs.find((entry) => entry.job.id === id);
	const origins = createMemo(() => {
		const found = new Map<string, string>();
		for (const id of shown()) {
			const card = props.originOf?.(id);
			if (card) found.set(id, card.toolCallId);
		}
		return found;
	});
	const hasRows = () => view().jobs.length > 0 || view().agents.length > 0;
	const marks = () => waitMarksText(view());
	const last = () => props.calls[props.calls.length - 1];
	return (
		<ToolCallIdContext.Provider value={props.calls[0]?.toolCallId}>
			<ToolCardShell
				name="wait"
				arg={hasRows() ? waitSummary(view()) : undefined}
				status={last()?.status}
				class="wait-tool"
				meta={
					<Show when={view().jobs.length > 0}>
						<WaitProgressBar counts={counts()} />
						<span class="wait-counts">
							<Show when={counts().running > 0}>
								<span
									class="wait-count"
									data-status="running"
								>{`${counts().running} running`}</span>
							</Show>
							<Show when={counts().completed > 0}>
								<span
									class="wait-count"
									data-status="completed"
								>{`${counts().completed} done`}</span>
							</Show>
							<Show when={counts().failed > 0}>
								<span class="wait-count" data-status="failed">{`${counts().failed} failed`}</span>
							</Show>
							<Show when={counts().cancelled > 0}>
								<span
									class="wait-count"
									data-status="cancelled"
								>{`${counts().cancelled} cancelled`}</span>
							</Show>
							<Show when={view().waits > 1}>
								<span class="wait-count" data-status="waits">{`${view().waits} waits`}</span>
							</Show>
						</span>
					</Show>
				}
			>
				<Show
					when={hasRows()}
					fallback={
						<Show
							when={props.calls.length === 1 && props.calls[0]}
							fallback={
								<Show when={marks()}>{(text) => <div class="wait-marks">{text()}</div>}</Show>
							}
						>
							{(call) => <CollapsibleOutput item={call()} output={call().output} />}
						</Show>
					}
				>
					<Show when={view().jobs.length > 0}>
						<ul class="wait-jobs">
							<For each={shown()}>
								{(id) => (
									<Show when={entryOf(id)}>
										{(entry) => (
											<WaitJobRow
												entry={entry()}
												now={now()}
												expanded={expanded().has(id)}
												onToggle={() => toggle(id)}
												onJump={
													origins().has(id)
														? () => {
																const callId = origins().get(id);
																if (callId !== undefined) jumpToToolCard(callId);
															}
														: undefined
												}
											/>
										)}
									</Show>
								)}
							</For>
						</ul>
						<Show when={hidden() > 0}>
							<button
								type="button"
								class="wait-more"
								onClick={() => openActivities({ section: "jobs" })}
							>
								{`+${hidden()} more ${hidden() === 1 ? "job" : "jobs"}, open Activities`}
							</button>
						</Show>
					</Show>
					<Show when={view().agents.length > 0}>
						<ul class="wait-agents">
							<For each={view().agents}>{(agent) => <WaitAgentRow agent={agent} />}</For>
						</ul>
					</Show>
					<Show when={marks()}>{(text) => <div class="wait-marks">{text()}</div>}</Show>
				</Show>
			</ToolCardShell>
		</ToolCallIdContext.Provider>
	);
};
