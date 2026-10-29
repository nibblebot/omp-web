import { onCleanup, Show, type Component } from "solid-js";
import type { InputMode } from "../../../prompt/commands";
import type { ImageArg } from "#lib/wire/protocol";
import type { TextAttachment } from "../../../prompt/attachments";
import { PAUSED_TOOLTIP } from "../../app/ConnectionBar";
import {
	connectionState,
	isReady,
	isSessionChanging,
	isSwitching,
	state,
	stopTurn,
} from "../../../state";
import { compactComposer } from "../../../prompt/compact-composer";
import { ArrowUpIcon, CornerDownRightIcon, ListPlusIcon, StopIcon } from "../../ui/icons";

/** How long a press on Steer is held before it queues the message as a follow-up instead. */
const QUEUE_HOLD_MS = 500;

interface PromptActionsProps {
	message: () => string;
	images: () => ImageArg[];
	files: () => TextAttachment[];
	submit: (mode: InputMode) => void;
}

/**
 * Keeps focus in the textarea when a composer button is pressed. A focus move to
 * the button would close the soft keyboard on every Send and Stop.
 */
export const keepComposerFocus = (e: MouseEvent): void => e.preventDefault();

/** Icon buttons beside the composer textarea: Stop and Queue (only while streaming) and
 *  Send/Steer. Queue is the touch route to the Ctrl+Enter follow-up. Passed to
 *  PromptComposer's `actions` slot.
 *
 *  Phone layout (compact composer) while a turn runs: Stop alone while the box is empty,
 *  Steer joins it once there is something to send, and Queue folds into Steer: holding
 *  Steer queues the message as a follow-up (the `=> ` prefix still works too). */
export const PromptActions: Component<PromptActionsProps> = (props) => {
	const paused = () => connectionState() !== "connected";
	const hasContent = () =>
		props.message().trim() !== "" ||
		props.images().length > 0 ||
		props.files().some((f) => f.text !== undefined);
	const cannotSend = () =>
		paused() || isSwitching() || !isReady() || isSessionChanging() || !hasContent();
	const compactTurn = () => compactComposer() && state.streaming;
	// Hold-to-queue on the phone layout's Steer button. A hold that fired swallows the
	// click that follows the release.
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let held = false;
	// Queuing clears the box, so Steer unmounts mid-hold and Stop slides under the finger:
	// the release's click then lands on Stop. Stop acts only on a press that began on it
	// (or a keyboard click, detail 0).
	let stopPressed = false;
	const cancelHold = () => clearTimeout(holdTimer);
	const startHold = (e: PointerEvent) => {
		held = false;
		stopPressed = false;
		if (!compactTurn() || cannotSend() || e.button !== 0) return;
		cancelHold();
		holdTimer = setTimeout(() => {
			held = true;
			navigator.vibrate?.(10);
			props.submit("followup");
		}, QUEUE_HOLD_MS);
	};
	onCleanup(cancelHold);

	return (
		<div class="prompt-actions">
			<Show when={state.streaming}>
				<button
					type="button"
					class="stop"
					aria-label="Stop"
					disabled={paused() || isSwitching()}
					title={paused() ? PAUSED_TOOLTIP[connectionState()] : "Stop the turn and its subagents"}
					onMouseDown={keepComposerFocus}
					onPointerDown={() => (stopPressed = true)}
					onPointerCancel={() => (stopPressed = false)}
					onClick={(e) => {
						const pressed = e.detail === 0 || stopPressed;
						stopPressed = false;
						if (pressed) void stopTurn();
					}}
				>
					<StopIcon />
				</button>
				<Show when={!compactComposer()}>
					<button
						type="button"
						class="queue-followup prompt-touch-only"
						aria-label="Queue as follow-up"
						title="Queue as follow-up (Ctrl+Enter)"
						disabled={cannotSend()}
						onMouseDown={keepComposerFocus}
						onClick={() => props.submit("followup")}
					>
						<ListPlusIcon />
					</button>
				</Show>
			</Show>
			<Show when={!compactTurn() || hasContent()}>
				<button
					type="button"
					class="send"
					aria-label={state.streaming ? "Steer" : "Send"}
					aria-description={compactTurn() ? "Hold to queue as a follow-up" : undefined}
					onMouseDown={keepComposerFocus}
					onPointerDown={startHold}
					onPointerUp={cancelHold}
					onPointerCancel={cancelHold}
					onPointerLeave={cancelHold}
					onContextMenu={(e) => {
						if (compactTurn()) e.preventDefault();
					}}
					onClick={() => {
						if (held) {
							held = false;
							return;
						}
						props.submit("enter");
					}}
					disabled={cannotSend()}
					title={
						paused()
							? PAUSED_TOOLTIP[connectionState()]
							: isSessionChanging()
								? "Starting the new session…"
								: !isReady()
									? "The attached session is not ready yet…"
									: state.streaming
										? compactTurn()
											? "Steer (hold to queue as a follow-up)"
											: "Steer"
										: "Send"
					}
				>
					<Show when={state.streaming} fallback={<ArrowUpIcon />}>
						<CornerDownRightIcon />
					</Show>
				</button>
			</Show>
		</div>
	);
};
