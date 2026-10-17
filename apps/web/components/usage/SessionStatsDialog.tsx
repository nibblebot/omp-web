import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { ContextUsageBreakdown } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { formatTokens } from "../../usage/context";
import { call, setState, state } from "../../state";
import { reportError } from "../../store/toasts";
import { Modal } from "../ui/Modal";
import { Tabs, tabButtonId, tabPanelId } from "../ui/Tabs";

/** Sections of the stats dialog. */
type StatsTab = "overview" | "context" | "tools";

/** One stacked-bar segment: width proportional to the context window. The
 *  variant drives the per-category swatch (see .breakdown-seg--* in
 *  src/styles/usage.css; an ordered cool-to-warm ramp, not the semantic status colors). */
const ContextBreakdownSegment: Component<{
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

/** Session stats, opened by `/usage`, `/context`, `/tools`, and the session status bar. */
export const SessionStatsDialog: Component<{ onClose: () => void }> = (props) => {
	const [breakdown, setBreakdown] = createSignal<ContextUsageBreakdown | null>(null);
	const [tab, setTab] = createSignal<StatsTab>("overview");

	onMount(() => {
		void call("getSessionStats")
			.then((stats) => setState("stats", stats as SessionStats))
			.catch(reportError);
		// Phase 9: /context parity, per-category token breakdown.
		void call("getContextBreakdown")
			.then((b) => setBreakdown((b as ContextUsageBreakdown | null) ?? null))
			.catch(() => setBreakdown(null));
	});

	return (
		<Modal title="Session stats" onClose={props.onClose}>
			<Tabs
				tabs={[
					{ id: "overview", label: "Overview" },
					{ id: "context", label: "Context" },
					{ id: "tools", label: `Tools (${state.dumpTools?.length ?? 0})` },
				]}
				value={tab()}
				onChange={setTab}
				label="Session stats sections"
				idPrefix="stats"
			/>
			<Show when={tab() === "overview"}>
				<div
					role="tabpanel"
					id={tabPanelId("stats", "overview")}
					aria-labelledby={tabButtonId("stats", "overview")}
				>
					<Show when={state.stats} fallback={<p class="picker-note">Loading session stats…</p>}>
						{(s) => (
							<>
								<dl class="stats-figures">
									<For
										each={[
											["total tokens", formatTokens(s().tokens.total)],
											["cost", `$${s().cost.toFixed(4)}`],
											[
												"context",
												s().contextUsage ? `${s().contextUsage!.percent.toFixed(1)}%` : "n/a",
											],
											["messages", String(s().totalMessages)],
											["tool calls", String(s().toolCalls)],
										]}
									>
										{([label, value]) => (
											<div class="stats-figure">
												<dt>{label}</dt>
												<dd>{value}</dd>
											</div>
										)}
									</For>
								</dl>
								<table class="stats-table">
									<tbody>
										<For
											each={[
												["user / assistant", `${s().userMessages} / ${s().assistantMessages}`],
												["input tokens", formatTokens(s().tokens.input)],
												["output tokens", formatTokens(s().tokens.output)],
												["reasoning tokens", formatTokens(s().tokens.reasoning)],
												[
													"cache read / write",
													`${formatTokens(s().tokens.cacheRead)} / ${formatTokens(s().tokens.cacheWrite)}`,
												],
												["premium requests", String(s().premiumRequests)],
												...(s().contextUsage
													? [
															[
																"context used",
																`${formatTokens(s().contextUsage!.tokens)} / ${formatTokens(s().contextUsage!.contextWindow)}`,
															],
														]
													: []),
											]}
										>
											{([k, v]) => (
												<tr>
													<td class="stats-key">{k}</td>
													<td>{v}</td>
												</tr>
											)}
										</For>
									</tbody>
								</table>
							</>
						)}
					</Show>
					<div class="stats-actions">
						<button onClick={() => void call("compact", []).catch(reportError)}>Compact now</button>
						<button onClick={() => setState("modal", "usage")}>usage reports</button>
						<label class="toggle">
							<input
								type="checkbox"
								checked={state.autoCompactionEnabled}
								onChange={(e) =>
									void call("setAutoCompaction", [e.currentTarget.checked]).catch(reportError)
								}
							/>
							auto-compaction
						</label>
					</div>
				</div>
			</Show>
			<Show when={tab() === "context"}>
				<div
					role="tabpanel"
					id={tabPanelId("stats", "context")}
					aria-labelledby={tabButtonId("stats", "context")}
				>
					<Show
						when={breakdown()}
						fallback={<p class="picker-note">No context breakdown for this session yet.</p>}
					>
						{(b) => {
							const pct = b().contextWindow > 0 ? (b().usedTokens / b().contextWindow) * 100 : 0;
							return (
								<div class="breakdown">
									<div class="breakdown-bar">
										<ContextBreakdownSegment
											variant="system"
											tokens={b().systemPromptTokens}
											contextWindow={b().contextWindow}
											label="system prompt"
										/>
										<ContextBreakdownSegment
											variant="tools"
											tokens={b().systemToolsTokens}
											contextWindow={b().contextWindow}
											label="tools"
										/>
										<ContextBreakdownSegment
											variant="context"
											tokens={b().systemContextTokens}
											contextWindow={b().contextWindow}
											label="system context"
										/>
										<ContextBreakdownSegment
											variant="skills"
											tokens={b().skillsTokens}
											contextWindow={b().contextWindow}
											label="skills"
										/>
										<ContextBreakdownSegment
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
											<span class="breakdown-legend-count">
												{formatTokens(b().systemPromptTokens)}
											</span>
										</span>
										<span class="breakdown-legend-item">
											<i class="breakdown-swatch breakdown-swatch--tools" aria-hidden="true" />
											tools
											<span class="breakdown-legend-count">
												{formatTokens(b().systemToolsTokens)}
											</span>
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
										<span>({pct.toFixed(1)}%)</span>
										<span class="picker-detail">{b().anchored ? "anchored" : "not anchored"}</span>
									</div>
								</div>
							);
						}}
					</Show>
				</div>
			</Show>
			<Show when={tab() === "tools"}>
				<div
					role="tabpanel"
					id={tabPanelId("stats", "tools")}
					aria-labelledby={tabButtonId("stats", "tools")}
				>
					<Show
						when={(state.dumpTools?.length ?? 0) > 0}
						fallback={<p class="picker-note">No tools reported for this session.</p>}
					>
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
				</div>
			</Show>
		</Modal>
	);
};
