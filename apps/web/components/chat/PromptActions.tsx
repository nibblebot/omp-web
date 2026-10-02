import { Show, type Component } from "solid-js";
import { dispatchInput, type InputMode } from "../../prompt/commands";
import type { ImageArg } from "#lib/wire/protocol";
import { call, isReady, setState, state } from "../../state";

interface PromptActionsProps {
	message: () => string;
	images: () => ImageArg[];
	submit: (mode: InputMode) => void;
}

/** Send/queue/abort row under the composer: New session, Stop, ready pill, Send. */
export const PromptActions: Component<PromptActionsProps> = (props) => {
	// While the composer is gated (readyAt cleared on session switch, re-armed
	// by the proxied ready frame), hint the attached session's status instead
	// of the generic "starting…".
	const rosterHint = () => {
		const daemon = state.daemonRoster.find((x) => x.daemonId === state.currentSessionId);
		if (!daemon) return "no daemon attached, pick one in the sidebar";
		if (daemon.status === "ready") return "attaching to daemon…";
		return `daemon ${daemon.status}…`;
	};

	return (
		<div class="prompt-actions">
			<button class="new-session" onClick={() => dispatchInput("/new", undefined, "enter")}>
				New session
			</button>
			{state.streaming && (
				<button
					class="stop"
					onClick={() => void call("abort").catch((err) => setState("error", String(err)))}
				>
					Stop
				</button>
			)}
			{/* R8: subtle "starting…" pill while the boot session's readiness
			    gate is clearing (disconnect already has its own pill). Show the
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
				disabled={!isReady() || (!props.message().trim() && props.images().length === 0)}
				title={
					!state.connected
						? "Not connected"
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
