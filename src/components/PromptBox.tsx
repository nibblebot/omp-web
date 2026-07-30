import { createSignal, For, type Component } from "solid-js";
import { PromptHistory } from "../history";
import type { ImageArg } from "../protocol";
import { call, setState, state } from "../state";

const history = new PromptHistory();

export const PromptBox: Component = () => {
	const [message, setMessage] = createSignal("");
	const [images, setImages] = createSignal<ImageArg[]>([]);
	let textarea!: HTMLTextAreaElement;

	const autoGrow = () => {
		textarea.style.height = "auto";
		textarea.style.height = `${textarea.scrollHeight}px`;
	};

	const submit = (mode: "enter" | "followup") => {
		const text = message().trim();
		const imgs = images();
		if (!text && imgs.length === 0) return;
		// steer on an idle session errors server-side; Enter falls back to prompt.
		const method = mode === "followup" ? "followUp" : state.streaming ? "steer" : "prompt";
		call(method, [text, imgs.length > 0 ? imgs : undefined])
			.then(() => history.push(text))
			.catch(err => setState("error", String(err)));
		setMessage("");
		setImages([]);
		history.reset();
		requestAnimationFrame(autoGrow);
	};

	const onPaste = (e: ClipboardEvent) => {
		const items = [...(e.clipboardData?.items ?? [])].filter(it => it.type.startsWith("image/"));
		if (items.length === 0) return; // non-image paste: default behavior
		e.preventDefault();
		for (const item of items) {
			const file = item.getAsFile();
			if (!file) continue;
			const { promise, resolve } = Promise.withResolvers<string>();
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsDataURL(file);
			void promise.then(dataUrl => {
				const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
				setImages(prev => [...prev, { type: "image", data, mimeType: item.type }]);
			});
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && state.streaming) {
			e.preventDefault();
			void call("abort").catch(err => setState("error", String(err)));
			return;
		}
		if (e.key === "Enter") {
			if (e.shiftKey) return; // newline
			e.preventDefault();
			submit(e.ctrlKey || e.metaKey ? "followup" : "enter");
			return;
		}
		const el = e.currentTarget as HTMLTextAreaElement;
		if (e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart).includes("\n")) {
			const recalled = history.prev(message());
			if (recalled !== null) {
				e.preventDefault();
				setMessage(recalled);
				requestAnimationFrame(autoGrow);
			}
			return;
		}
		if (e.key === "ArrowDown" && history.browsing && !el.value.slice(el.selectionEnd).includes("\n")) {
			const next = history.next();
			if (next !== null) {
				e.preventDefault();
				setMessage(next);
				requestAnimationFrame(autoGrow);
			}
		}
	};

	return (
		<div class="prompt-box">
			{images().length > 0 && (
				<div class="image-tray">
					<For each={images()}>
						{(img, i) => (
							<span class="image-thumb">
								<img src={`data:${img.mimeType};base64,${img.data}`} alt="pasted" />
								<button class="image-remove" onClick={() => setImages(prev => prev.filter((_, j) => j !== i()))}>
									×
								</button>
							</span>
						)}
					</For>
				</div>
			)}
			<textarea
				ref={textarea}
				value={message()}
				onInput={e => {
					setMessage(e.currentTarget.value);
					autoGrow();
				}}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				placeholder="Message the agent… (Enter send/steer, Ctrl+Enter follow-up, Shift+Enter newline)"
				rows={3}
			/>
			<div class="prompt-actions">
				<span class="hint-chip">{state.streaming ? "steer" : "send"}</span>
				<button class="new-session" onClick={() => void call("newSession").catch(err => setState("error", String(err)))}>
					New session
				</button>
				{state.streaming && (
					<button class="stop" onClick={() => void call("abort").catch(err => setState("error", String(err)))}>
						Stop
					</button>
				)}
				<button class="send" onClick={() => submit("enter")} disabled={!message().trim() && images().length === 0}>
					Send
				</button>
			</div>
		</div>
	);
};
