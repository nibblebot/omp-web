import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { ShellVizRowDto, ShellVizVariableDto } from "#lib/wire/protocol";
import {
	shellVizOmitted,
	shellVizReplayable,
	shellVizRows,
	shellVizTimelineLabel,
	type ShellVizMode,
	type ShellVizView,
} from "../../../chat/shell-viz";
import { Tabs, tabButtonId, tabPanelId, type TabItem } from "../../ui/Tabs";

const MODES: readonly TabItem<ShellVizMode>[] = [
	{ id: "pseudo", label: "Pseudo" },
	{ id: "raw", label: "Raw" },
];

/** Rows mounted at first; a long script shows the rest on request. */
const ROWS_SHOWN = 200;
/** Nesting levels drawn as indentation. */
const MAX_INDENT = 12;

const GUTTER_MARK = { fail: "×", active: "▶" } as const;

const Variables: Component<{ variables: readonly ShellVizVariableDto[] }> = (props) => (
	<span class="shell-viz-vars">
		<For each={props.variables}>
			{(variable) => (
				<span class="shell-viz-var">
					<span class="shell-viz-var-name">{variable.name}</span>
					<span class="shell-viz-var-eq"> = </span>
					<span class="shell-viz-var-value">
						{JSON.stringify(variable.value)}
						{variable.cut ? "…" : ""}
					</span>
				</span>
			)}
		</For>
	</span>
);

const Row: Component<{ row: ShellVizRowDto }> = (props) => (
	<div
		class="shell-viz-row"
		data-gutter={props.row.gutter}
		data-dim={props.row.dim ? "" : undefined}
		data-failed={props.row.failed ? "" : undefined}
	>
		<span class="shell-viz-gutter" aria-hidden={props.row.gutter === undefined}>
			{props.row.gutter ? GUTTER_MARK[props.row.gutter] : ""}
			<Show when={props.row.gutter}>
				<span class="visually-hidden">{props.row.gutter === "fail" ? "failed" : "running"}</span>
			</Show>
		</span>
		<span class="shell-viz-line">
			<span class="shell-viz-indent" aria-hidden="true">
				{"  ".repeat(Math.min(props.row.depth, MAX_INDENT))}
			</span>
			<Show when={props.row.effects}>
				<span class="shell-viz-effects">{props.row.effects} </span>
			</Show>
			<For each={props.row.segments}>
				{(segment) => (
					<>
						<Show when={segment.failed}>
							<span class="shell-viz-fail-mark">
								<span aria-hidden="true">× </span>
								<span class="visually-hidden">failed: </span>
							</span>
						</Show>
						<span
							class="shell-viz-seg"
							data-tone={segment.tone}
							data-dim={segment.dim ? "" : undefined}
						>
							{segment.text}
						</span>
					</>
				)}
			</For>
			<Show when={props.row.meta}>
				<span class="shell-viz-meta" data-failed={props.row.failed ? "" : undefined}>
					{"  "}
					{props.row.meta}
				</span>
			</Show>
			<Show when={props.row.variables}>
				{(variables) => (
					<span class="shell-viz-annotation">
						{"  ‹ "}
						<Variables variables={variables()} />
						{" ›"}
					</span>
				)}
			</Show>
		</span>
	</div>
);

/**
 * The SDK's presentation of one bash call's shell trace: a Pseudo (Python-like) and a Raw
 * rendering behind tabs, failed commands marked, the latest variable values after the statement that
 * set them, and, for a finished run, a replay scrubber over the retained history.
 */
export const ShellVisualization: Component<{
	view: ShellVizView;
	mode: ShellVizMode;
	onMode: (mode: ShellVizMode) => void;
	/** Replay position being shown or dragged to (history records applied). */
	cursor: number;
	/** The scrubber moved to this many history records. */
	onCursor: (cursor: number) => void;
	/** The scrubber's answer is still loading. */
	busy?: boolean;
	/** Keeps tab and panel ids unique when several visualizations are mounted. */
	idPrefix: string;
}> = (props) => {
	const rows = createMemo(() => shellVizRows(props.view, props.mode));
	const [limit, setLimit] = createSignal(ROWS_SHOWN);
	const hidden = () => Math.max(0, rows().length - limit());
	return (
		<div class="shell-viz-body" aria-busy={props.busy ? "true" : undefined}>
			<Tabs
				tabs={MODES}
				value={props.mode}
				onChange={props.onMode}
				label="Rendering"
				idPrefix={props.idPrefix}
			/>
			<Show when={shellVizReplayable(props.view)}>
				<div class="shell-viz-replay">
					<input
						class="shell-viz-scrubber"
						type="range"
						min="0"
						max={props.view.timeline.length}
						step="1"
						value={props.cursor}
						aria-label="Replay position"
						onInput={(e) => props.onCursor(Number(e.currentTarget.value))}
					/>
					<span class="shell-viz-replay-label">{shellVizTimelineLabel(props.view.timeline)}</span>
					<Show when={props.cursor < props.view.timeline.length}>
						<button
							type="button"
							class="shell-viz-live"
							onClick={() => props.onCursor(props.view.timeline.length)}
						>
							Jump to end
						</button>
					</Show>
				</div>
			</Show>
			<div
				class="shell-viz-rows"
				role="tabpanel"
				id={tabPanelId(props.idPrefix, props.mode)}
				aria-labelledby={tabButtonId(props.idPrefix, props.mode)}
				tabIndex={0}
			>
				<For each={rows().slice(0, limit())}>{(row) => <Row row={row} />}</For>
				<Show when={hidden() > 0}>
					<button
						type="button"
						class="tool-collapsed-note"
						onClick={() => setLimit((n) => n + 400)}
					>
						Show {Math.min(hidden(), 400)} more rows
					</button>
				</Show>
				<Show when={shellVizOmitted(props.view, props.mode) > 0}>
					<p class="shell-viz-note" role="note">
						{shellVizOmitted(props.view, props.mode)} more rows left out to fit the answer.
					</p>
				</Show>
			</div>
			<Show when={props.view.historyTrimmed}>
				<p class="shell-viz-note">Replay history was trimmed to the SDK's retention limits.</p>
			</Show>
			<Show when={props.view.message}>
				<p class="shell-viz-note">{props.view.message}</p>
			</Show>
		</div>
	);
};
