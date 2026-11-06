import { createSignal, type Component } from "solid-js";
import { dispatchInput, parseInput, type InputMode } from "../../../prompt/commands";
import { caretOnFirstRow } from "../../../prompt/caret-row";
import { isImeKey, resolveEnterAction } from "../../../prompt/key-input";
import { PromptHistory } from "../../../prompt/history";
import type { ImageArg } from "#lib/wire/protocol";
import { composeTextAttachments, type TextAttachment } from "../../../prompt/attachments";
import {
	connectionState,
	dequeueLastQueued,
	isReady,
	isSessionChanging,
	isSwitching,
	pushNotice,
	state,
	stopTurn,
} from "../../../state";
import { cancelScheduledDraftSave, currentDraftKey, removeDraft } from "../../../store/drafts";
import { reportError } from "../../../store/toasts";
import { openDock } from "../../../store/dock";
import { AskBar } from "../../requests/AskBar";
import { ExtensionUi } from "../../requests/ExtensionUi";
import { PromptActions } from "./PromptActions";
import { PromptComposer, expandChipsForSubmit } from "./PromptComposer";
import { usePromptAutocomplete } from "./usePromptAutocomplete";
import { useGhostText } from "./useGhostText";
import { enterSends } from "../../../prompt/enter-key";

const history = new PromptHistory();

/**
 * P2 prompt box (G03). Submit expands `^model` chips, pushes submitted text
 * to history (separate from unsent drafts), and clears the live draft slot.
 * Plain Up with the caret on the top visual row (no newline or soft wrap
 * before it) opens the prompt history popover (PromptHistoryPicker); Up on
 * later rows keeps native caret motion.
 */
export const PromptBox: Component = () => {
	const [message, setMessage] = createSignal("");
	const [images, setImages] = createSignal<ImageArg[]>([]);
	const [files, setFiles] = createSignal<TextAttachment[]>([]);
	const [historyOpen, setHistoryOpen] = createSignal(false);
	let textarea!: HTMLTextAreaElement;
	const ac = usePromptAutocomplete(() => textarea, message, setMessage);
	const ghost = useGhostText(() => textarea, message, setMessage);
	// Double-Esc on an empty textarea opens the branch picker (TUI parity).
	let lastEsc = 0;

	const submit = (mode: InputMode) => {
		// A switch in flight: the old session is still attached underneath, so a
		// prompt must never reach it.
		if (isSwitching()) return;
		// R8 readiness gate: the send button is disabled and Enter is suppressed
		// until the server broadcasts `ready` (boot session's gate cleared), and
		// while the transport is down (the connection strip explains why).
		if (connectionState() !== "connected") {
			reportError(new Error("Message not sent: the connection is down. Retry once it reconnects."));
			return;
		}
		if (isSessionChanging()) {
			// The draft stays in the textarea: the new session's identity has not landed yet.
			reportError(
				new Error("Message not sent: the new session is still starting. Retry in a moment."),
			);
			return;
		}
		if (!isReady()) {
			reportError(new Error("Message not sent: the attached session is not ready yet."));
			return;
		}
		const text = message().trim();
		const imgs = images();
		const attached = files().filter((f) => f.text !== undefined);
		if (!text && imgs.length === 0 && attached.length === 0) return;
		// Attached text is inlined into the message; a shell or slash command would take it as arguments.
		const kind = parseInput(text).kind;
		if (attached.length > 0 && (kind === "bash" || kind === "python" || kind === "slash")) {
			pushNotice(
				"error",
				"Remove the attached files to run this command; files only go with messages.",
			);
			return;
		}
		void expandChipsForSubmit(text).then((expanded) => {
			dispatchInput(composeTextAttachments(expanded, attached), imgs, mode);
		});
		if (text) history.push(text);
		setMessage("");
		ghost.retire();
		setImages([]);
		setFiles([]);
		ac.setToken(null);
		const key = currentDraftKey();
		if (key) {
			cancelScheduledDraftSave(key);
			removeDraft(key);
		}
		requestAnimationFrame(ac.autoGrow);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		// An IME owns Enter, Tab, arrows and Escape while composing (Gboard reports keyCode 229).
		if (isImeKey(e)) return;
		// Alt+↑ pops the last queued message back into the textarea.
		if (e.key === "ArrowUp" && e.altKey) {
			e.preventDefault();
			dequeueLastQueued();
			return;
		}
		// The predictions list owns navigation, swap and dismissal while it is open.
		if (ghost.alternatives.onKeyDown(e)) {
			lastEsc = 0;
			return;
		}
		// AutocompletePopup owns navigation while the popup is open.
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
				// Exact match typed out: Enter submits. A partial command that takes no
				// arguments runs in one press (CMD-16); the rest complete first.
				if (
					sel &&
					t &&
					sel.label !== `/${t.query}` &&
					sel.label !== `@${t.query}` &&
					sel.label !== `^${t.query}`
				) {
					e.preventDefault();
					if (sel.label.startsWith("/") && !sel.hint) {
						setMessage(sel.apply.trimEnd());
						ac.setToken(null);
						submit("enter");
						return;
					}
					ac.apply(sel);
					return;
				}
			}
		}
		// Tab (popup closed) or ArrowRight accepts a ghost suggestion at the caret end; Tab over a
		// draft that equals one of several predictions opens their list instead.
		if ((e.key === "Tab" && !e.shiftKey) || e.key === "ArrowRight") {
			if (ghost.accept()) {
				e.preventDefault();
				return;
			}
		}
		if (e.key === "Tab" && !e.shiftKey && ghost.openAlternatives()) {
			e.preventDefault();
			return;
		}
		if (e.key === "Escape" && state.streaming) {
			e.preventDefault();
			lastEsc = 0;
			void stopTurn();
			return;
		}
		if (e.key === "Escape") {
			// Double-Esc on an empty textarea opens the branch picker (TUI
			// parity); Esc with text just resets the chord timer.
			if (message().trim() === "") {
				const now = Date.now();
				if (now - lastEsc <= 500) {
					lastEsc = 0;
					openDock("tree");
				} else lastEsc = now;
			} else lastEsc = 0;
			return;
		}
		if (e.key === "Enter") {
			const action = resolveEnterAction(e, enterSends());
			if (action === "newline") return; // the textarea inserts it
			e.preventDefault();
			submit(action === "followup" ? "followup" : "enter");
			return;
		}
		const el = e.currentTarget as HTMLTextAreaElement;
		// Up with the caret on the top visual row opens the history popover;
		// caret motion on later rows (logical or soft-wrapped) and IME always
		// win; with no history, Up goes to the browser. Cheap checks first, so
		// the layout-based row check only runs when it could matter.
		if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			if (new PromptHistory().size === 0) return;
			if (!caretOnFirstRow(el)) return;
			e.preventDefault();
			setHistoryOpen(true);
		}
	};

	return (
		<div class="prompt-box">
			{/* Extension widget slots around the editor; modal contributions mount in ModalHost. */}
			<ExtensionUi placement="aboveEditor" />
			<AskBar />
			<PromptComposer
				message={message}
				setMessage={setMessage}
				images={images}
				setImages={setImages}
				files={files}
				setFiles={setFiles}
				ac={ac}
				ghost={ghost}
				onKeyDown={onKeyDown}
				setTextareaRef={(el) => {
					textarea = el;
				}}
				historyOpen={historyOpen}
				closeHistory={() => setHistoryOpen(false)}
				openHistory={() => setHistoryOpen(true)}
				actions={<PromptActions message={message} images={images} files={files} submit={submit} />}
			/>
			<ExtensionUi placement="belowEditor" />
		</div>
	);
};
