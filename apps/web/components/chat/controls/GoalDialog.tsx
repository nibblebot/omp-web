import { createSignal, For, Show, type Component } from "solid-js";
import { formatTokens } from "../../../usage/context";
import { state } from "../../../state";
import {
	dropGoal,
	parseGoalBudget,
	pauseGoal,
	replaceGoal,
	resumeGoal,
	setGoalBudget,
	startGoal,
	validateObjective,
} from "../../../store/goals";
import { Modal } from "../../ui/Modal";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { LoopPanel } from "./LoopPanel";
import { VibePanel } from "./VibePanel";

/**
 * The goals surface: the header goal badge and `/goal` open this dialog.
 * Tabs: Objective (start, replace, pause, resume, drop), Budget (show and
 * set), Loops (preview and start, consent-gated), Vibe (workers, consent-gated).
 * Every mutation goes through the goals store.
 */

type GoalTab = "objective" | "budget" | "loops" | "vibe";

const GOAL_TABS: { id: GoalTab; label: string }[] = [
	{ id: "objective", label: "Objective" },
	{ id: "budget", label: "Budget" },
	{ id: "loops", label: "Loops" },
	{ id: "vibe", label: "Vibe" },
];

export const GoalDialog: Component<{ onClose: () => void }> = (props) => {
	const [tab, setTab] = createSignal<GoalTab>("objective");

	return (
		<Modal title="Goal" onClose={props.onClose}>
			<div class="goal-tabs" role="tablist" aria-label="Goal sections">
				<For each={GOAL_TABS}>
					{(entry) => (
						<button
							type="button"
							role="tab"
							class="goal-tab"
							aria-selected={tab() === entry.id}
							onClick={() => setTab(entry.id)}
						>
							{entry.label}
						</button>
					)}
				</For>
			</div>
			<Show when={tab() === "objective"}>
				<ObjectiveSection />
			</Show>
			<Show when={tab() === "budget"}>
				<BudgetSection />
			</Show>
			<Show when={tab() === "loops"}>
				<LoopPanel />
			</Show>
			<Show when={tab() === "vibe"}>
				<VibePanel />
			</Show>
		</Modal>
	);
};

