import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	on,
	Show,
	type Component,
	type JSX,
	type Setter,
} from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import {
	isSwitching,
	promptFocusRequest,
	promptInsert,
	setPromptFocusRequest,
	setPromptInsert,
} from "../../../state";
import { mayAutoFocusComposer } from "../../../store/chat";
import {
	cancelScheduledDraftSave,
	currentDraftKey,
	draftKey,
	unsavedFileIds,
	scheduleDraftSave,
	swapDraft,
	type DraftBody,
} from "../../../store/drafts";
import { graphGeneration } from "../../../store/graph";
import { expandMentionChips, getModelMentions, MODEL_MENTION_RE } from "../../../store/models";
import {
	ATTACH_ACCEPT,
	foldedPreview,
	PASTE_LARGE_MENU_DEFAULT,
	clipboardImageCandidates,
	readImagePayload,
	shouldFoldPaste,
	unsupportedImageReason,
	validateImage,
} from "../../../prompt/paste";
import { importTextAttachment, type TextAttachment } from "../../../prompt/attachments";
import { droppedFiles, fileDragDepth, setDroppedFiles } from "../../../prompt/file-drop";
import { settingValue } from "../../../store/settings";
import { ArrowRightIcon, CameraIcon, HistoryIcon, PaperclipIcon, XIcon } from "../../ui/icons";
import { enterKeyHint } from "../../../prompt/key-input";
import { enterSends } from "../../../prompt/enter-key";
import { compactComposer, registerAttachPicker } from "../../../prompt/compact-composer";
import { keepComposerFocus } from "./PromptActions";
import { AttachmentChip } from "./AttachmentChip";
import { AutocompletePopup } from "./AutocompletePopup";
import { PromptHistoryPicker } from "./PromptHistoryPicker";
import type { PromptAutocomplete } from "./usePromptAutocomplete";
import { PromptMirror } from "./PromptMirror";
import type { GhostText } from "./useGhostText";
import { magicKeywordSegments } from "../../../prompt/magic-keywords";
import { createPresence } from "../../../motion/presence";

/** Rows of the predictions list: the SDK offers at most four alternatives. */
const PREDICTION_LIST_ROWS = 4;

interface PromptComposerProps {
	message: () => string;
	setMessage: Setter<string>;
	onKeyDown: (e: KeyboardEvent) => void;
	setTextareaRef: (el: HTMLTextAreaElement) => void;
	/** Icon buttons rendered at the end of the textarea row (PromptActions). */
	actions?: JSX.Element;
	/**
	 * Text-only mode (agent steer box): no attachments, images, drops, paste
	 * folding, magic keywords, autocomplete, ghost text, or history, and no
	 * main-session draft restore/persist. The caller owns the draft. The
	 * attachment, autocomplete, ghost and history props below are then omitted.
	 */
	textOnly?: boolean;
	placeholder?: string;
	ariaLabel?: string;
	images?: () => ImageArg[];
	setImages?: Setter<ImageArg[]>;
	files?: () => TextAttachment[];
	setFiles?: Setter<TextAttachment[]>;
	ac?: PromptAutocomplete;
	ghost?: GhostText;
	/** Prompt history popover open state; PromptBox opens it on top-row Up. */
	historyOpen?: () => boolean;
	closeHistory?: () => void;
	/** Open the prompt history popover (the touch route; Up on the top row is the keyboard one). */
	openHistory?: () => void;
}

/**
 * P2 prompt composer (G03 + G18 chips). Owns paste handling (image clips,
 * large-paste fold with exact-payload submit, intentional file input/drop
 * with SDK/model validation), the promptInsert inbox effect, per-partition
 * draft persistence, and `^model` chip rendering.
 *
 * Folding is visual only: submit always uses the full text.
 */
