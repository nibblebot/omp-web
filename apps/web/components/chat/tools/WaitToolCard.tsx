import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	type Component,
} from "solid-js";
import type { WireWaitJob } from "#lib/wire/protocol";
import {
	jobElapsedMs,
	jobTitle,
	waitCounts,
	waitSummary,
	waitViewOf,
	WAIT_TILES_SHOWN,
	type WaitAgent,
	type WaitView,
} from "../../../chat/wait-details";
import type { ToolItem } from "../../../state";
import { formatDuration } from "../../../subagents/format";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

const TILE_GLYPH: Record<WireWaitJob["status"], string> = {
	running: "\u25cf",
	completed: "\u2713",
	failed: "\u2715",
	cancelled: "\u25a0",
};

/** Ring fill bands (0 to 4): the ring shifts from the accent toward the success color as the estimate grows. */
const ringBand = (percent: number): number => Math.min(4, Math.floor(percent / 25));

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** A subagent's own completion estimate, as a ring. */
const CompletionRing: Component<{ percent: number }> = (props) => {
	const percent = () => Math.max(0, Math.min(100, Math.round(props.percent)));
	return (
		<svg
			class="wait-tile-ring"
			viewBox="0 0 20 20"
			role="img"
			aria-label={`Completion estimate ${percent()}%`}
			data-band={ringBand(percent())}
		>
			<title>{`The agent's own completion estimate: ${percent()}%`}</title>
			<circle class="wait-tile-ring-track" cx="10" cy="10" r={RING_RADIUS} />
			<circle
				class="wait-tile-ring-fill"
				cx="10"
				cy="10"
				r={RING_RADIUS}
				stroke-dasharray={`${(RING_CIRCUMFERENCE * percent()) / 100} ${RING_CIRCUMFERENCE}`}
			/>
		</svg>
	);
};

/**
 * One watched job: status glyph (pulsing while its call is live), name, id,
 * a subagent's completion ring and clock, then what it is doing (a subagent's
 * stage in its own words, else the failure's exit code). The job's live widget
 * (charts and figures) would sit between the head and the note.
 */
const WaitJobTile: Component<{ job: WireWaitJob; view: WaitView; now: number }> = (props) => {
	const title = () => jobTitle(props.job);
	const note = () => {
		const label =
			props.job.type === "task" ? (props.job.label.split(/\r?\n/, 1)[0]?.trim() ?? "") : "";
		return props.job.stage ?? label;
	};
	const failure = () =>
		props.job.exitCode !== undefined && props.job.exitCode !== 0
			? `exit ${props.job.exitCode}`
			: undefined;
	return (
		<li class="wait-tile" data-status={props.job.status}>
			<div class="wait-tile-head">
				<span
					class="wait-tile-dot"
					data-pulse={props.view.live && props.job.status === "running" ? "" : undefined}
					aria-hidden="true"
				>
					{TILE_GLYPH[props.job.status]}
				</span>
				<span class="wait-tile-title" title={title()}>
					{title()}
				</span>
				<Show when={props.job.id !== title()}>
					<span class="wait-tile-id">{props.job.id}</span>
				</Show>
				<Show when={props.job.completionPercent !== undefined}>
					<CompletionRing percent={props.job.completionPercent ?? 0} />
				</Show>
				<span class="wait-tile-clock">
					{formatDuration(jobElapsedMs(props.job, props.view, props.now))}
				</span>
				<span class="visually-hidden">{props.job.status}</span>
			</div>
			<Show when={failure() || note()}>
				<div class="wait-tile-note">
					<Show when={failure()}>
						<span class="wait-tile-failure">{failure()}</span>
					</Show>
					{failure() && note() ? " \u00b7 " : ""}
					{note()}
				</div>
			</Show>
		</li>
	);
};

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
		<span class="wait-tile-clock">{formatDuration(props.agent.ageMs)}</span>
	</li>
);

/** Clock of a running call's tiles: ticks each second while a live job runs. */
function createTileClock(view: () => WaitView | undefined): () => number {
	const [now, setNow] = createSignal(Date.now());
	createEffect(() => {
		const current = view();
		if (!current?.live || !current.jobs.some((job) => job.status === "running")) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => clearInterval(timer));
	});
	return now;
}

/**
 * wait tool: the jobs the agent is waiting on as a row of tiles (status, name,
 * what each is doing, a subagent's completion ring, clock), live while the call
 * runs and as the call settled with them. A wait with no job to show (nothing to
 * wait for, or a peer message ended it) shows its result text.
 */
export const WaitToolCard: Component<{ item: ToolItem }> = (props) => {
	const view = createMemo(() => waitViewOf(props.item));
	const now = createTileClock(view);
	const counts = createMemo(() => waitCounts(view()?.jobs ?? []));
	return (
		<ToolCardShell
			name="wait"
			arg={view() ? waitSummary(view()!) : undefined}
			status={props.item.status}
			class="wait-tool"
			meta={
				<Show when={view()}>
					<span class="wait-counts">
						<Show when={counts().completed > 0}>
							<span class="wait-count" data-status="completed">{`${counts().completed} done`}</span>
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
					</span>
				</Show>
			}
		>
			<Show
				when={view()}
				fallback={<CollapsibleOutput item={props.item} output={props.item.output} />}
			>
				{(current) => (
					<>
						{/* A job widget area (JobWidgetView blocks) would render inside each tile, under its head. */}
						<ul class="wait-tiles">
							<For each={current().jobs.slice(0, WAIT_TILES_SHOWN)}>
								{(job) => <WaitJobTile job={job} view={current()} now={now()} />}
							</For>
						</ul>
						<Show when={current().jobs.length > WAIT_TILES_SHOWN}>
							<div class="tool-collapsed-note">
								{`+${current().jobs.length - WAIT_TILES_SHOWN} more ${current().jobs.length - WAIT_TILES_SHOWN === 1 ? "job" : "jobs"}`}
							</div>
						</Show>
						<Show when={current().agents.length > 0}>
							<ul class="wait-agents">
								<For each={current().agents}>{(agent) => <WaitAgentRow agent={agent} />}</For>
							</ul>
						</Show>
						<Show when={current().interrupted}>
							<div class="tool-meta">Interrupted by a message</div>
						</Show>
					</>
				)}
			</Show>
		</ToolCardShell>
	);
};
