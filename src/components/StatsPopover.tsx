import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { ContextUsageBreakdown } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { formatTokens } from "../context";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";

/** One stacked-bar segment: width proportional to the context window. The
 *  variant drives the per-category swatch (see .breakdown-seg--* in
 *  styles.css; an ordered cool-to-warm ramp, not the semantic status colors). */
const BreakdownSegment: Component<{
	tokens: number;
	contextWindow: number;
	label: string;
	variant: string;
}> = (props) => {
	const width = () =>
		props.contextWindow > 0 ? `${(props.tokens / props.contextWindow) * 100}%` : "0%";
	return (
		<div
			class={`breakdown-seg breakdown-seg--${props.variant}`}
			title={`${props.label}: ${formatTokens(props.tokens)} tokens`}
			style={{ width: width() }}
		/>
	);
};

/** Native `/usage` + `/context` + `/tools` display: full session stats and tool list. */
export const StatsPopover: Component<{ onClose: () => void }> = (props) => {
	const [breakdown, setBreakdown] = createSignal<ContextUsageBreakdown | null>(null);

	onMount(() => {
		void call("getSessionStats")
			.then((stats) => setState("stats", stats as SessionStats))
			.catch((err) => setState("error", String(err)));
		// Phase 9: /context parity — per-category token breakdown.
		void call("getContextBreakdown")
			.then((b) => setBreakdown((b as ContextUsageBreakdown | null) ?? null))
			.catch(() => setBreakdown(null));
	});

	const rows = () => {
		const s = state.stats;
		if (!s) return [];
		return [
			["messages", `${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`],
			["tool calls", String(s.toolCalls)],
			["input tokens", formatTokens(s.tokens.input)],
			["output tokens", formatTokens(s.tokens.output)],
			["reasoning tokens", formatTokens(s.tokens.reasoning)],
			[
				"cache read/write",
				`${formatTokens(s.tokens.cacheRead)} / ${formatTokens(s.tokens.cacheWrite)}`,
			],
			["total tokens", formatTokens(s.tokens.total)],
			["premium requests", String(s.premiumRequests)],
			["cost", `$${s.cost.toFixed(4)}`],
			...(s.contextUsage
				? [
						[
							"context",
							`${formatTokens(s.contextUsage.tokens)} / ${formatTokens(s.contextUsage.contextWindow)} (${s.contextUsage.percent.toFixed(1)}%)`,
						],
					]
				: []),
		] as Array<[string, string]>;
	};

	return (
		<Modal title="Session stats" onClose={props.onClose}>
			<table class="stats-table">
				<tbody>
					<For each={rows()}>
						{([k, v]) => (
							<tr>
								<td class="stats-key">{k}</td>
								<td>{v}</td>
							</tr>
						)}
					</For>
				</tbody>
			</table>
			<div class="stats-actions">
				<button
					onClick={() => void call("compact", []).catch((err) => setState("error", String(err)))}
				>
					Compact now
				</button>
				<button onClick={() => setState("modal", "usage")}>usage reports</button>
				<label class="toggle">
					<input
						type="checkbox"
						checked={state.autoCompactionEnabled}
						onChange={(e) =>
							void call("setAutoCompaction", [e.currentTarget.checked]).catch((err) =>
								setState("error", String(err)),
							)
						}
					/>
					auto-compaction
				</label>
			</div>
			<Show when={breakdown()}>
				{(b) => {
					const pct = () =>
						b().contextWindow > 0 ? (b().usedTokens / b().contextWindow) * 100 : 0;
					return (
						<div class="breakdown">
							<h3 class="stats-subhead">Context breakdown</h3>
							<div class="breakdown-bar">
								<BreakdownSegment
									variant="system"
									tokens={b().systemPromptTokens}
									contextWindow={b().contextWindow}
									label="system prompt"
								/>
								<BreakdownSegment
									variant="tools"
									tokens={b().systemToolsTokens}
									contextWindow={b().contextWindow}
									label="tools"
								/>
								<BreakdownSegment
									variant="context"
									tokens={b().systemContextTokens}
									contextWindow={b().contextWindow}
									label="system context"
								/>
								<BreakdownSegment
									variant="skills"
									tokens={b().skillsTokens}
									contextWindow={b().contextWindow}
									label="skills"
								/>
								<BreakdownSegment
									variant="messages"
									tokens={b().messagesTokens}
									contextWindow={b().contextWindow}
									label="messages"
								/>
							</div>
							<div class="breakdown-legend">
								<span class="breakdown-legend-item">
									<i class="breakdown-swatch breakdown-swatch--system" aria-hidden="true" />
									system prompt
									<span class="breakdown-legend-count">{formatTokens(b().systemPromptTokens)}</span>
								</span>
								<span class="breakdown-legend-item">
									<i class="breakdown-swatch breakdown-swatch--tools" aria-hidden="true" />
									tools
									<span class="breakdown-legend-count">{formatTokens(b().systemToolsTokens)}</span>
								</span>
								<span class="breakdown-legend-item">
									<i class="breakdown-swatch breakdown-swatch--context" aria-hidden="true" />
									system context
									<span class="breakdown-legend-count">
										{formatTokens(b().systemContextTokens)}
									</span>
								</span>
								<span class="breakdown-legend-item">
									<i class="breakdown-swatch breakdown-swatch--skills" aria-hidden="true" />
									skills
									<span class="breakdown-legend-count">{formatTokens(b().skillsTokens)}</span>
								</span>
								<span class="breakdown-legend-item">
									<i class="breakdown-swatch breakdown-swatch--messages" aria-hidden="true" />
									messages
									<span class="breakdown-legend-count">{formatTokens(b().messagesTokens)}</span>
								</span>
							</div>
							<div class="breakdown-numbers">
								<span>used {formatTokens(b().usedTokens)}</span>
								<span>/ {formatTokens(b().contextWindow)}</span>
								<span>({pct().toFixed(1)}%)</span>
								<span class="picker-detail">{b().anchored ? "anchored" : "not anchored"}</span>
							</div>
						</div>
					);
				}}
			</Show>
			<Show when={state.dumpTools && state.dumpTools.length > 0}>
				<h3 class="stats-subhead">Tools ({state.dumpTools.length})</h3>
				<div class="stats-tools">
					<For each={state.dumpTools}>
						{(t) => (
							<div class="stats-tool">
								<span class="picker-label">{t.name}</span>
								<span class="picker-detail">{t.description.slice(0, 120)}</span>
							</div>
						)}
					</For>
				</div>
			</Show>
		</Modal>
	);
};
