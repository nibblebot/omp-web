import { createSignal, type Component } from "solid-js";
import { dispatchInput, type InputMode } from "../../prompt/commands";
import { PromptHistory } from "../../prompt/history";
import type { ImageArg } from "#lib/wire/protocol";
import { call, dequeueLastQueued, isReady, setState, state } from "../../state";
import { cancelScheduledDraftSave, clearDraft, currentDraftKey, removeDraft, saveDraft } from "../../store/drafts";
import { PromptActions } from "./PromptActions";
import { PromptComposer, expandChipsForSubmit } from "./PromptComposer";
import { usePromptAutocomplete } from "./usePromptAutocomplete";

const history = new PromptHistory();

/**
 * P2 prompt box (G03). Submit expands `^model` chips, pushes submitted text
 * to history (separate from unsent drafts), and clears the live draft slot.
 * Compatible Up: plain Up browses submitted history ONLY when the caret is
 * on the first line and the composer is not folded/Vim-visual — never
 * stealing caret motion or cleared-draft recovery (explicit Recover action).
 */
export const PromptBox: Component = () => {
	const [message, setMessage] = createSignal("");
	const [images, setImages] = createSignal<ImageArg[]>([]);
	let textarea!: HTMLTextAreaElement;
	const ac = usePromptAutocomplete(() => textarea, message, setMessage);
	// Double-Esc on an empty textarea opens the branch picker (TUI parity).
	let lastEsc = 0;

	const submit = (mode: InputMode) => {
		// R8 readiness gate: the send button is disabled and Enter is suppressed
		// until the server broadcasts `ready` (boot session's gate cleared).
		if (!isReady()) return;
		const raw = message();
		const text = raw.trim();
		const imgs = images();
		if (!text && imgs.length === 0) return;
		void expandChipsForSubmit(raw.trim()).then((expanded) => {
			dispatchInput(expanded, imgs, mode);
		});
		if (text) history.push(text);
		setMessage("");
		setImages([]);
		ac.setToken(null);
		history.reset();
		const key = currentDraftKey();
		cancelScheduledDraftSave(key);
		removeDraft(key);
		requestAnimationFrame(ac.autoGrow);
	};

	/** Explicit destructive clear (toolbar/discard): moves the live text to
	 *  the bounded cleared ring for recovery, then empties the composer. */
	const discard = (): void => {
		cancelScheduledDraftSave(currentDraftKey());
		const text = message();
		const imgs = images();
		if (!text.trim() && imgs.length === 0) return;
		saveDraft(currentDraftKey(), { text, images: imgs, updatedAt: Date.now() });
		clearDraft(currentDraftKey());
		setMessage("");
		setImages([]);
		requestAnimationFrame(ac.autoGrow);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		// Alt+↑ pops the last queued message back into the textarea.
		if (e.key === "ArrowUp" && e.altKey) {
			e.preventDefault();
			dequeueLastQueued();
			return;
		}
		// Autocomplete owns navigation while the popup is open.
		if (ac.open()) {
			const list = ac.items();
			if (e.key === "ArrowDown") {
				e.preventDefault();
				ac.setSelected((i) => (i + 1) % list.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				ac.setSelected((i) => (i - 1 + list.length) % list.length);
				return;
			}
			if (e.key === "Tab") {
				e.preventDefault();
				ac.apply(list[ac.selected()] ?? list[0]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				lastEsc = 0;
				ac.setDismissed(true);
				ac.setToken(null);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
				const sel = list[ac.selected()];
				const t = ac.token();
				// Exact match typed out: Enter submits; otherwise it completes.
				if (sel && t && sel.label !== `/${t.query}` && sel.label !== `@${t.query}`) {
					e.preventDefault();
					ac.apply(sel);
					return;
				}
			}
		}
		if (e.key === "Escape" && state.streaming) {
			e.preventDefault();
			lastEsc = 0;
			void call("abort").catch((err) => setState("error", String(err)));
			return;
		}
		if (e.key === "Escape") {
			// Double-Esc on an empty textarea opens the branch picker (TUI
			// parity); Esc with text just resets the chord timer.
			if (message().trim() === "") {
				const now = Date.now();
				if (now - lastEsc <= 500) {
					lastEsc = 0;
					setState("modal", "branch");
				} else lastEsc = now;
			} else lastEsc = 0;
			return;
		}
		if (e.key === "Enter") {
			if (e.shiftKey) return; // newline
			e.preventDefault();
			submit(e.ctrlKey || e.metaKey ? "followup" : "enter");
			return;
		}
		const el = e.currentTarget as HTMLTextAreaElement;
		// Compatible Up: first-line caret + no multiline above + not browsing
		// a cleared recovery. Multiline caret motion and IME always win.
		if (
			e.key === "ArrowUp" &&
			!e.shiftKey &&
			!el.value.slice(0, el.selectionStart).includes("\n")
		) {
			if (e.isComposing || e.keyCode === 229) return;
			const recalled = history.prev(message());
			if (recalled !== null) {
				e.preventDefault();
				setMessage(recalled);
				requestAnimationFrame(ac.autoGrow);
			}
			return;
		}
		if (
			e.key === "ArrowDown" &&
			history.browsing &&
			!el.value.slice(el.selectionEnd).includes("\n")
		) {
			const next = history.next();
			if (next !== null) {
				e.preventDefault();
				setMessage(next);
				requestAnimationFrame(ac.autoGrow);
			}
		}
	};

	return (
		<div class="prompt-box">
			<PromptComposer
				message={message}
				setMessage={setMessage}
				images={images}
				setImages={setImages}
				ac={ac}
				onKeyDown={onKeyDown}
				setTextareaRef={(el) => {
					textarea = el;
				}}
			/>
			<PromptActions message={message} images={images} submit={submit} onDiscard={discard} />
		</div>
	);
};
