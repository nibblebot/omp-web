import { Show, type Component } from "solid-js";
import { dispatchInput, type InputMode } from "../../../prompt/commands";
import type { ImageArg } from "#lib/wire/protocol";
import type { TextAttachment } from "../../../prompt/attachments";
import { PAUSED_TOOLTIP } from "../../app/ConnectionBar";
import { connectionState, isActiveSubagent, isReady, state, stopTurn } from "../../../state";
import { RunningAgentsButton } from "./RunningAgentsButton";

interface PromptActionsProps {
	message: () => string;
	images: () => ImageArg[];
	files: () => TextAttachment[];
	submit: (mode: InputMode) => void;
	/** Explicit destructive clear → bounded cleared ring (Recover in composer). */
	onDiscard?: () => void;
}

/** Send/queue/abort row under the composer: New session, Stop, ready pill, Send. */
export const PromptActions: Component<PromptActionsProps> = (props) => {
	// While the composer is gated (readyAt cleared on session switch, re-armed
	// by the proxied ready frame), hint the attached session's status instead
	// of the generic "starting…".
	const paused = () => connectionState() !== "connected";
	const pausedTitle = () => (paused() ? PAUSED_TOOLTIP[connectionState()] : undefined);

	const rosterHint = () => {
		const daemon = state.daemonRoster.find((x) => x.daemonId === state.currentSessionId);
		if (!daemon) return "no workspace attached, pick one in the sidebar";
		if (daemon.status === "ready") return "attaching to session process…";
		return `session process ${daemon.status}…`;
	};

	return (
		<div class="prompt-actions">
			<button
				class="new-session"
				onClick={() => dispatchInput("/new", undefined, "enter")}
				disabled={paused()}
				title={pausedTitle()}
			>
				New session
			</button>
			{props.onDiscard &&
				(props.message().trim() || props.images().length > 0 || props.files().length > 0) && (
					<button
						class="queue-clear"
						title="Discard draft (recoverable via Recover)"
						onClick={props.onDiscard}
					>
						Discard
					</button>
				)}
			{state.streaming && (
				<button
					class="stop"
					disabled={paused()}
					title={pausedTitle() ?? "Stop the turn and its subagents"}
					onClick={() => void stopTurn()}
				>
					Stop
				</button>
			)}
			<Show when={state.streaming && [...state.subagents.values()].some(isActiveSubagent)}>
				<button
					class="stop-keep"
					title="Stop the turn but keep its running subagents"
					onClick={() => void stopTurn(true)}
				>
					Stop, keep subagents
				</button>
			</Show>
			<RunningAgentsButton />
			{/* R8: subtle "starting…" pill while the boot session's readiness
			    gate is clearing (the connection strip covers disconnects). Show the
			    attached session's status instead of the generic phrase. */}
			<Show when={state.connected && !isReady()}>
				<span
					class="ready-pill"
					title={"The attached session is still starting (or reconnecting)…"}
				>
					{rosterHint() ?? "starting…"}
				</span>
			</Show>
			<button
				class="send"
				onClick={() => props.submit("enter")}
				disabled={
					paused() ||
					!isReady() ||
					(!props.message().trim() &&
						props.images().length === 0 &&
						!props.files().some((f) => f.text !== undefined))
				}
				title={
					paused()
						? PAUSED_TOOLTIP[connectionState()]
						: !isReady()
							? "The attached session is not ready yet…"
							: undefined
				}
			>
				{state.streaming ? "Steer" : "Send"}
			</button>
		</div>
	);
};
