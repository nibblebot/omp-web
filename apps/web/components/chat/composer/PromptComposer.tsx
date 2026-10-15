import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
	type Setter,
} from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import {
	promptFocusRequest,
	promptInsert,
	setPromptFocusRequest,
	setPromptInsert,
} from "../../../state";
import {
	cancelScheduledDraftSave,
	currentDraftKey,
	loadDraft,
	peekClearedDraft,
	recoverClearedDraft,
	scheduleDraftSave,
} from "../../../store/drafts";
import { expandMentionChips, getModelMentions, MODEL_MENTION_RE } from "../../../store/models";
import { graphGeneration } from "../../../store/graph";
import {
	foldedPreview,
	PASTE_LARGE_MENU_DEFAULT,
	readFileAsDataUrl,
	readFileAsText,
	shouldFoldPaste,
	validateImage,
	validateImportFile,
} from "../../../prompt/paste";
import { settingValue } from "../../../store/settings";
import { PaperclipIcon, XIcon } from "../../ui/icons";
import { AutocompletePopup } from "./AutocompletePopup";
import { PromptHistoryPicker } from "./PromptHistoryPicker";
import type { PromptAutocomplete } from "./usePromptAutocomplete";
import { PromptMirror } from "./PromptMirror";
import type { GhostText } from "./useGhostText";
import { magicKeywordSegments } from "../../../prompt/magic-keywords";

interface PromptComposerProps {
	message: () => string;
	setMessage: Setter<string>;
	images: () => ImageArg[];
	setImages: Setter<ImageArg[]>;
	ac: PromptAutocomplete;
	ghost: GhostText;
	onKeyDown: (e: KeyboardEvent) => void;
	setTextareaRef: (el: HTMLTextAreaElement) => void;
	/** Prompt history popover open state; PromptBox opens it on first-line Up. */
	historyOpen: () => boolean;
	closeHistory: () => void;
}

/**
 * P2 prompt composer (G03 + G18 chips). Owns paste handling (image clips,
 * large-paste fold with exact-payload submit, intentional file input/drop
 * with SDK/model validation), the promptInsert inbox effect, per-partition
 * draft persistence, cleared-draft recovery, and `^model` chip rendering.
 *
 * Folding is visual only: submit always uses the full text.
 */
