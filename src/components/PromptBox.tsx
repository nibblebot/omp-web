import { createSignal, type Component } from "solid-js";
import { send, state } from "../state";

export const PromptBox: Component = () => {
	const [message, setMessage] = createSignal("");
	const submit = () => {
		const text = message().trim();
		if (!text || state.streaming) return;
		send({ type: "prompt", message: text });
		setMessage("");
	};
	return (
		<div class="prompt-box">
			<textarea
				value={message()}
				onInput={e => setMessage(e.currentTarget.value)}
				onKeyDown={e => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
				disabled={state.streaming}
				placeholder="Message the agent… (Enter to send, Shift+Enter for newline)"
				rows={3}
			/>
			<div class="prompt-actions">
				<button class="new-session" onClick={() => send({ type: "new_session" })}>
					New session
				</button>
				{state.streaming ? (
					<button class="stop" onClick={() => send({ type: "abort" })}>
						Stop
					</button>
				) : (
					<button class="send" onClick={submit} disabled={!message().trim()}>
						Send
					</button>
				)}
			</div>
		</div>
	);
};
