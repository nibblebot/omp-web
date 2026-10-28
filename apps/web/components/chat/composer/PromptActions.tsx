import { Show, type Component } from "solid-js";
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
import { ArrowUpIcon, CornerDownRightIcon, ListPlusIcon, StopIcon } from "../../ui/icons";

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
 *  PromptComposer's `actions` slot. */
export const PromptActions: Component<PromptActionsProps> = (props) => {
	const paused = () => connectionState() !== "connected";
	const cannotSend = () =>
		paused() ||
		isSwitching() ||
		!isReady() ||
		isSessionChanging() ||
		(!props.message().trim() &&
			props.images().length === 0 &&
			!props.files().some((f) => f.text !== undefined));

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
					onClick={() => void stopTurn()}
				>
					<StopIcon />
				</button>
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
			<button
				type="button"
				class="send"
				aria-label={state.streaming ? "Steer" : "Send"}
				onMouseDown={keepComposerFocus}
				onClick={() => props.submit("enter")}
				disabled={cannotSend()}
				title={
					paused()
						? PAUSED_TOOLTIP[connectionState()]
						: isSessionChanging()
							? "Starting the new session…"
							: !isReady()
								? "The attached session is not ready yet…"
								: state.streaming
									? "Steer"
									: "Send"
				}
			>
				<Show when={state.streaming} fallback={<ArrowUpIcon />}>
					<CornerDownRightIcon />
				</Show>
			</button>
		</div>
	);
};
