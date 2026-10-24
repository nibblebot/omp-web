import { createMemo, For, Index, Match, Show, Switch, type Component } from "solid-js";
import type {
	WireJobWidgetBlock,
	WireJobWidgetSparkBlock,
	WireJobWidgetTrend,
	WireJobWidgetView,
} from "#lib/wire/protocol";
import {
	JOB_WIDGET_STATE_LABEL,
	jobWidgetGlance,
	jobWidgetSpark,
	jobWidgetSummary,
	meterFraction,
	SPARK_HEIGHT,
	SPARK_WIDTH,
	sparkGeometry,
	visibleBlocks,
} from "../../chat/job-widget";

/** `block` as its own kind, for a `Match`. */
function ofKind<K extends WireJobWidgetBlock["kind"]>(
	block: WireJobWidgetBlock | undefined,
	kind: K,
): Extract<WireJobWidgetBlock, { kind: K }> | undefined {
	return block?.kind === kind ? (block as Extract<WireJobWidgetBlock, { kind: K }>) : undefined;
}

const Trend: Component<{ trend: WireJobWidgetTrend }> = (props) => (
	<span class="job-widget-trend" data-tone={props.trend.tone}>
		{props.trend.text}
	</span>
);

const Waiting: Component = () => <span class="job-widget-waiting">waiting for data</span>;

/** A progress bar of a fraction (0 to 1), drawn as two rects so its width needs no inline style. */
const MeterBar: Component<{ fraction: number; label: string; text: string; tone?: string }> = (
	props,
) => (
	<svg
		class="job-widget-meter"
		data-tone={props.tone}
		viewBox="0 0 100 6"
		preserveAspectRatio="none"
		role="meter"
		aria-label={props.label}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={Math.round(props.fraction * 100)}
		aria-valuetext={props.text}
	>
		<rect class="job-widget-meter-track" width="100" height="6" />
		<rect class="job-widget-meter-fill" width={props.fraction * 100} height="6" />
	</svg>
);