export const PromptComposer: Component<PromptComposerProps> = (props) => {
	let textarea!: HTMLTextAreaElement;
	let fileInput!: HTMLInputElement;
	// Stable id for the combobox/listbox wiring (aria-controls/activedescendant).
	const listId = `prompt-ac-${Math.random().toString(36).slice(2, 8)}`;
	const [folded, setFolded] = createSignal(true);
	const [pasteNote, setPasteNote] = createSignal<string | null>(null);
	const [pasteError, setPasteError] = createSignal<string | null>(null);
	const [recovery, setRecovery] = createSignal<{ text: string; images: number } | null>(null);
	const [chipError, setChipError] = createSignal<string | null>(null);
	const draftKey = () => currentDraftKey();
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
		props.ghost.text() !== "" || segments().some((seg) => seg.id !== undefined);
	const syncMirror = () => {
		if (mirrorEl) mirrorEl.scrollTop = textarea.scrollTop;
	};
	const onCaretMove = () => {
		props.ac.refreshToken();
		props.ghost.refreshCaret();
	};

	// QueueBar dequeue / PromptHistoryPicker picks / graph editorText land here.
	createEffect(() => {
		const insert = promptInsert();
		if (!insert) return;
		setPromptInsert(null);
		if (insert.text)
			props.setMessage((prev) => (prev.trim() ? `${prev}\n${insert.text}` : insert.text));
		if (insert.images?.length) props.setImages((prev) => [...prev, ...insert.images!]);
		requestAnimationFrame(() => {
			textarea.focus();
			props.ac.autoGrow();
		});
	});

	// A started session (/new, New session button, picker gate) hands focus here.
	createEffect(() => {
		if (!promptFocusRequest()) return;
		setPromptFocusRequest(false);
		requestAnimationFrame(() => textarea.focus());
	});

	// Restore the partition draft on mount (prior text/image draft restore);
	// restoration never submits.
	onMount(() => {
		const saved = loadDraft(draftKey());
		if (saved && (saved.text || saved.images.length > 0)) {
			props.setMessage(saved.text);
			if (saved.images.length > 0) props.setImages(saved.images);
			if (saved.selectionStart !== undefined) {
				requestAnimationFrame(() => {
					try {
						textarea.setSelectionRange(
							saved.selectionStart ?? 0,
							saved.selectionEnd ?? saved.selectionStart ?? 0,
						);
					} catch {
						// Detached textarea: ignore.
					}
				});
			}
		}
		const cleared = peekClearedDraft(draftKey());
		if (cleared && (cleared.text.trim() || cleared.images.length > 0)) {
			setRecovery({ text: cleared.text.slice(0, 120), images: cleared.images.length });
		}
	});

	onCleanup(() => {
		cancelScheduledDraftSave(draftKey());
	});

	const persist = (text: string, imgs: ImageArg[]): void => {
		scheduleDraftSave(draftKey(), {
			text,
			images: imgs,
			selectionStart: textarea.selectionStart ?? undefined,
			selectionEnd: textarea.selectionEnd ?? undefined,
			updatedAt: Date.now(),
		});
	};

	const addImages = (files: Array<{ data: string; mimeType: string }>): void => {
		const valid: ImageArg[] = [];
		for (const f of files) {
			const bytes = Math.floor((f.data.length * 3) / 4);
			const v = validateImage(f.mimeType, bytes);
			if (!v.ok) {
				setPasteError(v.reason ?? "Image rejected.");
				continue;
			}
			valid.push({ type: "image", data: f.data, mimeType: f.mimeType });
		}
		if (valid.length > 0) props.setImages((prev) => [...prev, ...valid]);
	};

	const onPaste = (e: ClipboardEvent): void => {
		setPasteError(null);
		const items = [...(e.clipboardData?.items ?? [])];
		const imageItems = items.filter((it) => it.type.startsWith("image/"));
		if (imageItems.length > 0) {
			e.preventDefault();
			for (const item of imageItems) {
				const file = item.getAsFile();
				if (!file) continue;
				const { promise, resolve } = Promise.withResolvers<string>();
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.readAsDataURL(file);
				void promise.then((dataUrl) => {
					const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
					addImages([{ data, mimeType: item.type }]);
				});
			}
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

	const onDrop = (e: DragEvent): void => {
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		// Intentional drop only: files (not stray text) land as attachments.
		e.preventDefault();
		for (const f of files) void importFile(f);
	};

	const importFile = async (f: File): Promise<void> => {
		if (f.type.startsWith("image/")) {
			const url = await readFileAsDataUrl(f);
			addImages([{ data: url.slice(url.indexOf(",") + 1), mimeType: f.type }]);
			return;
		}
		const v = validateImportFile(f.name, f.type, f.size);
		if (!v.ok) {
			setPasteError(v.reason ?? "File rejected.");
			return;
		}
		const text = await readFileAsText(f);
		props.setMessage((prev) => (prev.trim() ? `${prev}\n${text}` : text));
		setPasteNote(`Imported "${f.name}" as text — attachments preserved separately.`);
		requestAnimationFrame(() => props.ac.autoGrow());
	};

	const recoverDraft = (): void => {
		const top = recoverClearedDraft(draftKey());
		if (top) {
			setRecovery(null);
			requestAnimationFrame(() => {
				textarea.focus();
				props.ac.autoGrow();
			});
		}
	};

	const onTextareaInput = (e: Event): void => {
		const el = e.currentTarget as HTMLTextAreaElement;
		props.setMessage(el.value);
		props.ac.inlineEmoji(); // `:smile:` -> emoji before the draft is persisted
		props.ac.setDismissed(false);
		props.ac.setSelected(0);
		props.ac.autoGrow();
		props.ac.refreshToken();
		props.ghost.refreshCaret();
		persist(el.value, props.images());
		// Live `^selector` chip validation (offline mirror; submit expands).
		if (MODEL_MENTION_RE.test(el.value)) {
			MODEL_MENTION_RE.lastIndex = 0;
			void getModelMentions(graphGeneration()).catch((err) =>
				setChipError(String(err instanceof Error ? err.message : err)),
			);
		}
	};

	const pasteThreshold = () =>
		settingValue<number>("paste.largeMenuThreshold") ?? PASTE_LARGE_MENU_DEFAULT;
	const showFold = () => shouldFoldPaste(props.message(), pasteThreshold()) && folded();
	const preview = () => foldedPreview(props.message()).head;

	return (
		<>
			{props.images().length > 0 && (
				<div class="image-tray">
					<For each={props.images()}>
						{(img, i) => (
							<span class="image-thumb">
								<img src={`data:${img.mimeType};base64,${img.data}`} alt="" aria-hidden="true" />
								<button
									class="image-remove"
									aria-label="Remove image"
									onClick={() => props.setImages((prev) => prev.filter((_, j) => j !== i()))}
								>
									<XIcon />
								</button>
							</span>
						)}
					</For>
				</div>
			)}
			<Show when={recovery()}>
				{(r) => (
					<div class="queue-bar" role="status">
						<span class="queue-text">
							Cleared draft available ({r().text || "(images only)"}
							{r().images > 0 ? `, ${r().images} image${r().images === 1 ? "" : "s"}` : ""})
						</span>
						<button type="button" class="queue-pop" onClick={recoverDraft}>
							Recover
						</button>
					</div>
				)}
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
					<div class="msg-notice" role="alert">
						{e()}
					</div>
				)}
			</Show>
			<Show when={chipError()}>{(e) => <div class="tool-collapsed-note">{e()}</div>}</Show>
			<div class="prompt-input">
				{props.ac.open() && (
					<AutocompletePopup
						items={props.ac.items()}
						selected={props.ac.selected()}
						maxVisible={props.ac.maxVisible()}
						onHover={props.ac.setSelected}
						onApply={props.ac.apply}
						listId={listId}
					/>
				)}
				<Show when={props.historyOpen()}>
					<PromptHistoryPicker
						onClose={(restoreFocus) => {
							props.closeHistory();
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
								ghost={props.ghost.text()}
								ref={(el) => {
									mirrorEl = el;
								}}
							/>
						</Show>
						<textarea
							ref={(el) => {
								textarea = el;
								props.setTextareaRef(el);
							}}
							role="combobox"
							aria-label="Message the agent"
							aria-expanded={props.ac.open()}
							aria-controls={props.ac.open() ? listId : undefined}
							aria-activedescendant={
								props.ac.open() ? `${listId}-opt-${props.ac.selected()}` : undefined
							}
							aria-autocomplete="list"
							value={props.message()}
							onInput={onTextareaInput}
							onKeyDown={(e) => props.onKeyDown(e)}
							onKeyUp={onCaretMove}
							onClick={onCaretMove}
							onScroll={syncMirror}
							onPaste={onPaste}
							onDrop={onDrop}
							placeholder="Message the agent… (Enter send, Ctrl+Enter follow-up, / for commands)"
							rows={3}
						/>
					</div>
					<input
						ref={fileInput}
						type="file"
						accept="image/*,.txt,.md,.json,.jsonl,.log,.diff,.patch"
						multiple
						hidden
						aria-hidden="true"
						tabIndex={-1}
						onChange={(e) => {
							for (const f of [...(e.currentTarget.files ?? [])]) void importFile(f);
							e.currentTarget.value = "";
						}}
					/>
					<button
						type="button"
						class="prompt-attach"
						title="Attach files (images + text, validated)"
						aria-label="Attach files"
						onClick={() => fileInput.click()}
					>
						<PaperclipIcon />
					</button>
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
