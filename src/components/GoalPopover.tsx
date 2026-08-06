import { Show, type Component } from "solid-js";
import { formatTokens } from "../context";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";

/**
 * Phase 9: goal badge popover (/goal parity). Shows the objective, budget
 * usage, and pause/resume/drop controls — all executed through the existing
 * prompt passthrough, since /goal is a universal builtin intercepted
 * server-side (goal_updated events keep the state fresh).
 */
export const GoalPopover: Component<{ onClose: () => void }> = props => {
	const goal = () => state.goalModeState?.goal;
	const mode = () => state.goalModeState?.mode;

	const goalPrompt = (sub: string) =>
		void call("prompt", [`/goal ${sub}`]).catch(err => setState("error", String(err)));

	return (
		<Modal title="Goal" onClose={props.onClose}>
			<Show
				when={goal()}
				fallback={
					<div class="goal-empty">
						No active goal. Set one with <code>/goal set …</code>
					</div>
				}
			>
				{g => {
					const budget = g().tokenBudget;
					const pct =
						budget !== undefined && budget > 0 ? Math.min(100, (g().tokensUsed / budget) * 100) : 0;
					return (
						<div class="goal-panel">
							<div class="goal-objective">{g().objective}</div>
							<div class="goal-meta">
								<span class="picker-label">status</span> {g().status}
								{mode() !== undefined && mode() !== "active" && (
									<span class="picker-detail">
										{" "}
										· mode: {mode()}
										{state.goalModeState?.reason ? ` (${state.goalModeState.reason})` : ""}
									</span>
								)}
							</div>
							<Show when={budget !== undefined}>
								<div class="goal-budget">
									<div class="amount-bar">
										<div class="amount-bar-fill" style={{ width: `${pct}%` }} />
									</div>
									<span class="picker-detail">
										{formatTokens(g().tokensUsed)} / {formatTokens(budget!)} tokens ({pct.toFixed(0)}%)
									</span>
								</div>
							</Show>
							<div class="goal-meta">
								<span class="picker-label">elapsed</span> {Math.round(g().timeUsedSeconds / 60)}m
							</div>
							<div class="goal-actions">
								<button onClick={() => goalPrompt("pause")}>pause</button>
								<button onClick={() => goalPrompt("resume")}>resume</button>
								<button class="danger" onClick={() => goalPrompt("drop")}>
									drop
								</button>
							</div>
						</div>
					);
				}}
			</Show>
		</Modal>
	);
};
