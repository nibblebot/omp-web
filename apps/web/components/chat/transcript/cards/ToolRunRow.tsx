import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Index,
	on,
	Show,
	type Component,
} from "solid-js";
import { expandThinkingBlocks, hideThinkingBlock } from "../../../../chat/display-prefs";
import { callRunning, type Run, type WaitRunLookup } from "../../../../chat/tool-runs";
import { state, type ToolItem } from "../../../../state";
import { formatDurationMs } from "../../../../usage/usage";
import { createLazyOpen } from "../../../ui/lazy-open";
import { Markdown } from "../../../ui/Markdown";
import { ToolCard } from "../../tools/ToolCard";
import { RunMemberContext } from "../../tools/ToolCardShell";
import { WaitToolCard } from "../../tools/WaitToolCard";
import { thinkingView } from "./AssistantCard";

/** One call of a run: a folded wait run is one card at its first call. */
const RunCall: Component<{
	item: ToolItem;
	waitRuns: WaitRunLookup;
	originOf?: (jobId: string) => ToolItem | undefined;
}> = (props) => (
	<Show when={props.waitRuns.get(props.item.id)} fallback={<ToolCard item={props.item} />}>
		{(run) => <WaitToolCard calls={run().items} originOf={props.originOf} />}
	</Show>
);

/**
 * Consolidated tool cards: one summary row per run of consecutive tool calls
 * (chat/tool-runs.ts), e.g. "4 read • 2 glob • 1 thinking • 7 req". Opening the
 * row lists the folded thinking and the run's calls as header-only cards, each
 * opening on its own click. A call that is still running shows under the row
 * even while it is closed, and folds back in once it finishes. Ctrl+O
 * (`toolsExpanded`) opens every run; a click on a row overrides it until the
 * next Ctrl+O.
 */
export const ToolRunRow: Component<{
	run: Run;
	waitRuns: WaitRunLookup;
	/** The tool item that started a job: wait cards point their job rows back at it. */
	originOf?: (jobId: string) => ToolItem | undefined;
}> = (props) => {
	const [userOpen, setUserOpen] = createSignal<boolean | null>(null);
	createEffect(
		on(
			() => state.toolsExpanded,
			() => setUserOpen(null),
			{ defer: true },
		),
	);
	const open = () => userOpen() ?? state.toolsExpanded;
	// The thinking the folded assistants would have drawn: none while thinking is hidden.
	const thinking = createMemo(() =>
		hideThinkingBlock()
			? []
			: props.run.thinking.flatMap((block) => {
					const view = thinkingView(block.text);
					return view === null ? [] : [view];
				}),
	);
	const running = () => props.run.tools.filter((tool) => callRunning(tool, props.waitRuns));
	const shownCalls = () => (open() ? props.run.tools : running());
	// Per-name call counts in first-seen order, plus a "thinking" segment when present.
	const segments = () => {
		const counts = new Map<string, number>();
		for (const tool of props.run.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
		const segs = [...counts].map(([name, count]) => ({ name, count }));
		return thinking().length > 0 ? [...segs, { name: "thinking", count: thinking().length }] : segs;
	};
	// Meta segments in fixed order: err, req, duration, turns.
	const meta = () => {
		const segs: Array<{ tone?: "err"; text: string }> = [];
		if (props.run.errorCount > 0) segs.push({ tone: "err", text: `${props.run.errorCount} err` });
		if (props.run.requestCount > 0) segs.push({ text: `${props.run.requestCount} req` });
		if (props.run.durationMs > 0) segs.push({ text: formatDurationMs(props.run.durationMs) });
		if (props.run.turnCount > 0)
			segs.push({ text: `${props.run.turnCount} turn${props.run.turnCount === 1 ? "" : "s"}` });
		return segs;
	};
	const names = () =>
		[...props.run.tools.map((tool) => tool.name), ...thinking().map(() => "thinking")].join(" · ");
	const hasContent = () => open() || shownCalls().length > 0;
	return (
		<div class="run-row" classList={{ open: hasContent() }} data-running={props.run.running}>
			<button
				type="button"
				class="run-row-summary"
				aria-expanded={open()}
				title={names()}
				onClick={() => setUserOpen(!open())}
			>
				<Show when={props.run.running}>
					<span class="run-row-dot" aria-hidden="true" />
				</Show>
				{/* Index, not For: the segments are rebuilt as the run grows and update in place. */}
				<Index each={segments()}>
					{(seg, i) => (
						<>
							<Show when={i > 0}>
								<span class="run-row-sep" aria-hidden="true">
									•
								</span>
							</Show>
							<span class="run-row-item">
								<span class="run-row-count">{seg().count}</span>
								<span class="run-row-name">{seg().name}</span>
							</span>
						</>
					)}
				</Index>
				<Index each={meta()}>
					{(seg) => (
						<>
							<span class="run-row-sep" aria-hidden="true">
								•
							</span>
							<span class="run-row-meta" data-tone={seg().tone}>
								{seg().text}
							</span>
						</>
					)}
				</Index>
			</button>
			<Show when={hasContent()}>
				<div class="run-row-content">
					{/* Folded thinking first: consumed assistant messages always precede the run's calls. */}
					<Show when={open()}>
						<For each={thinking()}>
							{(view) => {
								const { opened, onToggle, onClick } = createLazyOpen(expandThinkingBlocks());
								return (
									<details
										class="thinking-block"
										open={expandThinkingBlocks()}
										onToggle={onToggle}
										onClick={onClick}
									>
										<summary>thinking</summary>
										<Show when={opened()}>
											<Markdown src={view} />
										</Show>
									</details>
								);
							}}
						</For>
					</Show>
					<RunMemberContext.Provider value={true}>
						<For each={shownCalls()}>
							{(item) => (
								<RunCall item={item} waitRuns={props.waitRuns} originOf={props.originOf} />
							)}
						</For>
					</RunMemberContext.Provider>
				</div>
			</Show>
		</div>
	);
};
