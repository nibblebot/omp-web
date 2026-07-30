import { For, onMount, Show, type Component } from "solid-js";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { formatTokens } from "../context";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";

/** Native `/usage` + `/context` + `/tools` display: full session stats and tool list. */
export const StatsPopover: Component<{ onClose: () => void }> = props => {
	onMount(() => {
		void call("getSessionStats")
			.then(stats => setState("stats", stats as SessionStats))
			.catch(err => setState("error", String(err)));
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
			["cache read/write", `${formatTokens(s.tokens.cacheRead)} / ${formatTokens(s.tokens.cacheWrite)}`],
			["total tokens", formatTokens(s.tokens.total)],
			["premium requests", String(s.premiumRequests)],
			["cost", `$${s.cost.toFixed(4)}`],
			...(s.contextUsage
				? [["context", `${formatTokens(s.contextUsage.tokens)} / ${formatTokens(s.contextUsage.contextWindow)} (${s.contextUsage.percent.toFixed(1)}%)`]]
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
				<button onClick={() => void call("compact", []).catch(err => setState("error", String(err)))}>Compact now</button>
				<label class="toggle">
					<input
						type="checkbox"
						checked={state.autoCompactionEnabled}
						onChange={e => void call("setAutoCompaction", [e.currentTarget.checked]).catch(err => setState("error", String(err)))}
					/>
					auto-compaction
				</label>
			</div>
			<Show when={state.dumpTools && state.dumpTools.length > 0}>
				<h3 class="stats-subhead">Tools ({state.dumpTools.length})</h3>
				<div class="stats-tools">
					<For each={state.dumpTools}>
						{t => (
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
