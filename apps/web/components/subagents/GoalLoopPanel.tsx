import { createSignal, For, Show, type Component } from "solid-js";
import { call, pushNotice, state } from "../../state";
import { ConfirmButton } from "../shared/ConfirmButton";
import { formatTokens } from "../../usage/context";

/**
 * Goal, loop scheduler, and Vibe controls. Mutations require explicit consent;
 * the daemon owns execution and capability decisions.
 */

async function tryCall(
	method: string,
	args: unknown[],
): Promise<{ data?: unknown; error?: string }> {
	try {
		return { data: await call(method as never, args) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

const MAX_OBJECTIVE = 4000;
const MAX_BUDGET = 10_000_000;

const validateObjective = (text: string): string | null => {
	const trimmed = text.trim();
	if (!trimmed) return "objective is required";
	if (trimmed.length > MAX_OBJECTIVE) return `objective exceeds ${MAX_OBJECTIVE} chars`;
	return null;
};

const validateBudget = (raw: string): { value?: number; error?: string } => {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) return { error: "budget must be a positive integer" };
	if (value > MAX_BUDGET) return { error: `budget exceeds server limit ${MAX_BUDGET}` };
	return { value };
};

const GoalSection: Component = () => {
	const goal = () => state.goalModeState?.goal;
	const [objective, setObjective] = createSignal("");
	const [budget, setBudget] = createSignal("");
	const [replace, setReplace] = createSignal(false);
	const [budgetEdit, setBudgetEdit] = createSignal("");
	const [busy, setBusy] = createSignal(false);

	const submit = async (): Promise<void> => {
		const objectiveError = validateObjective(objective());
		if (objectiveError) {
			pushNotice("error", objectiveError);
			return;
		}
		let tokenBudget: number | undefined;
		if (budget().trim()) {
			const parsed = validateBudget(budget().trim());
			if (parsed.error) {
				pushNotice("error", parsed.error);
				return;
			}
			tokenBudget = parsed.value;
		}
		setBusy(true);
		try {
			if (goal() && !replace()) {
				pushNotice("error", "goal active — enable replace to overwrite, or pause/drop first");
				return;
			}
			const method = goal() && replace() ? "goalReplace" : "goalCreate";
			const args = [{ objective: objective().trim(), tokenBudget, consent: true }];
			const res = await tryCall(method, args);
			if (res.error) pushNotice("error", res.error);
			else {
				pushNotice("info", method === "goalCreate" ? "goal created" : "goal replaced");
				setObjective("");
				setBudget("");
				setReplace(false);
			}
		} finally {
			setBusy(false);
		}
	};

	const editBudget = async (): Promise<void> => {
		const parsed = validateBudget(budgetEdit().trim());
		if (parsed.error) {
			pushNotice("error", parsed.error);
			return;
		}
		setBusy(true);
		try {
			// Budget mutations use the same server-enforced limit as goal creation.
			const res = await tryCall("goalBudget", [{ tokenBudget: parsed.value }]);
			if (res.error) pushNotice("error", res.error);
			else {
				pushNotice("info", "goal budget updated");
				setBudgetEdit("");
			}
		} finally {
			setBusy(false);
		}
	};

	const simple = async (method: "goalPause" | "goalResume" | "goalDrop"): Promise<void> => {
		const res = await tryCall(method, method === "goalResume" ? [{ consent: true }] : []);
		if (res.error) pushNotice("error", res.error);
		else
			pushNotice(
				"info",
				`goal ${method === "goalDrop" ? "dropped" : method === "goalPause" ? "paused" : "resumed"}`,
			);
	};

	return (
		<div class="goal-panel">
			<Show when={goal()}>
				{(g) => (
					<div class="goal-meta">
						<span class="picker-label">active goal</span> {g().objective.slice(0, 120)}
						{g().tokenBudget !== undefined && (
							<span class="picker-detail">
								{" "}
								· {formatTokens(g().tokensUsed)} / {formatTokens(g().tokenBudget!)} tokens
							</span>
						)}
					</div>
				)}
			</Show>
			<div class="goal-meta">
				<span class="picker-label">guided objective</span>
			</div>
			<textarea
				class="picker-filter"
				aria-label="Goal objective"
				placeholder="objective…"
				rows={3}
				value={objective()}
				onInput={(e) => setObjective(e.currentTarget.value)}
			/>
			<input
				class="picker-filter"
				type="number"
				aria-label="Token budget"
				placeholder="token budget (optional)"
				value={budget()}
				onInput={(e) => setBudget(e.currentTarget.value)}
			/>
			<div class="tool-collapsed-note">
				budgets are server-enforced; UI validation mirrors the limits.
			</div>
			<div class="goal-actions">
				<Show when={goal()}>
					<label class="subagent-status">
						<input
							type="checkbox"
							checked={replace()}
							onChange={(e) => setReplace(e.currentTarget.checked)}
						/>{" "}
						replace active goal
					</label>
				</Show>
				<ConfirmButton
					label={goal() && replace() ? "replace goal" : "create goal"}
					confirmLabel="confirm goal"
					disabled={busy()}
					onConfirm={() => void submit()}
				/>
			</div>
			<Show when={goal()}>
				<div class="goal-meta">
					<span class="picker-label">edit budget</span>
				</div>
				<div class="subagent-controls">
					<input
						class="picker-filter"
						type="number"
						aria-label="New token budget"
						placeholder="new budget…"
						value={budgetEdit()}
						onInput={(e) => setBudgetEdit(e.currentTarget.value)}
					/>
					<ConfirmButton
						label="set budget"
						confirmLabel="confirm budget"
						disabled={busy()}
						onConfirm={() => void editBudget()}
					/>
				</div>
				<div class="goal-actions">
					<button type="button" onClick={() => void simple("goalPause")}>
						pause
					</button>
					<button type="button" onClick={() => void simple("goalResume")}>
						resume
					</button>
					<ConfirmButton
						label="drop"
						confirmLabel="confirm drop"
						onConfirm={() => void simple("goalDrop")}
					/>
				</div>
				<div class="tool-collapsed-note">pauses the active goal; Main turn continues.</div>
			</Show>
		</div>
	);
};

interface LoopPolicy {
	hasPostPromptWork: boolean;
	queuedMessageCount: number;
	isStreaming: boolean;
	loop: {
		status: "inactive" | "running" | "paused" | "stopped";
		iteration: number;
		nextRunAt?: number;
		stopReason?: string;
	};
	capabilities: { boundedLoop: boolean; atomicPauseAll: boolean; pauseAllReason?: string };
}

const LoopSection: Component = () => {
	const [mode, setMode] = createSignal<"count" | "duration" | "until" | "while">("count");
	const [limit, setLimit] = createSignal("5");
	const [command, setCommand] = createSignal("");
	const [prompt, setPrompt] = createSignal("");
	const [preview, setPreview] = createSignal<{
		argsText: string;
		prompt: string;
		summary: string;
	}>();
	const [policy, setPolicy] = createSignal<LoopPolicy>();
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const argsText = (): string =>
		mode() === "count" || mode() === "duration"
			? limit().trim()
			: `--${mode()} '${command().trim().replace(/'/g, "'\\''")}'`;
	const valid = (): boolean => {
		if (!prompt().trim()) return false;
		if (mode() === "count") return /^[1-9]\d*$/.test(limit().trim());
		if (mode() === "duration") return /^(?:[1-9]\d*(?:s|m|h))+$/.test(limit().trim());
		return !!command().trim();
	};
	const invalidate = (): void => setPreview(undefined);
	const loadPolicy = async (): Promise<void> => {
		const res = await tryCall("loopPolicy", []);
		if (res.error) {
			setPolicy(undefined);
			setError(res.error);
			return;
		}
		const data = res.data as LoopPolicy | undefined;
		if (!data?.loop || typeof data.capabilities?.boundedLoop !== "boolean") {
			setPolicy(undefined);
			setError("loopPolicy returned no scheduler capability/status");
			return;
		}
		setPolicy(data);
		setError("");
	};
	const doPreview = async (): Promise<void> => {
		if (!valid()) return;
		setBusy(true);
		setPreview(undefined);
		try {
			const input = { argsText: argsText(), prompt: prompt().trim() };
			const res = await tryCall("loopPreview", [{ argsText: input.argsText }]);
			const data = res.data as { ok?: boolean; summary?: string; error?: string } | undefined;
			if (res.error || data?.ok !== true || !data.summary) {
				setError(res.error ?? data?.error ?? "loop preview did not validate this request");
				return;
			}
			setPreview({ ...input, summary: data.summary });
			await loadPolicy();
		} finally {
			setBusy(false);
		}
	};
	const mutate = async (
		method: "loopStart" | "loopCancel" | "loopPause" | "loopResume",
	): Promise<void> => {
		const checked = preview();
		if (method === "loopStart" && !checked) return;
		setBusy(true);
		try {
			const args =
				method === "loopStart"
					? [{ argsText: checked!.argsText, prompt: checked!.prompt, consent: true }]
					: method === "loopResume"
						? [{ consent: true }]
						: [];
			const res = await tryCall(method, args);
			if (res.error) setError(res.error);
			else {
				setPreview(undefined);
				await loadPolicy();
			}
		} finally {
			setBusy(false);
		}
	};
	return (
		<div class="goal-panel">
			<div class="goal-meta">
				<span class="picker-label">daemon loop scheduler</span>
			</div>
			<label class="subagent-status">
				limit or condition{" "}
				<select
					aria-label="Loop mode"
					value={mode()}
					onChange={(e) => {
						setMode(e.currentTarget.value as "count" | "duration" | "until" | "while");
						setLimit(e.currentTarget.value === "duration" ? "10m" : "5");
						invalidate();
					}}
				>
					<option value="count">count</option>
					<option value="duration">duration</option>
					<option value="until">until command succeeds</option>
					<option value="while">while command succeeds</option>
				</select>
			</label>
			<Show
				when={mode() === "count" || mode() === "duration"}
				fallback={
					<input
						class="picker-filter"
						aria-label="Loop condition command"
						placeholder="shell command"
						value={command()}
						onInput={(e) => {
							setCommand(e.currentTarget.value);
							invalidate();
						}}
					/>
				}
			>
				<input
					class="picker-filter"
					aria-label="Loop limit"
					placeholder={mode() === "count" ? "5" : "10m or 1h30m"}
					value={limit()}
					onInput={(e) => {
						setLimit(e.currentTarget.value);
						invalidate();
					}}
				/>
			</Show>
			<textarea
				class="picker-filter"
				aria-label="Loop prompt"
				placeholder="prompt for each iteration"
				rows={3}
				value={prompt()}
				onInput={(e) => {
					setPrompt(e.currentTarget.value);
					invalidate();
				}}
			/>
			<div class="goal-actions">
				<button type="button" disabled={busy() || !valid()} onClick={() => void doPreview()}>
					preview
				</button>
				<button type="button" disabled={busy()} onClick={() => void loadPolicy()}>
					refresh scheduler
				</button>
				<ConfirmButton
					label="start loop"
					confirmLabel="confirm daemon loop"
					disabled={
						busy() ||
						!preview() ||
						policy()?.capabilities.boundedLoop !== true ||
						policy()?.loop.status === "running" ||
						policy()?.loop.status === "paused"
					}
					onConfirm={() => void mutate("loopStart")}
				/>
				<ConfirmButton
					label="pause loop"
					confirmLabel="confirm pause"
					disabled={busy() || policy()?.loop.status !== "running"}
					onConfirm={() => void mutate("loopPause")}
				/>
				<ConfirmButton
					label="resume loop"
					confirmLabel="confirm resume"
					disabled={busy() || policy()?.loop.status !== "paused"}
					onConfirm={() => void mutate("loopResume")}
				/>
				<ConfirmButton
					label="cancel loop"
					confirmLabel="confirm cancel"
					disabled={busy() || !["running", "paused"].includes(policy()?.loop.status ?? "")}
					onConfirm={() => void mutate("loopCancel")}
				/>
			</div>
			<Show when={preview()}>
				{(p) => (
					<div class="tool-collapsed-note">
						preview: {p().summary} · prompt: {p().prompt}
					</div>
				)}
			</Show>
			<Show when={policy()}>
				{(p) => (
					<>
						<div class="goal-meta">
							{p().loop.status} · iteration {p().loop.iteration} · queued {p().queuedMessageCount} ·
							streaming {p().isStreaming ? "yes" : "no"} · post-prompt work{" "}
							{p().hasPostPromptWork ? "yes" : "no"}
						</div>
						<Show when={p().loop.stopReason}>
							<div class="tool-collapsed-note">{p().loop.stopReason}</div>
						</Show>
						<Show when={p().loop.nextRunAt}>
							<div class="tool-collapsed-note">
								next admission: {new Date(p().loop.nextRunAt!).toLocaleString()}
							</div>
						</Show>
						<Show when={!p().capabilities.atomicPauseAll}>
							<div class="tool-collapsed-note">
								pause-all unavailable: {p().capabilities.pauseAllReason}
							</div>
						</Show>
					</>
				)}
			</Show>
			<Show when={error()}>
				<div class="msg-notice" role="alert">
					{error()}
				</div>
			</Show>
			<div class="tool-collapsed-note">
				No infinite default. Conditions run shell commands in the daemon. Pause/cancel prevent
				future admissions; they do not abort a running turn.
			</div>
		</div>
	);
};

interface VibeWorkerView {
	name: string;
	cli?: string;
	state?: string;
	turns?: number;
	queued?: number;
}

const readWorkers = (data: unknown): VibeWorkerView[] => {
	if (
		data !== null &&
		typeof data === "object" &&
		"workers" in data &&
		Array.isArray(data.workers)
	) {
		return data.workers.flatMap((entry): VibeWorkerView[] => {
			if (
				entry !== null &&
				typeof entry === "object" &&
				"name" in entry &&
				typeof entry.name === "string"
			) {
				const name = entry.name;
				const cli = "cli" in entry ? entry.cli : undefined;
				const workerState = "state" in entry ? entry.state : undefined;
				const turns = "turns" in entry ? entry.turns : undefined;
				const queued = "queued" in entry ? entry.queued : undefined;
				return [
					{
						name,
						cli: typeof cli === "string" ? cli : undefined,
						state: typeof workerState === "string" ? workerState : undefined,
						turns: typeof turns === "number" ? turns : undefined,
						queued: typeof queued === "number" ? queued : undefined,
					},
				];
			}
			return [];
		});
	}
	return [];
};

const VibeSection: Component = () => {
	const [workers, setWorkers] = createSignal<VibeWorkerView[]>([]);
	const [director, setDirector] = createSignal<string | null>(null);
	const [enabled, setEnabled] = createSignal<boolean | null>(null);
	const [prompt, setPrompt] = createSignal("");
	const [cli, setCli] = createSignal<"fast" | "good">("fast");
	const [busy, setBusy] = createSignal(false);

	const refresh = async (): Promise<void> => {
		const res = await tryCall("vibeStatus", []);
		if (res.error) {
			pushNotice("error", res.error);
			return;
		}
		setWorkers(readWorkers(res.data));
		if (res.data !== null && typeof res.data === "object" && "director" in res.data) {
			const d = res.data.director;
			setDirector(typeof d === "string" ? d : JSON.stringify(d));
		}
		if (res.data !== null && typeof res.data === "object" && "enabled" in res.data) {
			const flag = res.data.enabled;
			if (typeof flag === "boolean") setEnabled(flag);
		}
	};

	const start = async (): Promise<void> => {
		if (!prompt().trim()) {
			pushNotice("error", "vibe prompt is required");
			return;
		}
		setBusy(true);
		try {
			const res = await tryCall("vibeStart", [{ cli: cli(), prompt: prompt().trim() }]);
			if (res.error) pushNotice("error", res.error);
			else {
				pushNotice("info", "vibe worker start requested");
				setPrompt("");
				void refresh();
			}
		} finally {
			setBusy(false);
		}
	};

	const perWorker = async (method: string, name: string): Promise<void> => {
		const res = await tryCall(method, [{ name }]);
		if (res.error) pushNotice("error", res.error);
		else {
			pushNotice("info", `${method} ${name} requested`);
			void refresh();
		}
	};

	return (
		<div class="goal-panel">
			<div class="goal-meta">
				<span class="picker-label">vibe</span>
				<span class="picker-detail">nothing runs until you confirm</span>
				<Show when={enabled() !== null}>
					<span class="picker-detail"> · {enabled() ? "enabled" : "disabled"}</span>
				</Show>
			</div>
			<Show when={director()}>
				{(text) => <div class="tool-collapsed-note">director: {text()}</div>}
			</Show>
			<div class="goal-actions">
				<ConfirmButton
					label={enabled() === true ? "disable vibe" : "enable vibe"}
					confirmLabel={enabled() === true ? "confirm disable" : "confirm enable"}
					onConfirm={() =>
						void (async () => {
							const next = !(enabled() === true);
							const res = await tryCall("vibeStart", [{ enabled: next }]);
							pushNotice(
								res.error ? "error" : "info",
								res.error ?? (next ? "vibe enabled" : "vibe disabled"),
							);
							if (!res.error) setEnabled(next);
						})()
					}
				/>
				<button type="button" onClick={() => void refresh()}>
					refresh
				</button>
				<ConfirmButton
					label="rehydrate"
					confirmLabel="confirm rehydrate"
					onConfirm={() =>
						void (async () => {
							const res = await tryCall("vibeRehydrate", []);
							pushNotice(res.error ? "error" : "info", res.error ?? "vibe workers rehydrated");
							if (!res.error) void refresh();
						})()
					}
				/>
			</div>
			<div class="tool-collapsed-note">no auto-restart — recovery only rehydrates state.</div>
			<Show
				when={workers().length > 0}
				fallback={<div class="tool-collapsed-note">no vibe workers</div>}
			>
				<For each={workers()}>
					{(w) => (
						<div class="goal-meta">
							<span class="picker-label">{w.name}</span> {w.cli ?? "n/a"} · {w.state ?? "n/a"} ·
							turns {String(w.turns ?? "n/a")} · queued {String(w.queued ?? "n/a")}
							<span class="goal-actions">
								<button type="button" onClick={() => void perWorker("vibeSend", w.name)}>
									send
								</button>
								<button type="button" onClick={() => void perWorker("vibeWait", w.name)}>
									wait
								</button>
								<ConfirmButton
									label="kill"
									confirmLabel="confirm kill"
									onConfirm={() => void perWorker("vibeKill", w.name)}
								/>
							</span>
						</div>
					)}
				</For>
				<ConfirmButton
					label="kill all"
					confirmLabel="confirm kill all"
					onConfirm={() => void perWorker("vibeKillAll", "all")}
				/>
				<div class="tool-collapsed-note">vibe workers only — Main/advisor unaffected.</div>
				<div class="tool-collapsed-note">suspend detaches on parent switch; kill terminates.</div>
			</Show>
			<div class="goal-meta">
				<span class="picker-label">spawn</span>
			</div>
			<label class="subagent-status">
				cli{" "}
				<select value={cli()} onChange={(e) => setCli(e.currentTarget.value as "fast" | "good")}>
					<option value="fast">fast</option>
					<option value="good">good</option>
				</select>
			</label>
			<div class="tool-collapsed-note">
				fast = @smol low-latency · good = @task strong model. permissions/budget inherit the parent
				session.
			</div>
			<textarea
				class="picker-filter"
				aria-label="Vibe prompt"
				placeholder="vibe prompt…"
				rows={3}
				value={prompt()}
				onInput={(e) => setPrompt(e.currentTarget.value)}
			/>
			<div class="goal-actions">
				<ConfirmButton
					label="spawn vibe worker"
					confirmLabel="confirm spawn"
					disabled={busy() || !prompt().trim()}
					onConfirm={() => void start()}
				/>
			</div>
		</div>
	);
};

/** Guided goals, loops, and Vibe (G08): consent-gated forms with explicit confirms; no auto-execution. */
export const GoalLoopPanel: Component = () => (
	<div class="subagent-list">
		<div class="msg-notice">consent gate: nothing runs until you confirm.</div>
		<GoalSection />
		<LoopSection />
		<VibeSection />
	</div>
);

/** Goals + loops half of GoalLoopPanel (used by the "Goals & Loops" hub tab). */
export const GoalLoopSection: Component = () => (
	<div class="subagent-list">
		<div class="msg-notice">consent gate: nothing runs until you confirm.</div>
		<GoalSection />
		<LoopSection />
	</div>
);

/** Vibe half of GoalLoopPanel (used by the "Vibe" hub tab). */
export const VibeOnlySection: Component = () => (
	<div class="subagent-list">
		<div class="msg-notice">consent gate: nothing runs until you confirm.</div>
		<VibeSection />
	</div>
);
