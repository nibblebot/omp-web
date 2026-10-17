import { createEffect, createSignal, For, on, onMount, Show, type Component } from "solid-js";
import { state } from "../../../state";
import {
	cancelLoop,
	getLoopPolicy,
	pauseLoop,
	previewLoop,
	resumeLoop,
	startLoop,
	validLoopLimit,
	type LoopMode,
	type LoopPolicy,
	type LoopPreviewResult,
} from "../../../store/goals";
import { ConfirmButton } from "../../ui/ConfirmButton";

const LOOP_MODES: LoopMode[] = ["count", "duration", "until", "while"];

/**
 * Loops tab body for the Goal dialog (shell-less). Preview is read-only;
 * start, cancel are consent-gated and nothing runs until confirmed. Loops
 * cannot start while goal mode is on (the daemon rejects it), so the start
 * control shows the reason instead.
 */
export const LoopPanel: Component = () => {
	const [mode, setMode] = createSignal<LoopMode>("count");
	const [limit, setLimit] = createSignal("5");
	const [command, setCommand] = createSignal("");
	const [prompt, setPrompt] = createSignal("");
	const [preview, setPreview] = createSignal<LoopPreviewResult>();
	const [policy, setPolicy] = createSignal<LoopPolicy>();
	const [error, setError] = createSignal<string>();

	const argsText = (): string => {
		if (mode() === "count" || mode() === "duration") return limit().trim();
		return `--${mode()} '${command().trim().replaceAll("'", "'\\''")}'`;
	};
	const conditionValid = (): boolean => {
		if (mode() === "count" || mode() === "duration") return validLoopLimit(mode(), limit().trim());
		return command().trim().length > 0;
	};
	const busy = () => policy()?.status === "running" || policy()?.status === "paused";
	const goalActive = () => state.goalModeState?.enabled === true;
	const canStart = () =>
		preview()?.ok === true &&
		policy()?.boundedLoop === true &&
		!busy() &&
		!goalActive() &&
		prompt().trim().length > 0;

	const refresh = async () => setPolicy(await getLoopPolicy());
	onMount(() => void refresh());
	// A preview only describes the arguments it was made for.
	createEffect(on(argsText, () => setPreview(undefined), { defer: true }));

	const runAction = async (action: () => Promise<string | undefined>) => {
		setError(await action());
		await refresh();
	};

	const runPreview = async () => {
		setError(undefined);
		setPreview(await previewLoop(argsText()));
	};

	const changeMode = (next: LoopMode) => {
		setMode(next);
		if (next === "count") setLimit("5");
		if (next === "duration") setLimit("10m");
	};

	return (
		<div class="goal-panel">
			<Show when={goalActive()}>
				<div class="picker-detail" role="status">
					Goal mode is on. Finish or drop the goal before starting a loop.
				</div>
			</Show>
			<Show when={policy()}>
				{(p) => (
					<>
						<div class="goal-meta">
							<span class="picker-label">loop</span>
							<span>
								{p().status} · iteration {p().iteration} · queued {p().queuedMessageCount}
								{p().isStreaming ? " · streaming" : ""}
								{p().hasPostPromptWork ? " · post-prompt work" : ""}
							</span>
						</div>
						<Show when={p().stopReason}>
							{(reason) => <div class="picker-detail">stop: {reason()}</div>}
						</Show>
						<Show when={p().nextRunAt}>
							{(at) => (
								<div class="picker-detail">next run: {new Date(at()).toLocaleTimeString()}</div>
							)}
						</Show>
						<Show when={p().pauseAllUnavailableReason}>
							{(reason) => <div class="picker-detail">{reason()}</div>}
						</Show>
					</>
				)}
			</Show>
			<div class="goal-actions">
				<label>
					<span class="picker-label">mode</span>
					<select
						aria-label="Loop mode"
						value={mode()}
						onChange={(e) => changeMode(e.currentTarget.value as LoopMode)}
					>
						<For each={LOOP_MODES}>{(entry) => <option value={entry}>{entry}</option>}</For>
					</select>
				</label>
				<Show
					when={mode() === "count" || mode() === "duration"}
					fallback={
						<input
							class="goal-set-input"
							aria-label="Loop condition command"
							placeholder="shell command, e.g. test -f done.txt"
							value={command()}
							onInput={(e) => setCommand(e.currentTarget.value)}
						/>
					}
				>
					<input
						class="goal-set-input"
						aria-label="Loop limit"
						placeholder={mode() === "count" ? "iterations, e.g. 5" : "duration, e.g. 10m"}
						value={limit()}
						onInput={(e) => setLimit(e.currentTarget.value)}
					/>
				</Show>
			</div>
			<textarea
				aria-label="Loop prompt"
				placeholder="Prompt sent on each iteration"
				value={prompt()}
				onInput={(e) => setPrompt(e.currentTarget.value)}
			/>
			<div class="goal-actions">
				<button disabled={!conditionValid()} onClick={() => void runPreview()}>
					preview
				</button>
				<button onClick={() => void refresh()}>refresh scheduler</button>
				<ConfirmButton
					label="start loop"
					confirmLabel="confirm session loop"
					disabled={!canStart()}
					title={
						goalActive()
							? "Goal mode is on"
							: policy()?.boundedLoop === false
								? "Loop policy is not bounded"
								: undefined
					}
					onConfirm={() => void runAction(() => startLoop(argsText(), prompt().trim()))}
				/>
				<button disabled={policy()?.status !== "running"} onClick={() => void runAction(pauseLoop)}>
					pause loop
				</button>
				<button disabled={policy()?.status !== "paused"} onClick={() => void runAction(resumeLoop)}>
					resume loop
				</button>
				<ConfirmButton
					label="cancel loop"
					confirmLabel="confirm cancel"
					class="danger"
					disabled={!busy()}
					onConfirm={() => void runAction(cancelLoop)}
				/>
			</div>
			<Show when={preview()}>
				{(result) => {
					const r = result();
					return r.ok ? (
						<div class="picker-detail">preview: {r.summary}</div>
					) : (
						<div class="msg-notice" role="alert">
							{r.error}
						</div>
					);
				}}
			</Show>
			<Show when={error()}>
				{(message) => (
					<div class="msg-notice" role="alert">
						{message()}
					</div>
				)}
			</Show>
			<div class="picker-detail">
				No infinite default. Conditions run shell commands in the session process. Pause/cancel
				prevent future admissions; they do not abort a running turn.
			</div>
			<div class="picker-detail">consent gate: nothing runs until you confirm.</div>
		</div>
	);
};