const SparkBlock: Component<{ block: WireJobWidgetSparkBlock }> = (props) => {
	const geometry = createMemo(() => sparkGeometry(props.block));
	const showLabel = () => props.block.label !== "" && !props.block.last.endsWith(props.block.label);
	return (
		<div class="job-widget-spark" data-tone={props.block.tone}>
			<Show when={props.block.values.length > 0} fallback={<Waiting />}>
				<svg
					class="job-widget-chart"
					viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
					preserveAspectRatio="none"
					role="img"
					aria-label={`${props.block.label} ${props.block.last}`.trim()}
				>
					<polygon class="job-widget-area" points={geometry().area} />
					<For each={geometry().marks}>
						{(mark) => (
							<line
								class="job-widget-mark"
								data-tone={mark.tone}
								x1="0"
								x2={SPARK_WIDTH}
								y1={mark.y}
								y2={mark.y}
							>
								<title>{mark.label}</title>
							</line>
						)}
					</For>
					<polyline class="job-widget-line" points={geometry().line} />
					<Index each={props.block.tips ?? []}>
						{(tip, index) => (
							<Show when={tip() !== ""}>
								<rect
									class="job-widget-hit"
									x={(geometry().xs[index] ?? 0) - geometry().step / 2}
									y="0"
									width={geometry().step}
									height={SPARK_HEIGHT}
								>
									<title>{tip()}</title>
								</rect>
							</Show>
						)}
					</Index>
				</svg>
				<div class="job-widget-side">
					<span class="job-widget-last">{props.block.last}</span>
					<Show when={showLabel()}>
						<span class="job-widget-side-label" title={props.block.label}>
							{props.block.label}
						</span>
					</Show>
					<For each={props.block.marks ?? []}>
						{(mark) => (
							<span class="job-widget-mark-key" data-tone={mark.tone} title={mark.label}>
								<span class="job-widget-mark-swatch" aria-hidden="true" />
								{mark.label}
							</span>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};

/** One block, drawn natively: spark (area and line), bars and meter (SVG rects), stat and text (lines), grid (cells). */
const Block: Component<{ block: WireJobWidgetBlock }> = (props) => (
	<Switch>
		<Match when={ofKind(props.block, "spark")}>{(spark) => <SparkBlock block={spark()} />}</Match>
		<Match when={ofKind(props.block, "bars")}>
			{(bars) => (
				<div class="job-widget-bars">
					<div class="job-widget-caption" title={bars().label}>
						{bars().label}
					</div>
					<Show when={bars().items.length > 0} fallback={<Waiting />}>
						<Index each={bars().items}>
							{(item) => (
								<div class="job-widget-row">
									<span class="job-widget-row-label" title={item().label}>
										{item().label}
									</span>
									<MeterBar
										fraction={meterFraction(item().value, bars().max)}
										label={item().label}
										text={item().text}
										tone={item().tone}
									/>
									<span class="job-widget-row-text" data-tone={item().tone}>
										{item().text}
									</span>
								</div>
							)}
						</Index>
					</Show>
				</div>
			)}
		</Match>
		<Match when={ofKind(props.block, "meter")}>
			{(meter) => (
				<div class="job-widget-row">
					<span class="job-widget-row-label" title={meter().label}>
						{meter().label}
					</span>
					<MeterBar
						fraction={meterFraction(meter().value, 1)}
						label={meter().label}
						text={meter().text}
						tone={meter().tone}
					/>
					<span class="job-widget-row-text" data-tone={meter().tone}>
						{meter().text}
					</span>
				</div>
			)}
		</Match>
		<Match when={ofKind(props.block, "stat")}>
			{(stat) => (
				<div class="job-widget-stat">
					<Index each={stat().items}>
						{(item) => (
							<span class="job-widget-stat-item">
								<span class="job-widget-stat-label">{item().label}</span>{" "}
								<span class="job-widget-stat-text" data-tone={item().tone}>
									{item().text}
								</span>
								<Show when={item().trend}>{(trend) => <Trend trend={trend()} />}</Show>
							</span>
						)}
					</Index>
				</div>
			)}
		</Match>
		<Match when={ofKind(props.block, "grid")}>
			{(grid) => (
				<div class="job-widget-grid">
					<div class="job-widget-caption" title={grid().label}>
						{grid().label}
					</div>
					<Show when={grid().items.length > 0} fallback={<Waiting />}>
						<div class="job-widget-cells">
							<Index each={grid().items}>
								{(item) => (
									<span class="job-widget-cell" data-tone={item().tone} title={item().text}>
										{item().label}
									</span>
								)}
							</Index>
						</div>
					</Show>
				</div>
			)}
		</Match>
		<Match when={ofKind(props.block, "text")}>
			{(text) => (
				<div class="job-widget-text" title={text().text}>
					{text().text}
				</div>
			)}
		</Match>
	</Switch>
);

/**
 * A job's widget as the SDK describes it: a head (title, state while the
 * widget is not spec-driven, stage, headline with its trend) over its blocks,
 * each drawn natively. Compact shows only the primary (first) block. Draws
 * whatever the view holds, so it stays valid as polls hand it new views.
 */
export const JobWidget: Component<{ view: WireJobWidgetView; compact?: boolean }> = (props) => {
	const blocks = createMemo(() => visibleBlocks(props.view, props.compact === true));
	const updated = () =>
		props.view.updatedAt > 0
			? `Updated ${new Date(props.view.updatedAt).toLocaleTimeString()}`
			: "";
	return (
		<div
			class="job-widget"
			data-state={props.view.state}
			data-compact={props.compact ? "" : undefined}
		>
			<div class="job-widget-head">
				<span class="job-widget-title" title={props.view.title}>
					{props.view.title}
				</span>
				<Show when={props.view.state !== "live"}>
					<span class="job-widget-state" title={updated()}>
						{JOB_WIDGET_STATE_LABEL[props.view.state]}
					</span>
				</Show>
				<Show when={props.view.stage}>
					{(stage) => (
						<span class="job-widget-stage" title={stage()}>
							{stage()}
						</span>
					)}
				</Show>
				<Show when={props.view.headline}>
					{(headline) => (
						<span class="job-widget-headline">
							<Show when={headline().label}>
								<span class="job-widget-headline-label">{headline().label}</span>
							</Show>
							<span class="job-widget-headline-text">{headline().text}</span>
							<Show when={headline().trend}>{(trend) => <Trend trend={trend()} />}</Show>
						</span>
					)}
				</Show>
			</div>
			<Index each={blocks()}>{(block) => <Block block={block()} />}</Index>
		</div>
	);
};

/**
 * One line for a row or bar: a mini chart of the primary spark, then the
 * headline (or the primary figure) with its trend; with no figure yet, the
 * state in words or the stage.
 */
export const JobWidgetGlance: Component<{ view: WireJobWidgetView }> = (props) => {
	const glance = createMemo(() => jobWidgetGlance(props.view));
	const spark = createMemo(() => jobWidgetSpark(props.view));
	const geometry = createMemo(() => {
		const block = spark();
		return block ? sparkGeometry(block) : undefined;
	});
	return (
		<span
			class="job-widget-glance"
			data-state={props.view.state}
			title={jobWidgetSummary(props.view)}
		>
			<Show when={geometry()}>
				{(shape) => (
					<svg
						class="job-widget-mini"
						data-tone={spark()?.tone}
						viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						<polygon class="job-widget-area" points={shape().area} />
						<polyline class="job-widget-line" points={shape().line} />
					</svg>
				)}
			</Show>
			<Show
				when={glance()}
				fallback={
					<span class="job-widget-glance-note">
						{props.view.state === "authoring"
							? "writing widget"
							: (props.view.stage ?? "waiting for data")}
					</span>
				}
			>
				{(figure) => (
					<span class="job-widget-glance-figure">
						<Show when={figure().label}>
							<span class="job-widget-headline-label">{figure().label}</span>
						</Show>
						<span class="job-widget-headline-text">{figure().text}</span>
						<Show when={figure().trend}>{(trend) => <Trend trend={trend()} />}</Show>
					</span>
				)}
			</Show>
		</span>
	);
};
