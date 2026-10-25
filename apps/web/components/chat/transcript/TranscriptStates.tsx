import { createMemo, onMount, Show, type Component } from "solid-js";
import { createPresence } from "../../../motion/presence";
import { state, switchToSession } from "../../../state";

/** The roster entry the switch in flight (or failed) is aimed at. */
function useTarget() {
	return createMemo(() =>
		state.sessionRoster.find((d) => d.workspaceId === state.transcriptTarget),
	);
}

/**
 * Message-shaped placeholder blocks at the transcript's column width while a
 * switch loads (the view only mounts it once a switch ran past
 * SKELETON_DELAY_MS). It stays mounted through its fade-out; the status line
 * tells what the wait is for.
 */
export const TranscriptSkeleton: Component<{ open: boolean }> = (props) => {
	const presence = createPresence(() => props.open);
	const target = useTarget();
	const status = () =>
		state.transcriptPhase === "waking"
			? `Waking ${target()?.name ?? "session"}…`
			: "Loading history…";
	return (
		<Show when={presence.mounted()}>
			<div class="chat-transcript-skeleton" data-motion={presence.phase()} ref={presence.ref}>
				<p class="chat-transcript-skeleton-status shimmer-text" role="status">
					{status()}
				</p>
				<div class="chat-transcript-skeleton-column" aria-hidden="true">
					<div class="chat-skeleton-block chat-skeleton-block--user">
						<span class="chat-skeleton-line" />
						<span class="chat-skeleton-line chat-skeleton-line--short" />
					</div>
					<div class="chat-skeleton-block">
						<span class="chat-skeleton-line" />
						<span class="chat-skeleton-line" />
						<span class="chat-skeleton-line chat-skeleton-line--medium" />
					</div>
					<div class="chat-skeleton-block chat-skeleton-block--tool">
						<span class="chat-skeleton-line chat-skeleton-line--short" />
					</div>
					<div class="chat-skeleton-block">
						<span class="chat-skeleton-line" />
						<span class="chat-skeleton-line chat-skeleton-line--medium" />
					</div>
				</div>
			</div>
		</Show>
	);
};

/**
 * A switch that did not land: why, and a Retry that runs the switch again. The
 * old session is still attached underneath (the composer stays disabled), so
 * this panel is the only thing to act on and takes focus.
 */
export const TranscriptFailed: Component = () => {
	const target = useTarget();
	// A session that exited (77/78) carries its reason on the roster entry.
	const reason = () => {
		const entry = target();
		return (entry?.status === "error" ? entry.error : undefined) ?? state.transcriptError;
	};
	let retry!: HTMLButtonElement;
	onMount(() => retry.focus({ preventScroll: true }));
	return (
		<div class="chat-transcript-failed" role="alert">
			<div class="chat-transcript-failed-body">
				<p class="chat-transcript-failed-title">Couldn't open {target()?.name ?? "the session"}</p>
				<Show when={reason()}>
					<p class="chat-transcript-failed-reason">{reason()}</p>
				</Show>
				<button
					ref={retry}
					type="button"
					class="chat-transcript-failed-retry"
					onClick={() => {
						if (state.transcriptTarget !== null) void switchToSession(state.transcriptTarget);
					}}
				>
					Retry
				</button>
			</div>
		</div>
	);
};
