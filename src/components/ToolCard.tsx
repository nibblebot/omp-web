import { createSignal, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { argsSummary, type ToolItem } from "../state";
import type { Cycle } from "../tool-runs";
import { Markdown } from "./Markdown";
import { GenericToolCard } from "./tools/GenericToolCard";
import { RENDERERS } from "./tools";

/** Dispatcher: per-tool renderer when registered, generic card otherwise. */
export const ToolCard: Component<{ item: ToolItem }> = props => (
	<Dynamic component={RENDERERS[props.item.name] ?? GenericToolCard} item={props.item} />
);

/** Compact one-row chip for collapsed tool cards; shows name, status, args. */
export const ToolStripCard: Component<{ item: ToolItem }> = props => (
	<div class="tool-chip" title={`${props.item.name} · ${props.item.status} · ${argsSummary(props.item.args)}`}>
		<span class="tool-name">{props.item.name}</span>
		<span class="tool-status" data-status={props.item.status}>{props.item.status}</span>
		<span class="tool-chip-args">{argsSummary(props.item.args)}</span>
	</div>
);

// Expanded cycle keys, module-level so they survive row re-renders while a
// cycle grows (same pattern as DaemonSidebar's activatingIds).
const expandedCycleKeys = new Set<number>();
const [cycleOpenVersion, setCycleOpenVersion] = createSignal(0);

/** Drop expanded-cycle keys that no longer exist in the transcript (session switches reset item ids). */
export function pruneCycleOpen(validKeys: ReadonlySet<number>): void {
	for (const k of expandedCycleKeys) if (!validKeys.has(k)) expandedCycleKeys.delete(k);
}

/** Consolidated view: one row per cycle of consecutive tool calls and thinking
 *  blocks, e.g. "4 Read • 2 Glob • 1 Edit • 3 thinking". */
export const CycleRow: Component<{ cycle: Cycle }> = props => {
	const open = () => {
		void cycleOpenVersion();
		return expandedCycleKeys.has(props.cycle.key);
	};
	const toggle = () => {
		if (expandedCycleKeys.has(props.cycle.key)) expandedCycleKeys.delete(props.cycle.key);
		else expandedCycleKeys.add(props.cycle.key);
		setCycleOpenVersion(v => v + 1);
	};
	const segments = () => {
		const map = new Map<string, number>();
		const order: string[] = [];
		for (const item of props.cycle.tools) {
			if (!map.has(item.name)) order.push(item.name);
			map.set(item.name, (map.get(item.name) ?? 0) + 1);
		}
		const tools = order.map(name => ({ name, count: map.get(name)! }));
		return props.cycle.thinking.length > 0
			? [...tools, { name: "thinking", count: props.cycle.thinking.length }]
			: tools;
	};
	const running = () => props.cycle.tools.some(it => it.status === "running");
	const names = () =>
		[...props.cycle.tools.map(it => it.name), ...props.cycle.thinking.map(() => "thinking")].join(" · ");
	return (
		<div class="cycle-row" classList={{ open: open() }} data-running={running()}>
			<button
				type="button"
				class="cycle-row-summary"
				aria-expanded={open()}
				title={names()}
				onClick={toggle}
			>
				<Show when={running()}>
					<span class="cycle-row-dot" aria-hidden="true" />
				</Show>
				<For each={segments()}>
					{(seg, i) => (
						<>
							{i() > 0 && <span class="cycle-row-sep" aria-hidden="true">•</span>}
							<span class="cycle-row-item">
								<span class="cycle-row-count">{seg.count}</span>
								<span class="cycle-row-name">{seg.name}</span>
							</span>
						</>
					)}
				</For>
			</button>
			<Show when={open()}>
				<div class="cycle-row-chips">
					{/* Original stream order: tools and thinking interleaved. */}
					<For each={props.cycle.members}>
						{member =>
							member.kind === "tool" ? (
								<ToolStripCard item={member.item} />
							) : (
								<details class="thinking-block">
									<summary>thinking</summary>
									<Markdown src={member.block.text} />
								</details>
							)
						}
					</For>
				</div>
			</Show>
		</div>
	);
};
