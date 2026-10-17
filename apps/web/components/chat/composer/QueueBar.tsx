import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import type {
	QueuedCommandRef,
	QueuedMessageRef,
	QueuedMessagesSnapshot,
} from "#lib/wire/protocol";
import {
	call,
	deleteQueuedCommand,
	deleteQueuedMessage,
	editQueuedMessage,
	resumeQueuedMessages,
	runQueuedCommandNow,
	runQueuedMessageNow,
	state,
} from "../../../state";
import { reportError } from "../../../store/toasts";
import { XIcon } from "../../ui/icons";
import { queueTransitionNotice, type QueueExit } from "./queue-notice";

const EMPTY: QueuedMessagesSnapshot = { steering: [], followUp: [], liveSteered: 0, paused: [] };

interface Chip {
	kind: "steer" | "follow-up" | "command";
	text: string;
	paused: boolean;
	/** Undefined for a steer the running turn already consumed: the SDK cannot withdraw it. */
	ref?: QueuedMessageRef;
	/** A forwarded slash command queued while busy; removed by index and text (U10b). */
	command?: QueuedCommandRef;
}

const preview = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
};

/**
 * Phase 7: queued steer/follow-up messages as chips above the prompt. Each chip
 * edits into the prompt, runs now, or deletes by identity. A Stop pauses the
 * queue (paused chips); "Resume queue" sends it in order. "clear all" drains
 * the queue. On short viewports the chips collapse behind a one-line summary (prompt.css).
 */
export const QueueBar: Component = () => {
	const [queue, setQueue] = createSignal<QueuedMessagesSnapshot>(EMPTY);
	const [expanded, setExpanded] = createSignal(false);

	const refresh = async (): Promise<void> => {
		try {
			const result = (await call("getQueuedMessages")) as QueuedMessagesSnapshot;
			setQueue(result);
		} catch {
			setQueue(EMPTY);
		}
	};

	// Refetch whenever the mirrored queue depth changes. The post-mutation
	// state broadcast refreshes the counts after every send/pop/clear/stop, and
	// agent_end settles streaming. Actions that reorder without changing a count
	// call refresh() themselves. Initial fetch included.
	createEffect(() => {
		const count = state.queuedMessageCount;
		if (state.streaming || count > 0 || state.pausedQueueCount > 0) void refresh();
		else setQueue(EMPTY);
	});

	const chips = (): Chip[] => {
		const q = queue();
		return [
			...q.paused.map((p, index) => ({
				kind: p.kind,
				text: p.text,
				paused: true,
				ref: { kind: p.kind, text: p.text, paused: index },
			})),
			...q.steering.map((text, index) => ({
				kind: "steer" as const,
				text,
				paused: false,
				ref: index < q.liveSteered ? undefined : { kind: "steer" as const, text },
			})),
			...q.followUp.map((text) => ({
				kind: "follow-up" as const,
				text,
				paused: false,
				ref: { kind: "follow-up" as const, text },
			})),
			...(q.commands ?? []).map((text, index) => ({
				kind: "command" as const,
				text,
				paused: q.commandsPaused === true,
				command: { index, text },
			})),
		];
	};

	// Polite live region for queue transitions (chips stay out of it). The notice
	// names what happened: queued, paused by Stop, delivered by the running turn,
	// or cleared by clear all. Removing one chip by hand is silent.
	const [queueNotice, setQueueNotice] = createSignal("");
	let lastCounts = { chips: 0, paused: 0 };
	// Set by the operator action about to drain the queue; the next transition reads it once.
	let exit: QueueExit | undefined;
	createEffect(() => {
		const list = chips();
		const next = { chips: list.length, paused: list.filter((c) => c.paused).length };
		const notice = queueTransitionNotice(lastCounts, next, exit);
		exit = undefined;
		lastCounts = next;
		if (notice !== undefined) setQueueNotice(notice);
	});

	const after = (pending: Promise<void>) => {
		exit = "removed";
		void pending.then(refresh);
	};

	const clearAll = () => {
		exit = "cleared";
		void call("clearQueue")
			.then(refresh)
			.catch((error: unknown) => {
				exit = undefined;
				reportError(error);
			});
	};

	return (
		<>
			<Show when={chips().length > 0}>
				<div class="queue-bar" data-expanded={expanded() ? "" : undefined}>
					<button
						type="button"
						class="queue-summary"
						aria-expanded={expanded()}
						onClick={() => setExpanded(!expanded())}
					>
						{chips().length} queued
					</button>
					<div class="queue-chips">
						<For each={chips()}>
							{(chip) => (
								<span
									class="queue-chip"
									classList={{ paused: chip.paused }}
									title={
										chip.kind === "steer" && !chip.ref
											? "Already delivered to the running turn"
											: undefined
									}
								>
									<span class="queue-kind" classList={{ [chip.kind]: true }}>
										{chip.paused ? `paused ${chip.kind}` : chip.kind}
									</span>
									<span class="queue-text">{preview(chip.text)}</span>
									<Show when={chip.ref} keyed>
										{(ref) => (
											<>
												<button
													type="button"
													class="queue-action"
													title="Edit in the prompt"
													aria-label={`Edit queued ${chip.kind}`}
													onClick={() => after(editQueuedMessage(ref))}
												>
													edit
												</button>
												<button
													type="button"
													class="queue-action"
													title="Send now"
													aria-label={`Send queued ${chip.kind} now`}
													onClick={() => after(runQueuedMessageNow(ref))}
												>
													run now
												</button>
												<button
													type="button"
													class="queue-pop"
													title="Delete from the queue"
													aria-label={`Delete queued ${chip.kind}`}
													onClick={() => after(deleteQueuedMessage(ref))}
												>
													<XIcon />
												</button>
											</>
										)}
									</Show>
									<Show when={chip.command} keyed>
										{(ref) => (
											<>
												<button
													type="button"
													class="queue-action"
													title="Send now"
													aria-label="Send queued command now"
													onClick={() => after(runQueuedCommandNow(ref))}
												>
													run now
												</button>
												<button
													type="button"
													class="queue-pop"
													title="Delete from the queue"
													aria-label="Delete queued command"
													onClick={() => after(deleteQueuedCommand(ref))}
												>
													<XIcon />
												</button>
											</>
										)}
									</Show>
								</span>
							)}
						</For>
						<Show
							when={
								queue().paused.length > 0 ||
								(queue().commandsPaused === true && (queue().commands?.length ?? 0) > 0)
							}
						>
							<button
								type="button"
								class="queue-resume"
								onClick={() => after(resumeQueuedMessages())}
							>
								Resume queue
							</button>
						</Show>
						<button class="queue-clear" onClick={clearAll}>
							clear all
						</button>
					</div>
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
