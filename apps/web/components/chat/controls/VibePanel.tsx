import { createSignal, For, onMount, Show, type Component } from "solid-js";
import {
	getVibeStatus,
	killAllVibeWorkers,
	killVibeWorker,
	rehydrateVibeWorkers,
	sendVibeWorker,
	setVibeMode,
	spawnVibeWorker,
	waitVibeWorker,
	type VibeStatus,
	type VibeWorkerDto,
} from "../../../store/goals";
import { ConfirmButton } from "../../ui/ConfirmButton";

/**
 * Vibe tab body for the Goal dialog (shell-less). Enable, send, spawn, and
 * kill are consent-gated; nothing runs until the user confirms. Vibe workers
 * are separate from task subagents and from Main.
 */
export const VibePanel: Component = () => {
	const [status, setStatus] = createSignal<VibeStatus>();
	const [error, setError] = createSignal<string>();
	const [cli, setCli] = createSignal<"fast" | "good">("fast");
	const [name, setName] = createSignal("");
	const [prompt, setPrompt] = createSignal("");

	const refresh = async (): Promise<void> => {
		setStatus(await getVibeStatus());
	};
	onMount(() => void refresh());

	const enabled = () => status()?.enabled === true;

	const runAction = async (action: () => Promise<string | undefined>) => {
		setError(await action());
		await refresh();
	};

	const spawn = async () => {
		const text = prompt().trim();
		if (!text) return;
		const trimmedName = name().trim();
		const err = await spawnVibeWorker({
			cli: cli(),
			prompt: text,
			name: trimmedName || undefined,
		});
		setError(err);
		if (!err) {
			setPrompt("");
			setName("");
		}
		await refresh();
	};

	return (
		<div class="goal-panel">
			<div class="goal-meta">
				<span class="picker-label">vibe</span> {enabled() ? "enabled" : "disabled"}
			</div>
			<Show when={status()?.reason}>{(reason) => <div class="picker-detail">{reason()}</div>}</Show>
			<div class="goal-actions">
				<ConfirmButton
					label={enabled() ? "disable vibe" : "enable vibe"}
					confirmLabel={enabled() ? "confirm disable" : "confirm enable"}
					onConfirm={() => void runAction(() => setVibeMode(!enabled()))}
				/>
				<button onClick={() => void refresh()}>refresh</button>
				<button onClick={() => void runAction(rehydrateVibeWorkers)}>rehydrate</button>
				<Show when={(status()?.workers.length ?? 0) > 0}>
					<ConfirmButton
						label="kill all workers"
						confirmLabel="confirm kill all"
						class="danger"
						onConfirm={() => void runAction(killAllVibeWorkers)}
					/>
				</Show>
			</div>
			<div class="picker-detail">no auto-restart — recovery only rehydrates state.</div>
			<div class="picker-detail">vibe workers only — Main/advisor unaffected.</div>
			<div class="picker-detail">suspend detaches on parent switch; kill terminates.</div>
			<div class="picker-detail">
				fast = @smol low-latency · good = @task strong model. permissions/budget inherit the parent
				session.
			</div>
			<Show
				when={(status()?.workers.length ?? 0) > 0}
				fallback={<div class="picker-detail">no vibe workers</div>}
			>
				<ul class="goal-workers">
					<For each={status()?.workers}>
						{(worker) => (
							<VibeWorkerRow
								worker={worker}
								onChanged={refresh}
								onError={(message) => setError(message)}
							/>
						)}
					</For>
				</ul>
			</Show>
			<div class="goal-actions">
				<select
					aria-label="Vibe cli"
					value={cli()}
					onChange={(e) => setCli(e.currentTarget.value === "good" ? "good" : "fast")}
				>
					<option value="fast">fast</option>
					<option value="good">good</option>
				</select>
				<input
					class="goal-set-input"
					aria-label="Vibe worker name"
					placeholder="name (optional)"
					value={name()}
					onInput={(e) => setName(e.currentTarget.value)}
				/>
			</div>
			<textarea
				aria-label="Vibe prompt"
				placeholder="Prompt for the new vibe worker"
				value={prompt()}
				onInput={(e) => setPrompt(e.currentTarget.value)}
			/>
			<div class="goal-actions">
				<ConfirmButton
					label="spawn vibe worker"
					confirmLabel="confirm spawn"
					disabled={!enabled() || prompt().trim().length === 0}
					title={enabled() ? undefined : "Enable vibe before spawning workers"}
					onConfirm={() => void spawn()}
				/>
			</div>
			<Show when={error()}>
				{(message) => (
					<div class="msg-notice" role="alert">
						{message()}
					</div>
				)}
			</Show>
			<div class="picker-detail">consent gate: nothing runs until you confirm.</div>
		</div>
	);
};

const VibeWorkerRow: Component<{
	worker: VibeWorkerDto;
	onChanged: () => Promise<void>;
	onError: (message: string | undefined) => void;
}> = (props) => {
	const [message, setMessage] = createSignal("");

	const send = async () => {
		const text = message().trim();
		if (!text) return;
		const err = await sendVibeWorker(props.worker.id, text);
		props.onError(err);
		if (!err) setMessage("");
		await props.onChanged();
	};

	const wait = async () => {
		props.onError(await waitVibeWorker(props.worker.id));
		await props.onChanged();
	};

	const kill = async () => {
		props.onError(await killVibeWorker(props.worker.id));
		await props.onChanged();
	};

	return (
		<li class="goal-worker-row">
			<span class="picker-label">{props.worker.name}</span>{" "}
			<span class="picker-detail">
				{props.worker.cli} · {props.worker.state} · turns {props.worker.turns} · queued{" "}
				{props.worker.queued}
			</span>
			<input
				aria-label={`Message ${props.worker.name}`}
				value={message()}
				onInput={(e) => setMessage(e.currentTarget.value)}
			/>
			<ConfirmButton
				label="send"
				confirmLabel="confirm send"
				disabled={message().trim().length === 0}
				onConfirm={() => void send()}
			/>
			<button onClick={() => void wait()}>wait</button>
			<ConfirmButton
				label="kill"
				confirmLabel="confirm kill"
				class="danger"
				onConfirm={() => void kill()}
			/>
		</li>
	);
};
