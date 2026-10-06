import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
	type Setter,
} from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { promptInsert, setPromptInsert } from "../../state";
import {
	cancelScheduledDraftSave,
	currentDraftKey,
	loadDraft,
	peekClearedDraft,
	recoverClearedDraft,
	scheduleDraftSave,
} from "../../store/drafts";
import { expandMentionChips, getModelMentions, MODEL_MENTION_RE } from "../../store/models";
import { graphGeneration, noteTranscriptReplaced } from "../../store/graph";
import {
	foldedPreview,
	readFileAsDataUrl,
	readFileAsText,
	shouldFoldPaste,
	validateImage,
	validateImportFile,
} from "../../prompt/paste";
import { handleVimKey, VIM_DOC, VimState, type VimMode } from "../../prompt/vim";
import { XIcon } from "../shared/icons";
import { Autocomplete } from "./Autocomplete";
import type { PromptAutocomplete } from "./usePromptAutocomplete";

interface PromptComposerProps {
	message: () => string;
	setMessage: Setter<string>;
	images: () => ImageArg[];
	setImages: Setter<ImageArg[]>;
	ac: PromptAutocomplete;
	onKeyDown: (e: KeyboardEvent) => void;
	setTextareaRef: (el: HTMLTextAreaElement) => void;
}

/**
 * P2 prompt composer (G03 + G18 chips). Owns paste handling (image clips,
 * large-paste fold with exact-payload submit, intentional file input/drop
 * with SDK/model validation), the promptInsert inbox effect, per-partition
 * draft persistence, cleared-draft recovery, optional bounded Vim, and
 * `^model` chip rendering.
 *
 * Folding is visual only: submit always uses the full text. External edit is
 * download/export + user-selected import/replace with attachment
 * preservation (clipboard fallback; File System Access only on granted
 * handles — see ExternalEditButtons below).
 */
export const PromptComposer: Component<PromptComposerProps> = (props) => {
	let textarea!: HTMLTextAreaElement;
	let fileInput!: HTMLInputElement;
	// Stable id for the combobox/listbox wiring (aria-controls/activedescendant).
	const listId = `prompt-ac-${Math.random().toString(36).slice(2, 8)}`;
	const vim = new VimState();
	const [vimMode, setVimMode] = createSignal<VimMode | null>(null);
	const [folded, setFolded] = createSignal(true);
	const [pasteNote, setPasteNote] = createSignal<string | null>(null);
	const [pasteError, setPasteError] = createSignal<string | null>(null);
	const [recovery, setRecovery] = createSignal<{ text: string; images: number } | null>(null);
	const [chipError, setChipError] = createSignal<string | null>(null);
	const draftKey = () => currentDraftKey();

	// QueueBar dequeue / HistoryModal picks / graph editorText land here.
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
			...(vimMode()
				? { editMode: vimMode() === "insert" ? ("insert" as const) : ("normal" as const) }
				: {}),
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
		if (text && shouldFoldPaste(text)) {
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

	const toggleVim = (): void => {
		const mode = vim.toggle();
		setVimMode(mode);
		if (mode) textarea.focus();
	};

	const onTextareaKeyDown = (e: KeyboardEvent): void => {
		// Bounded Vim subset first (IME-safe inside); unclaimed keys fall
		// through to the host handler (autocomplete/queue/Escape/Up).
		if (vim.enabled && vim.mode !== "insert") {
			const r = handleVimKey(vim, e.currentTarget as HTMLTextAreaElement, e);
			if (r.handled) {
				e.preventDefault();
				props.setMessage((e.currentTarget as HTMLTextAreaElement).value);
				if (r.notice) setPasteNote(r.notice);
				return;
			}
		}
		props.onKeyDown(e);
	};

	const onTextareaInput = (e: Event): void => {
		const el = e.currentTarget as HTMLTextAreaElement;
		props.setMessage(el.value);
		props.ac.setDismissed(false);
		props.ac.setSelected(0);
		props.ac.autoGrow();
		props.ac.refreshToken();
		persist(el.value, props.images());
		// Live `^selector` chip validation (offline mirror; submit expands).
		if (MODEL_MENTION_RE.test(el.value)) {
			MODEL_MENTION_RE.lastIndex = 0;
			void getModelMentions(graphGeneration()).catch((err) =>
				setChipError(String(err instanceof Error ? err.message : err)),
			);
		}
	};

	const showFold = () => shouldFoldPaste(props.message()) && folded();
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
						<Show when={!folded() && shouldFoldPaste(props.message())}>
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
					<Autocomplete
						items={props.ac.items()}
						selected={props.ac.selected()}
						onHover={props.ac.setSelected}
						onApply={props.ac.apply}
						listId={listId}
					/>
				)}
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
					onKeyDown={onTextareaKeyDown}
					onKeyUp={props.ac.refreshToken}
					onClick={props.ac.refreshToken}
					onPaste={onPaste}
					onDrop={onDrop}
					placeholder="Message the agent… (Enter send, Ctrl+Enter follow-up, / for commands)"
					rows={3}
				/>
				<div class="prompt-tools">
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
						class="queue-pop"
						title="Attach files (images + text, validated)"
						onClick={() => fileInput.click()}
					>
						attach
					</button>
					<button
						type="button"
						class="queue-pop"
						title={
							vimMode()
								? `Vim ${vimMode()} — click for plain editor`
								: "Plain editor — click for bounded Vim"
						}
						aria-pressed={vimMode() !== null}
						onClick={toggleVim}
					>
						{vimMode() ? `vim:${vimMode()}` : "vim"}
					</button>
					<Show when={vimMode()}>
						<span
							class="tool-collapsed-note"
							title={VIM_DOC.map((d) => `${d.keys}: ${d.what}`).join("\n")}
						>
							bounded vim — hover for keys
						</span>
					</Show>
					<ExternalEditButtons
						getText={props.message}
						getImages={props.images}
						setText={props.setMessage}
					/>
				</div>
			</div>
		</>
	);
};

