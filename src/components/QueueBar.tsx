import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { call, dequeueLastQueued, setState, state } from "../state";

interface QueuedMessages {
	steering: readonly string[];
	followUp: readonly string[];
}

const EMPTY: QueuedMessages = { steering: [], followUp: [] };

const preview = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
};

/**
 * Phase 7: queued steer/follow-up messages as clickable chips above the
 * prompt. × (or Alt+↑) pops the last message back into the textarea;
 * "clear all" drains the queue. The status-bar count chip stays as-is.
 */
export const QueueBar: Component = () => {
	const [queue, setQueue] = createSignal<QueuedMessages>(EMPTY);

	const refresh = () => {
		void call("getQueuedMessages")
			.then(result => setQueue(result as QueuedMessages))
			.catch(() => setQueue(EMPTY));
	};

	// Refetch whenever the mirrored queue depth changes — the post-mutation
	// state broadcast refreshes queuedMessageCount after every pop/clear/send,
	// and agent_end settles streaming. Initial fetch included.
	createEffect(() => {
		const count = state.queuedMessageCount;
		if (state.streaming || count > 0) refresh();
		else setQueue(EMPTY);
	});

	const chips = () => [
		...queue().steering.map(text => ({ kind: "steer" as const, text })),
		...queue().followUp.map(text => ({ kind: "follow-up" as const, text })),
	];

	const clearAll = () => {
		void call("clearQueue").catch(err => setState("error", String(err)));
	};

	return (
		<Show when={chips().length > 0}>
			<div class="queue-bar">
				<For each={chips()}>
					{chip => (
						<span class="queue-chip">
							<span class="queue-kind" classList={{ [chip.kind]: true }}>{chip.kind}</span>
							<span class="queue-text">{preview(chip.text)}</span>
							<button class="queue-pop" title="Pop back into the prompt (Alt+↑)" onClick={dequeueLastQueued}>
								×
							</button>
						</span>
					)}
				</For>
				<button class="queue-clear" onClick={clearAll}>
					clear all
				</button>
			</div>
		</Show>
	);
};
