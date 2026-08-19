import { createSignal, For, Show, type Component } from "solid-js";
import type { Run } from "../../../chat/tool-runs";
import { formatDurationMs } from "../../../usage/usage";
import { ToolStripCard } from "../ToolCard";
import { Markdown } from "../../shared/Markdown";

// Expanded run keys, module-level so they survive row re-renders while a run
// grows (same pattern as DaemonSidebar's activatingIds).
const expandedRunKeys = new Set<number>();
const [runOpenVersion, setRunOpenVersion] = createSignal(0);

/** Drop expanded-run keys that no longer exist (session switches reset item ids). */
export function pruneRunOpen(validKeys: ReadonlySet<number>): void {
	for (const k of expandedRunKeys) if (!validKeys.has(k)) expandedRunKeys.delete(k);
}

/** Consolidated view: one row per run of consecutive tool calls, with thinking
 *  blocks folded from preceding consumed assistant messages, e.g.
 *  "4 Read • 2 Glob • 1 thinking • 7 req". */
export const RunRow: Component<{ run: Run }> = (props) => {
	const open = () => {
		void runOpenVersion();
		return expandedRunKeys.has(props.run.key);
	};
	const toggle = () => {
		if (expandedRunKeys.has(props.run.key)) expandedRunKeys.delete(props.run.key);
		else expandedRunKeys.add(props.run.key);
		setRunOpenVersion((v) => v + 1);
	};
	// Per-name tool counts in first-seen order, plus a "thinking" segment when present.
	const segments = () => {
		const map = new Map<string, number>();
		const order: string[] = [];
		for (const item of props.run.tools) {
			if (!map.has(item.name)) order.push(item.name);
			map.set(item.name, (map.get(item.name) ?? 0) + 1);
		}
		const tools = order.map((name) => ({ name, count: map.get(name)! }));
		return props.run.thinking.length > 0
			? [...tools, { name: "thinking", count: props.run.thinking.length }]
			: tools;
	};
	// Meta segments in fixed order: err, req, duration, turns. Rendered as one
	// For (fragments are only legal inside a JSX callback, not under <button>).
	const meta = () => {
		const m: Array<{ tone?: "err"; text: string }> = [];
		if (props.run.errorCount > 0) m.push({ tone: "err", text: `${props.run.errorCount} err` });
		if (props.run.requestCount > 0) m.push({ text: `${props.run.requestCount} req` });
		if (props.run.durationMs > 0) m.push({ text: formatDurationMs(props.run.durationMs) });
		m.push({ text: `${props.run.turnCount} turns` });
		return m;
	};
	const names = () =>
		[...props.run.tools.map((it) => it.name), ...props.run.thinking.map(() => "thinking")].join(
			" · ",
		);
	return (
		<div class="run-row" classList={{ open: open() }} data-running={props.run.running}>
			<button
				type="button"
				class="run-row-summary"
				aria-expanded={open()}
				title={names()}
				onClick={toggle}
			>
				<Show when={props.run.running}>
					<span class="run-row-dot" aria-hidden="true" />
				</Show>
				<For each={segments()}>
					{(seg, i) => (
						<>
							{i() > 0 && (
								<span class="run-row-sep" aria-hidden="true">
									•
								</span>
							)}
							<span class="run-row-item">
								<span class="run-row-count">{seg.count}</span>
								<span class="run-row-name">{seg.name}</span>
							</span>
						</>
					)}
				</For>
				<For each={meta()}>
					{(m) => (
						<>
							<span class="run-row-sep" aria-hidden="true">
								•
							</span>
							<span class="run-row-meta" data-tone={m.tone}>
								{m.text}
							</span>
						</>
					)}
				</For>
			</button>
			<Show when={open()}>
				<div class="run-row-content">
					{/* Folded thinking first: consumed assistant messages always precede the run's tools. */}
					<For each={props.run.thinking}>
						{(block) => (
							<details class="thinking-block">
								<summary>thinking</summary>
								<Markdown src={block.text} />
							</details>
						)}
					</For>
					<For each={props.run.tools}>{(item) => <ToolStripCard item={item} />}</For>
				</div>
			</Show>
		</div>
	);
};
