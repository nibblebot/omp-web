import { createEffect, createSignal, on, Show, untrack, type Component } from "solid-js";
import { getFocusDraft, setFocusDraft } from "../../subagents/worker-scope";
import { isImeKey, resolveEnterAction } from "../../prompt/key-input";
import { PromptComposer } from "../chat/composer/PromptComposer";
import { enterSends } from "../../prompt/enter-key";
import { ConfirmButton } from "../ui/ConfirmButton";
import { CornerDownRightIcon, StopIcon } from "../ui/icons";

/**
 * Text-only steer box for a running agent: the main PromptComposer without
 * attachments, slash commands, autocomplete or history. Enter sends and
 * Shift+Enter adds a newline, unless the Enter key preference (or a touch
 * screen under `auto`) makes Enter the newline; the draft survives switching
 * agents. Stop aborts the agent after an inline confirm (unlike the main
 * composer's Stop).
 */
export const SubagentSteerComposer: Component<{
	id: string;
	/** Show the Stop button (the agent offers abort). */
	canAbort: boolean;
	/** A lifecycle action is in flight. */
	pending: boolean;
	/** Resolves true when the steer was delivered; the draft clears only then. */
	onSend: (text: string) => Promise<boolean>;
	onAbort: () => void;
}> = (props) => {
	const draftKey = () => `agent:${props.id}`;
	const [message, setMessage] = createSignal(getFocusDraft(draftKey()));
	let textarea: HTMLTextAreaElement | undefined;

	createEffect(on(draftKey, (key) => setMessage(getFocusDraft(key)), { defer: true }));
	createEffect(on(message, (text) => setFocusDraft(untrack(draftKey), text), { defer: true }));

	const send = async (): Promise<void> => {
		const text = message().trim();
		if (text === "" || props.pending) return;
		const key = draftKey();
		if (!(await props.onSend(text))) return;
		if (key === draftKey()) {
			setMessage("");
			textarea?.focus();
		} else setFocusDraft(key, "");
	};

	return (
		<div class="prompt-box subagent-composer">
			<PromptComposer
				textOnly
				message={message}
				setMessage={setMessage}
				placeholder="Steer this agent"
				ariaLabel="Steer this agent"
				setTextareaRef={(el) => {
					textarea = el;
				}}
				onKeyDown={(e) => {
					if (e.key !== "Enter" || isImeKey(e)) return;
					if (resolveEnterAction(e, enterSends()) === "newline") return;
					e.preventDefault();
					void send();
				}}
				actions={
					<div class="prompt-actions">
						<Show when={props.canAbort}>
							<ConfirmButton
								class="stop"
								label=""
								confirmLabel="Confirm abort"
								title="Abort this agent"
								disabled={props.pending}
								onConfirm={props.onAbort}
							>
								<StopIcon />
							</ConfirmButton>
						</Show>
						<button
							type="button"
							class="send"
							aria-label="Send steer"
							title="Send steer (Enter)"
							disabled={props.pending || message().trim() === ""}
							onClick={() => void send()}
						>
							<CornerDownRightIcon />
						</button>
					</div>
				}
			/>
		</div>
	);
};