const ObjectiveSection: Component = () => {
	const goal = () => state.goalModeState?.goal;
	const [objective, setObjective] = createSignal("");
	const [budgetText, setBudgetText] = createSignal("");
	const [replacing, setReplacing] = createSignal(false);
	const [error, setError] = createSignal<string>();

	/** Validated objective and optional budget, or null after setting the error. */
	const readForm = (): { objective: string; tokenBudget?: number } | null => {
		const invalid = validateObjective(objective());
		if (invalid) {
			setError(`Goal ${invalid}`);
			return null;
		}
		if (budgetText().trim() === "") {
			setError(undefined);
			return { objective: objective().trim() };
		}
		const parsed = parseGoalBudget(budgetText());
		if ("error" in parsed) {
			setError(parsed.error);
			return null;
		}
		setError(undefined);
		return { objective: objective().trim(), tokenBudget: parsed.tokenBudget };
	};

	const submitStart = async () => {
		const form = readForm();
		if (!form) return;
		if (await startGoal(form.objective, form.tokenBudget)) {
			setObjective("");
			setBudgetText("");
		}
	};

	const submitReplace = async () => {
		const form = readForm();
		if (!form) return;
		if (await replaceGoal(form.objective, form.tokenBudget)) {
			setObjective("");
			setBudgetText("");
			setReplacing(false);
		}
	};

	return (
		<Show
			when={goal()}
			fallback={
				<div class="goal-panel">
					<div class="goal-empty">No active goal. Set one below.</div>
					<textarea
						aria-label="Goal objective"
						placeholder="Goal objective…"
						value={objective()}
						onInput={(e) => setObjective(e.currentTarget.value)}
					/>
					<input
						class="goal-set-input"
						aria-label="Token budget (optional)"
						inputmode="numeric"
						placeholder="token budget (optional, e.g. 400000)"
						value={budgetText()}
						onInput={(e) => setBudgetText(e.currentTarget.value)}
					/>
					<div class="goal-actions">
						<ConfirmButton
							label="start goal"
							confirmLabel="confirm goal"
							disabled={objective().trim().length === 0}
							onConfirm={() => void submitStart()}
						/>
					</div>
					<Show when={error()}>
						{(message) => (
							<div class="msg-notice" role="alert">
								{message()}
							</div>
						)}
					</Show>
					<div class="picker-detail">
						Starting a goal runs it: the objective is sent as the first turn.
					</div>
				</div>
			}
		>
			{(g) => (
				<div class="goal-panel">
					<div class="goal-objective">{g().objective}</div>
					<div class="goal-meta">
						<span class="picker-label">status</span> {g().status}
						<Show
							when={
								state.goalModeState?.mode !== undefined && state.goalModeState?.mode !== "active"
							}
						>
							<span class="picker-detail">
								{" "}
								· mode: {state.goalModeState?.mode}
								{state.goalModeState?.reason ? ` (${state.goalModeState.reason})` : ""}
							</span>
						</Show>
					</div>
					<div class="goal-meta">
						<span class="picker-label">elapsed</span> {Math.round(g().timeUsedSeconds / 60)}m
					</div>
					<div class="goal-actions">
						<button disabled={g().status !== "active"} onClick={() => void pauseGoal()}>
							pause
						</button>
						<button disabled={g().status !== "paused"} onClick={() => void resumeGoal()}>
							resume
						</button>
						<button type="button" onClick={() => setReplacing(!replacing())}>
							{replacing() ? "cancel replace" : "replace goal"}
						</button>
						<ConfirmButton
							label="drop goal"
							confirmLabel="confirm drop"
							class="danger"
							onConfirm={() => void dropGoal()}
						/>
					</div>
					<Show when={replacing()}>
						<textarea
							aria-label="Replacement goal objective"
							placeholder="Replacement objective…"
							value={objective()}
							onInput={(e) => setObjective(e.currentTarget.value)}
						/>
						<input
							class="goal-set-input"
							aria-label="Replacement token budget (optional)"
							inputmode="numeric"
							placeholder="token budget (optional)"
							value={budgetText()}
							onInput={(e) => setBudgetText(e.currentTarget.value)}
						/>
						<div class="goal-actions">
							<ConfirmButton
								label="replace goal"
								confirmLabel="confirm replace"
								disabled={objective().trim().length === 0}
								onConfirm={() => void submitReplace()}
							/>
						</div>
					</Show>
					<Show when={error()}>
						{(message) => (
							<div class="msg-notice" role="alert">
								{message()}
							</div>
						)}
					</Show>
				</div>
			)}
		</Show>
	);
};

const BudgetSection: Component = () => {
	const goal = () => state.goalModeState?.goal;
	const [budgetText, setBudgetText] = createSignal("");
	const [error, setError] = createSignal<string>();

	const submitBudget = async () => {
		const parsed = parseGoalBudget(budgetText());
		if ("error" in parsed) {
			setError(parsed.error);
			return;
		}
		setError(undefined);
		await setGoalBudget(parsed.tokenBudget);
		setBudgetText("");
	};

	return (
		<div class="goal-panel">
			<Show
				when={goal()}
				fallback={<div class="goal-empty">No active goal. Start one on the Objective tab.</div>}
			>
				{(g) => (
					<div class="goal-budget">
						<Show
							when={g().tokenBudget}
							fallback={<span class="picker-detail">No token budget set.</span>}
						>
							{(budget) => (
								<>
									<div class="amount-bar">
										<div
											class="amount-bar-fill"
											style={{
												width: `${Math.min(100, (g().tokensUsed / budget()) * 100)}%`,
											}}
										/>
									</div>
									<span class="picker-detail">
										{formatTokens(g().tokensUsed)} / {formatTokens(budget())} tokens
									</span>
									<div class="goal-actions">
										<button type="button" onClick={() => void setGoalBudget(undefined)}>
											clear budget
										</button>
									</div>
								</>
							)}
						</Show>
						<form
							class="goal-actions"
							onSubmit={(e) => {
								e.preventDefault();
								void submitBudget();
							}}
						>
							<input
								class="goal-set-input"
								aria-label="New token budget"
								inputmode="numeric"
								placeholder="tokens, e.g. 400000"
								value={budgetText()}
								onInput={(e) => setBudgetText(e.currentTarget.value)}
							/>
							<button type="submit" disabled={budgetText().trim().length === 0}>
								set budget
							</button>
						</form>
						<Show when={error()}>
							{(message) => (
								<div class="msg-notice" role="alert">
									{message()}
								</div>
							)}
						</Show>
						<span class="picker-detail">
							budgets are server-enforced; UI validation mirrors the limits.
						</span>
					</div>
				)}
			</Show>
		</div>
	);
};
