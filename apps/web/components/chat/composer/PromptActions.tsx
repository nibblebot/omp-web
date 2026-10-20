import { Show, type Component } from "solid-js";
import type { InputMode } from "../../../prompt/commands";
import type { ImageArg } from "#lib/wire/protocol";
import type { TextAttachment } from "../../../prompt/attachments";
import { PAUSED_TOOLTIP } from "../../app/ConnectionBar";
import { connectionState, isReady, isSessionChanging, state, stopTurn } from "../../../state";
import { ArrowUpIcon, CornerDownRightIcon, StopIcon } from "../../ui/icons";
import { RunningAgentsButton } from "./RunningAgentsButton";

interface PromptActionsProps {
	message: () => string;
	images: () => ImageArg[];
	files: () => TextAttachment[];
	submit: (mode: InputMode) => void;
}

/** Icon buttons beside the composer textarea: running-agents counter, Stop
 *  (only while streaming), and Send/Steer. Passed to PromptComposer's
 *  `actions` slot. */
export const PromptActions: Component<PromptActionsProps> = (props) => {
	const paused = () => connectionState() !== "connected";

	return (
		<div class="prompt-actions">
			<RunningAgentsButton />
			<Show when={state.streaming}>
				<button
					type="button"
					class="stop"
					aria-label="Stop"
					disabled={paused()}
					title={paused() ? PAUSED_TOOLTIP[connectionState()] : "Stop the turn and its subagents"}
					onClick={() => void stopTurn()}
				>
					<StopIcon />
				</button>
			</Show>
			<button
				type="button"
				class="send"
				aria-label={state.streaming ? "Steer" : "Send"}
				onClick={() => props.submit("enter")}
				disabled={
					paused() ||
					!isReady() ||
					isSessionChanging() ||
					(!props.message().trim() &&
						props.images().length === 0 &&
						!props.files().some((f) => f.text !== undefined))
				}
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
