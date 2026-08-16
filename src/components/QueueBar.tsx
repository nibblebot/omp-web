import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { call, dequeueLastQueued, setState, state } from "../state";
import { XIcon } from "../icons";

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

	// Polite live region announcing queue fills/drains (the interactive chips
	// themselves stay out of the live region). Transition-gated: a 0→N fill
	// announces "N messages queued", an N→0 drain announces the clear.
	const [queueNotice, setQueueNotice] = createSignal("");
	let lastChipCount = 0;
	createEffect(() => {
		const n = chips().length;
		if (n > 0 && lastChipCount === 0) setQueueNotice(`${n} message${n === 1 ? "" : "s"} queued`);
		else if (n === 0 && lastChipCount > 0) setQueueNotice("Queue cleared");
		lastChipCount = n;
	});

	const clearAll = () => {
		void call("clearQueue").catch(err => setState("error", String(err)));
	};

	return (
		<>
			<Show when={chips().length > 0}>
				<div class="queue-bar">
					<For each={chips()}>
						{chip => (
							<span class="queue-chip">
								<span class="queue-kind" classList={{ [chip.kind]: true }}>{chip.kind}</span>
								<span class="queue-text">{preview(chip.text)}</span>
								<button class="queue-pop" title="Pop back into the prompt (Alt+↑)" aria-label="Pop back into the prompt (Alt+↑)" onClick={dequeueLastQueued}>
									<XIcon />
								</button>
							</span>
						)}
					</For>
					<button class="queue-clear" onClick={clearAll}>
						clear all
					</button>
				</div>
			</Show>
			<div
				role="status"
				style={{
					position: "absolute",
					width: "1px",
					height: "1px",
					padding: "0",
					margin: "-1px",
					overflow: "hidden",
					clip: "rect(0 0 0 0)",
					"white-space": "nowrap",
					border: "0",
				}}
			>
				{queueNotice()}
			</div>
		</>
	);
};