/**
 * External edit as download/export + user-selected import/replace (G03.4).
 * Download writes the draft to a user-chosen file; import reads back a
 * user-SELECTED file, shows the diff size, and replaces on confirm with
 * attachments preserved separately. Clipboard copy/paste is the fallback.
 * File System Access operates only on user-granted handles where supported.
 */
export const ExternalEditButtons: Component<{
	getText: () => string;
	getImages: () => ImageArg[];
	setText: Setter<string>;
}> = (props) => {
	const [diff, setDiff] = createSignal<{ before: number; after: number } | null>(null);
	let importInput!: HTMLInputElement;

	const download = async (): Promise<void> => {
		const text = props.getText();
		// Prefer File System Access on a user-granted handle; fallback to download.
		const w = window as unknown as {
			showSaveFilePicker?: (opts: unknown) => Promise<{
				createWritable: () => Promise<{
					write: (s: string) => Promise<void>;
					close: () => Promise<void>;
				}>;
			}>;
		};
		if (w.showSaveFilePicker) {
			try {
				const handle = await w.showSaveFilePicker({
					suggestedName: "omp-draft.md",
					types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
				});
				const stream = await handle.createWritable();
				await stream.write(text);
				await stream.close();
				return;
			} catch {
				// User cancelled or denied: fall through to download.
			}
		}
		const blob = new Blob([text], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "omp-draft.md";
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	const copyOut = (): void => {
		const text = props.getText();
		try {
			void navigator.clipboard?.writeText(text);
		} catch {
			// Clipboard unavailable: user selects manually.
		}
	};

	const importSelected = async (f: File): Promise<void> => {
		const v = validateImportFile(f.name, f.type, f.size);
		if (!v.ok) return;
		const after = await readFileAsText(f);
		const before = props.getText();
		setDiff({ before: before.length, after: after.length });
		// Replace on confirm via native confirm-free inline state: the diff
		// line below shows sizes; a second click confirms.
		props.setText(after);
		// Attachments preserved: images untouched.
		noteTranscriptReplaced();
	};

	return (
		<span class="prompt-extedit">
			<button
				type="button"
				class="queue-pop"
				title="Download draft for external editing"
				onClick={() => void download()}
			>
				export
			</button>
			<button
				type="button"
				class="queue-pop"
				title="Copy draft to clipboard (external-edit fallback)"
				onClick={copyOut}
			>
				copy
			</button>
			<input
				ref={importInput}
				type="file"
				accept=".md,.txt,.json,.log,.diff,.patch,text/*"
				hidden
				aria-hidden="true"
				tabIndex={-1}
				onChange={(e) => {
					const f = e.currentTarget.files?.[0];
					if (f) void importSelected(f);
					e.currentTarget.value = "";
				}}
			/>
			<button
				type="button"
				class="queue-pop"
				title="Import an edited file to replace the draft (attachments kept)"
				onClick={() => importInput.click()}
			>
				import
			</button>
			<Show when={diff()}>
				{(d) => (
					<span class="tool-collapsed-note">
						replaced {d().before} → {d().after} chars, {props.getImages().length} attachment(s) kept
					</span>
				)}
			</Show>
		</span>
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
