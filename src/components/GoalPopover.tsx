import { createSignal, Show, type Component } from "solid-js";
import { formatTokens } from "../context";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";

/**
 * Phase 9: goal badge popover (/goal parity). Shows the objective, budget
 * usage, and pause/resume/drop controls. On 17.1.8 /goal is NOT intercepted by
 * the server's ACP builtin dispatch, so these drive the goalRuntime relay rows
 * directly (goal_updated events + the post-mutation state broadcast keep the
 * state fresh).
 */
export const GoalPopover: Component<{ onClose: () => void }> = props => {
	const goal = () => state.goalModeState?.goal;
	const mode = () => state.goalModeState?.mode;
	const [objective, setObjective] = createSignal("");

	const goalCall = (method: "goalCreate" | "goalPause" | "goalResume" | "goalDrop", arg?: string) => {
		void call(method, arg !== undefined ? [arg] : [])
			.then(() => setObjective(""))
			.catch(err => setState("error", String(err)));
	};

	const submitGoal = () => {
		const text = objective().trim();
		if (text) goalCall("goalCreate", text);
	};

	return (
		<Modal title="Goal" onClose={props.onClose}>
			<Show
				when={goal()}
				fallback={
					<div class="goal-empty">
						No active goal. Set one below.
						<form
							class="goal-actions"
							onSubmit={e => {
								e.preventDefault();
								submitGoal();
							}}
						>
							<input
								class="goal-set-input"
								aria-label="Goal objective"
								placeholder="Goal objective…"
								value={objective()}
								onInput={e => setObjective(e.currentTarget.value)}
							/>
							<button type="submit" disabled={!objective().trim()}>
								set
							</button>
						</form>
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
								<button onClick={() => goalCall("goalPause")}>pause</button>
								<button onClick={() => goalCall("goalResume")}>resume</button>
								<button class="danger" onClick={() => goalCall("goalDrop")}>
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