export const PromptComposer: Component<PromptComposerProps> = (props) => {
	let textarea!: HTMLTextAreaElement;
	let fileInput!: HTMLInputElement;
	let cameraInput!: HTMLInputElement;
	// Stable id for the combobox/listbox wiring (aria-controls/activedescendant).
	const listId = `prompt-ac-${Math.random().toString(36).slice(2, 8)}`;
	const predictionsListId = `${listId}-predictions`;
	const historyPresence = createPresence(() => props.historyOpen?.() ?? false);
	const [folded, setFolded] = createSignal(true);
	const [pasteNote, setPasteNote] = createSignal<string | null>(null);
	const [pasteError, setPasteError] = createSignal<string | null>(null);
	const [chipError, setChipError] = createSignal<string | null>(null);
	// The attached session's draft slot; a fresh key object for the same slot is not a switch.
	const draftSlot = createMemo(() => currentDraftKey(), undefined, {
		equals: (a, b) => (a && b ? draftKey(a) === draftKey(b) : a === b),
	});
	const images = () => props.images?.() ?? [];
	const files = () => props.files?.() ?? [];
	const unsaved = createMemo(() => unsavedFileIds(files()));
	// Magic keyword highlight and ghost text share one mirror behind the textarea.
	let mirrorEl: HTMLDivElement | undefined;
	const segments = createMemo(() =>
		magicKeywordSegments(
			props.message(),
			(id) =>
				settingValue<boolean>("magicKeywords.enabled") !== false &&
				settingValue<boolean>(`magicKeywords.${id}`) !== false,
		),
	);
	const mirrored = () =>
		!props.textOnly &&
		((props.ghost?.text() ?? "") !== "" ||
			(props.ghost?.hint() ?? "") !== "" ||
			segments().some((seg) => seg.id !== undefined));
	const syncMirror = () => {
		if (mirrorEl) mirrorEl.scrollTop = textarea.scrollTop;
	};
	const onCaretMove = () => {
		props.ac?.refreshToken();
		props.ghost?.refreshCaret();
	};
	// A touch caret drag fires neither click nor keyup: selectionchange is the one signal
	// that follows every caret move, so the completion token and ghost caret read it too.
	const onSelectionChange = () => {
		if (document.activeElement === textarea) onCaretMove();
	};
	document.addEventListener("selectionchange", onSelectionChange);
	onCleanup(() => document.removeEventListener("selectionchange", onSelectionChange));
	// The inline height is measured, so a width change (rotation, split view, the dock
	// resizing) re-wraps the text and needs a re-measure without a keystroke.
	let observedWidth = 0;
	const resizeObserver =
		typeof ResizeObserver === "function"
			? new ResizeObserver((entries) => {
					const width = entries[0]?.contentRect.width ?? 0;
					if (width === observedWidth) return;
					observedWidth = width;
					props.ac?.autoGrow();
				})
			: undefined;
	onCleanup(() => resizeObserver?.disconnect());
	// The phone layout is one row: a crossing changes `rows`, so re-measure the height.
	createEffect(
		on(compactComposer, () => requestAnimationFrame(() => props.ac?.autoGrow()), { defer: true }),
	);
	// The header's Attach files item (phone layout) opens this picker.
	onMount(() => {
		if (!props.textOnly) onCleanup(registerAttachPicker(() => fileInput.click()));
	});
	// A tapped suggestion chip is the touch route to Tab / ArrowRight.
	const acceptGhost = () => {
		if (!props.ghost?.accept()) return;
		requestAnimationFrame(() => {
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
			props.ac?.autoGrow();
			persist(props.message(), images(), files());
		});
	};

	// QueueBar dequeue / PromptHistoryPicker picks / graph editorText land here.
	createEffect(() => {
		if (props.textOnly) return;
		const insert = promptInsert();
		if (!insert) return;
		setPromptInsert(null);
		const pristine = !props.message();
		if (insert.text)
			props.setMessage((prev) => (prev.trim() ? `${prev}\n${insert.text}` : insert.text));
		if (insert.images?.length) props.setImages?.((prev) => [...prev, ...insert.images!]);
		if (insert.files?.length) props.setFiles?.((prev) => [...prev, ...insert.files!]);
		requestAnimationFrame(() => {
			textarea.focus();
			// A history pick into an empty composer restores the saved caret.
			if (insert.selection && pristine)
				textarea.setSelectionRange(insert.selection.start, insert.selection.end);
			props.ac?.autoGrow();
			persist(props.message(), images(), files());
		});
	});

	// A started session (/new, New session button, new workspace) and a finished
	// session switch hand focus here; mayAutoFocusComposer keeps it from
	// stealing the keyboard from a dialog or opening a touch keyboard.
	createEffect(() => {
		if (props.textOnly || !promptFocusRequest()) return;
		setPromptFocusRequest(false);
		requestAnimationFrame(() => {
			if (mayAutoFocusComposer()) textarea.focus({ preventScroll: true });
		});
	});

	const draftBody = (text: string, imgs: ImageArg[], attached: TextAttachment[]): DraftBody => ({
		text,
		images: imgs,
		files: attached,
		selectionStart: textarea.selectionStart ?? undefined,
		selectionEnd: textarea.selectionEnd ?? undefined,
		updatedAt: Date.now(),
	});

	// Each session keeps its own draft: a switch stores the leaving session's
	// composer and shows the arriving one's; the first run restores the attached
	// session's draft on mount. Restoration never submits.
	createEffect(
		on(draftSlot, (next, prev) => {
			if (props.textOnly) return;
			const shown = swapDraft(prev, next, draftBody(props.message(), images(), files()));
			if (!shown) return;
			props.setMessage(shown.text);
			props.setImages?.(shown.images);
			props.setFiles?.(shown.files ?? []);
			setPasteNote(null);
			setPasteError(null);
			requestAnimationFrame(() => {
				if (shown.selectionStart !== undefined) {
					try {
						textarea.setSelectionRange(
							shown.selectionStart,
							shown.selectionEnd ?? shown.selectionStart,
						);
					} catch {
						// Detached textarea: ignore.
					}
				}
				props.ac?.autoGrow();
			});
		}),
	);

	onCleanup(() => {
		const key = draftSlot();
		if (!props.textOnly && key) cancelScheduledDraftSave(key);
	});

	const persist = (text: string, imgs: ImageArg[], attached: TextAttachment[]): void => {
		const key = draftSlot();
		// No slot while the session id is pending: the swap stores this content once it lands.
		if (props.textOnly || !key) return;
		scheduleDraftSave(key, draftBody(text, imgs, attached));
	};

	// Chips reach the model at send time and never enter the textarea. Every change is
	// saved with the draft so a reload keeps them.
	const addFiles = (next: TextAttachment[]): void => {
		props.setFiles?.(next);
		persist(props.message(), images(), next);
	};

	const addImages = (files: Array<{ data: string; mimeType: string }>, label: string): void => {
		const valid: ImageArg[] = [];
		for (const f of files) {
			const bytes = Math.floor((f.data.length * 3) / 4);
			const v = validateImage(f.mimeType, bytes, label);
			if (!v.ok) {
				setPasteError(v.reason ?? `${label} was rejected.`);
				continue;
			}
			valid.push({ type: "image", data: f.data, mimeType: f.mimeType });
		}
		if (valid.length > 0) props.setImages?.((prev) => [...prev, ...valid]);
	};

	/** Attach the first of `files` that reads or converts; they are encodings of one image. */
	const attachImage = async (files: File[], label: string): Promise<void> => {
		for (const file of files) {
			try {
				addImages([await readImagePayload(file)], label);
				return;
			} catch {
				// Undecodable encoding: try the next one.
			}
		}
		setPasteError(
			unsupportedImageReason(
				label,
				files.map((file) => file.type),
			),
		);
	};

	const onPaste = (e: ClipboardEvent): void => {
		setPasteError(null);
		const items = [...(e.clipboardData?.items ?? [])];
		const fileItems = items.filter((it) => it.kind === "file" && !it.type.startsWith("image/"));
		if (fileItems.length > 0) {
			// Pasted files attach as chips; the browser must not insert them as text.
			e.preventDefault();
			for (const item of fileItems) {
				const file = item.getAsFile();
				if (file) void importFile(file);
			}
			return;
		}
		const imageItems = items.filter((it) => it.type.startsWith("image/"));
		if (imageItems.length > 0) {
			e.preventDefault();
			const { attach, convert } = clipboardImageCandidates(imageItems);
			const asFiles = (list: DataTransferItem[]): File[] =>
				list.flatMap((item) => item.getAsFile() ?? []);
			for (const file of asFiles(attach)) void attachImage([file], "Pasted image");
			const alternates = asFiles(convert);
			if (alternates.length > 0) void attachImage(alternates, "Pasted image");
		}
		// Large text paste: keep the EXACT payload, fold visually.
		const text = e.clipboardData?.getData("text/plain") ?? "";
		if (text && shouldFoldPaste(text, pasteThreshold())) {
			// Let the paste land, then fold the view (payload untouched).
			setFolded(true);
			const { omittedLines, omittedChars } = foldedPreview(text);
			setPasteNote(
				`Large paste folded (${omittedLines} lines, ${omittedChars} chars hidden) — submit sends the full text; Raw shows all.`,
			);
		}
	};

	const importFile = async (f: File): Promise<void> => {
		if (f.type.startsWith("image/")) {
			await attachImage([f], `"${f.name}"`);
			return;
		}
		// Text files become chips and reach the model at send time; they never enter the textarea.
		const attachment = await importTextAttachment(f);
		addFiles([...files(), attachment]);
	};

	// Files dropped on the window land here. Deferred so a drop made while no
	// composer was mounted is not replayed when one mounts later.
	createEffect(
		on(
			droppedFiles,
			(dropped) => {
				if (props.textOnly || !dropped) return;
				setDroppedFiles(null);
				setPasteError(null);
				for (const f of dropped) void importFile(f);
			},
			{ defer: true },
		),
	);

	const onTextareaInput = (e: Event): void => {
		const el = e.currentTarget as HTMLTextAreaElement;
		props.setMessage(el.value);
		// Rewriting the value mid-composition drops or duplicates IME characters; compositionend runs it.
		if (!(e as InputEvent).isComposing) props.ac?.inlineEmoji(); // `:smile:` -> emoji before the draft is persisted
		props.ac?.setDismissed(false);
		props.ac?.setSelected(0);
		props.ac?.autoGrow();
		props.ac?.refreshToken();
		props.ghost?.refreshCaret();
		persist(el.value, images(), files());
		// Live `^selector` chip validation (offline mirror; submit expands).
		if (!props.textOnly && MODEL_MENTION_RE.test(el.value)) {
			MODEL_MENTION_RE.lastIndex = 0;
			void getModelMentions(graphGeneration()).catch((err) =>
				setChipError(String(err instanceof Error ? err.message : err)),
			);
		}
	};

	const onCompositionEnd = (e: CompositionEvent): void => {
		const el = e.currentTarget as HTMLTextAreaElement;
		if (!props.ac?.inlineEmoji()) return;
		props.ac.autoGrow();
		persist(el.value, images(), files());
	};

	// Focus leaving the textarea ends the completion: nothing else dismisses the popup on touch.
	// Popup rows keep focus here (mousedown preventDefault), so a pick never lands on this.
	const onTextareaBlur = (): void => {
		props.ac?.setDismissed(true);
		props.ac?.setToken(null);
		props.ghost?.alternatives.close();
	};

	const chooseFiles = (e: Event & { currentTarget: HTMLInputElement }): void => {
		setPasteError(null);
		for (const f of [...(e.currentTarget.files ?? [])]) void importFile(f);
		e.currentTarget.value = "";
	};

	const pasteThreshold = () =>
		settingValue<number>("paste.largeMenuThreshold") ?? PASTE_LARGE_MENU_DEFAULT;
	const showFold = () =>
		!props.textOnly && shouldFoldPaste(props.message(), pasteThreshold()) && folded();
	const preview = () => foldedPreview(props.message()).head;

	return (
		<>
			<Show when={!props.textOnly && fileDragDepth() > 0}>
				<div class="file-drop-overlay" aria-hidden="true">
					<span class="file-drop-label">Drop files to attach</span>
				</div>
			</Show>
			{images().length > 0 && (
				<div class="image-tray">
					<For each={images()}>
						{(img, i) => (
							<span class="image-thumb">
								<img src={`data:${img.mimeType};base64,${img.data}`} alt="" aria-hidden="true" />
								<button
									class="image-remove"
									aria-label="Remove image"
									onClick={() => props.setImages?.((prev) => prev.filter((_, j) => j !== i()))}
								>
									<XIcon />
								</button>
							</span>
						)}
					</For>
				</div>
			)}
			<Show when={files().length > 0}>
				<div class="attachment-tray" role="group" aria-label="Attached files">
					<For each={files()}>
						{(attachment) => (
							<AttachmentChip
								attachment={attachment}
								unsaved={unsaved().has(attachment.id)}
								onRemove={() => addFiles(files().filter((x) => x.id !== attachment.id))}
							/>
						)}
					</For>
				</div>
			</Show>
			<Show when={pasteNote()}>
				{(n) => (
					<div class="tool-collapsed-note" role="status">
						{n()}
						<Show when={showFold()}>
							<button type="button" class="queue-pop" onClick={() => setFolded(false)}>
								Raw
							</button>
						</Show>
						<Show when={!folded() && shouldFoldPaste(props.message(), pasteThreshold())}>
							<button type="button" class="queue-pop" onClick={() => setFolded(true)}>
								Fold
							</button>
						</Show>
					</div>
				)}
			</Show>
			<Show when={pasteError()}>
				{(e) => (
					<div class="prompt-error" role="alert">
						<span class="prompt-error-text">{e()}</span>
						<button
							type="button"
							class="prompt-error-dismiss"
							aria-label="Dismiss error"
							onClick={() => setPasteError(null)}
						>
							<XIcon />
						</button>
					</div>
				)}
			</Show>
			<div class="prompt-input">
				<Show when={props.ac?.open() ? props.ac : undefined}>
					{(ac) => (
						<AutocompletePopup
							items={ac().items()}
							selected={ac().selected()}
							maxVisible={ac().maxVisible()}
							onHover={ac().setSelected}
							onApply={ac().apply}
							listId={listId}
						/>
					)}
				</Show>
				<Show when={props.ghost?.alternatives.open() ? props.ghost.alternatives : undefined}>
					{(alternatives) => (
						<AutocompletePopup
							items={alternatives().items()}
							selected={alternatives().selected()}
							maxVisible={PREDICTION_LIST_ROWS}
							onHover={alternatives().setSelected}
							onApply={(item) => alternatives().choose(alternatives().items().indexOf(item))}
							listId={predictionsListId}
						/>
					)}
				</Show>
				<Show when={historyPresence.mounted()}>
					<PromptHistoryPicker
						phase={historyPresence.phase()}
						ref={historyPresence.ref}
						onClose={(restoreFocus) => {
							props.closeHistory?.();
							if (restoreFocus) textarea.focus();
						}}
					/>
				</Show>
				<Show when={showFold()}>
					<div
						class="prompt-fold"
						role="note"
						aria-label="Folded large paste (payload preserved)"
						title="Folded view — submit sends the full text"
					>
						<pre>{preview()}</pre>
						<button type="button" class="queue-pop" onClick={() => setFolded(false)}>
							Show raw ({props.message().length} chars)
						</button>
					</div>
				</Show>
				<div class="prompt-editor-row">
					<div class="prompt-field" classList={{ "prompt-field--mirrored": mirrored() }}>
						<Show when={mirrored()}>
							<PromptMirror
								segments={segments()}
								ghost={props.ghost?.text() ?? ""}
								hint={props.ghost?.hint() ?? ""}
								ref={(el) => {
									mirrorEl = el;
								}}
							/>
						</Show>
						<textarea
							data-focus-fallback
							disabled={isSwitching()}
							ref={(el) => {
								textarea = el;
								props.setTextareaRef(el);
								resizeObserver?.observe(el);
							}}
							role={props.textOnly ? undefined : "combobox"}
							aria-label={props.ariaLabel ?? "Message the agent"}
							aria-expanded={props.ac?.open() || props.ghost?.alternatives.open()}
							aria-controls={
								props.ac?.open()
									? listId
									: props.ghost?.alternatives.open()
										? predictionsListId
										: undefined
							}
							aria-activedescendant={
								props.ac?.open()
									? `${listId}-opt-${props.ac.selected()}`
									: props.ghost?.alternatives.open()
										? `${predictionsListId}-opt-${props.ghost.alternatives.selected()}`
										: undefined
							}
							aria-autocomplete={props.textOnly ? undefined : "list"}
							value={props.message()}
							enterkeyhint={enterKeyHint(enterSends())}
							autocapitalize="sentences"
							autocomplete="off"
							spellcheck={false}
							onInput={onTextareaInput}
							onCompositionEnd={onCompositionEnd}
							onBlur={onTextareaBlur}
							onKeyDown={(e) => props.onKeyDown(e)}
							onKeyUp={onCaretMove}
							onClick={onCaretMove}
							onScroll={syncMirror}
							onPaste={(e) => {
								if (!props.textOnly) onPaste(e);
							}}
							// A shown prediction replaces the placeholder, as in the TUI.
							placeholder={
								props.message() === "" && (props.ghost?.text() ?? "") !== ""
									? ""
									: (props.placeholder ?? (compactComposer() ? "Message" : "Message the Agent"))
							}
							rows={props.textOnly ? 2 : compactComposer() ? 1 : 3}
						/>
						<Show when={!props.textOnly && (props.ghost?.text() ?? "") !== ""}>
							<button
								type="button"
								class="prompt-ghost-accept prompt-touch-only"
								aria-label="Accept suggestion"
								onMouseDown={keepComposerFocus}
								onClick={acceptGhost}
							>
								<ArrowRightIcon />
								<span class="prompt-ghost-accept-text">{props.ghost?.text()}</span>
							</button>
						</Show>
						<Show when={!props.textOnly && (props.ghost?.hint() ?? "") !== ""}>
							<button
								type="button"
								class="prompt-ghost-accept prompt-touch-only"
								aria-label="Show the other predictions"
								onMouseDown={keepComposerFocus}
								onClick={() => props.ghost?.openAlternatives()}
							>
								<span class="prompt-ghost-accept-text">{props.ghost?.hint()}</span>
							</button>
						</Show>
					</div>
					<Show when={!props.textOnly}>
						<input
							ref={fileInput}
							type="file"
							accept={ATTACH_ACCEPT}
							multiple
							hidden
							aria-hidden="true"
							tabIndex={-1}
							onChange={chooseFiles}
						/>
						<input
							ref={cameraInput}
							type="file"
							accept="image/*"
							capture="environment"
							hidden
							aria-hidden="true"
							tabIndex={-1}
							onChange={chooseFiles}
						/>
						<button
							type="button"
							class="prompt-attach"
							title="Attach files (images + text, validated)"
							aria-label="Attach files"
							onMouseDown={keepComposerFocus}
							onClick={() => fileInput.click()}
						>
							<PaperclipIcon />
						</button>
						<button
							type="button"
							class="prompt-attach prompt-touch-only"
							title="Take a photo"
							aria-label="Take a photo"
							onMouseDown={keepComposerFocus}
							onClick={() => cameraInput.click()}
						>
							<CameraIcon />
						</button>
						<button
							type="button"
							class="prompt-attach prompt-touch-only"
							data-history-toggle
							title="Prompt history"
							aria-label="Prompt history"
							aria-expanded={props.historyOpen?.() ?? false}
							onMouseDown={keepComposerFocus}
							onClick={() =>
								props.historyOpen?.() ? props.closeHistory?.() : props.openHistory?.()
							}
						>
							<HistoryIcon />
						</button>
					</Show>
					{props.actions}
				</div>
			</div>
		</>
	);
};

/** Submit-time chip expansion shared by PromptBox: `^selector` → journal
 *  pseudonyms before dispatch. Unknown selectors stay literal. */
export async function expandChipsForSubmit(text: string): Promise<string> {
	if (!text.includes("^")) return text;
	try {
		const out = await expandMentionChips(text);
		return out.text;
	} catch {
		return text;
	}
}
