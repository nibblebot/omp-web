import { createResource, createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import { openModelSettings } from "../../store/models";
import { pushNotice } from "../../state";
import {
	getAdvisorHistory,
	getAdvisorOverview,
	getAdvisorStats,
	getAdvisorWarnings,
	setAdvisorEnabled,
} from "../../store/subagents-advisor";
import { ConfirmButton } from "../ui/ConfirmButton";

/**
 * Advisor panel: config/status/transcript for the SDK advisor runtime.
 * Read-only by contract — no composer, no input element. Reads and toggles go
 * through the advisor store.
 */

/**
 * Which advisor actions the sheet offers. `configured` in the SDK overview is
 * the enable flag; `roleResolvable` says whether the advisor model role resolves.
 */
export function advisorActions(status: {
	enabled: boolean;
	running: boolean;
	roleResolvable: boolean;
}): { enable: boolean; disable: boolean; stop: boolean; noModel: boolean } {
	return {
		enable: !status.enabled && status.roleResolvable,
		disable: status.enabled,
		stop: status.running,
		noModel: !status.roleResolvable,
	};
}

/** Advisor is read-only: this component renders no input element by contract. */
export const AdvisorPanel: Component = () => {
	const [overview, { refetch: refetchOverview }] = createResource(() => getAdvisorOverview());
	const [warnings] = createResource(() => getAdvisorWarnings().then((result) => result.warnings));
	const [stats] = createResource(() => getAdvisorStats());
	const [compact, setCompact] = createSignal(true);
	const [history, setHistory] = createSignal<string | null>(null);
	const [historyError, setHistoryError] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [toggling, setToggling] = createSignal(false);
	const [pendingDisable, setPendingDisable] = createSignal(false);

	const warningList = (): string[] => warnings() ?? [];

	const loadHistory = async (): Promise<void> => {
		setLoading(true);
		setHistoryError(null);
		try {
			// Raw dump (compact:false) is the deliberate second click: callers arm
			// via ConfirmButton before requesting full text.
			const page = await getAdvisorHistory({ compact: compact() });
			if (page.available && page.text !== null) setHistory(page.text);
			else setHistoryError(`advisor history unavailable: ${page.reason ?? "unknown"}`);
		} catch (err) {
			setHistoryError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	const setEnabled = async (enabled: boolean): Promise<void> => {
		setToggling(true);
		try {
			await setAdvisorEnabled(enabled);
			pushNotice(
				"info",
				enabled
					? "advisor enabled — live advisories resume"
					: "advisor disabled — live advisories stop",
			);
			setPendingDisable(false);
			void refetchOverview();
		} catch (err) {
			pushNotice("error", err instanceof Error ? err.message : String(err));
		} finally {
			setToggling(false);
		}
	};

	const disableRunning = (running: boolean): void => {
		// Disable-while-running uses an explicit confirm (ConfirmButton below).
		if (running && !pendingDisable()) {
			setPendingDisable(true);
			return;
		}
		void setEnabled(false);
	};

	return (
		<div class="subagent-list">
			<Switch>
				<Match when={overview.loading}>
					<div class="tool-collapsed-note">loading advisor status…</div>
				</Match>
				<Match when={overview.error}>
					<div class="msg-notice">{String(overview.error)}</div>
				</Match>
				<Match when={overview()} keyed>
					{(o) => {
						const actions = advisorActions({
							enabled: o.configured,
							running: o.active,
							roleResolvable: o.roleResolvable,
						});
						return (
							<div class="goal-panel">
								<div class="goal-meta">
									<span class="picker-label">advisor</span> {o.configured ? "enabled" : "disabled"}{" "}
									· {o.active ? "active" : "idle"}
								</div>
								<Show when={actions.noModel}>
									<div class="msg-notice">
										No model is assigned to the advisor role.{" "}
										<button type="button" onClick={() => openModelSettings()}>
											{"Settings > Model"}
										</button>
									</div>
								</Show>
								<For each={o.advisors}>
									{(entry) => (
										<div class="goal-meta">
											<span class="picker-label">{entry.name}</span> {entry.status}
											<span class="picker-detail"> · yielded: {String(entry.yielded)}</span>
										</div>
									)}
								</For>
								<div class="goal-actions">
									<Show when={actions.enable}>
										<button
											type="button"
											disabled={toggling()}
											onClick={() => void setEnabled(true)}
										>
											enable
										</button>
									</Show>
									<Show when={actions.disable}>
										<ConfirmButton
											label={pendingDisable() ? "disable running advisor?" : "disable"}
											confirmLabel="confirm disable"
											disabled={toggling()}
											onConfirm={() => {
												if (o.active && !pendingDisable()) setPendingDisable(true);
												else void setEnabled(false);
											}}
										/>
									</Show>
									<Show when={actions.stop}>
										<button type="button" onClick={() => disableRunning(true)}>
											stop advisories
										</button>
									</Show>
								</div>
							</div>
						);
					}}
				</Match>
			</Switch>

			<Show when={warningList().length > 0}>
				<div class="goal-panel">
					<div class="goal-meta">
						<span class="picker-label">config warnings</span>
					</div>
					<For each={warningList()}>{(w) => <div class="msg-notice">{w}</div>}</For>
				</div>
			</Show>

			<Show when={stats()} keyed>
				{(s) => (
					<div class="goal-meta">
						<span class="picker-label">stats</span> cost {s.cost} · tokens {s.tokens.total} ·
						messages {s.messages.total}
					</div>
				)}
			</Show>

			<div class="goal-panel">
				<div class="goal-meta">
					<span class="picker-label">transcript</span>
					<span class="picker-detail">
						note/concern/blocker severity arrives via live advisory stream; this dump is raw
						transcript
					</span>
				</div>
				<div class="subagent-controls" role="group" aria-label="Transcript density">
					<button
						type="button"
						aria-pressed={compact()}
						disabled={loading()}
						onClick={() => setCompact(true)}
					>
						compact
					</button>
					<button type="button" disabled={loading()} onClick={() => void loadHistory()}>
						{loading() ? "loading…" : "load transcript"}
					</button>
					<Show when={!compact()}>
						<ConfirmButton
							label="load raw full dump"
							confirmLabel="confirm raw dump"
							disabled={loading()}
							onConfirm={() => void loadHistory()}
						/>
					</Show>
					<button type="button" aria-pressed={!compact()} onClick={() => setCompact(false)}>
						raw
					</button>
				</div>
				<Show when={!compact()}>
					<div class="msg-notice">warning: raw dump may disclose prompts/code/credentials</div>
				</Show>
				<Show when={historyError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
				<Show when={history()}>
					{(text) => (
						<pre class="dim-block" style={{ margin: "0", "white-space": "pre-wrap" }}>
							{text()}
						</pre>
					)}
				</Show>
				<div class="tool-collapsed-note">advisor is read-only — no composer.</div>
			</div>
		</div>
	);
};
