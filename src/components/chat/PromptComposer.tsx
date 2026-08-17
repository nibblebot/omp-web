import { createEffect, createUniqueId, For, type Component, type Setter } from "solid-js";
import type { ImageArg } from "../../../shared/protocol";
import { promptInsert, setPromptInsert } from "../../state";
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
 * The prompt textarea plus its image tray and the autocomplete popup. Owns
 * paste handling and the promptInsert inbox effect (QueueBar dequeue /
 * HistoryModal picks land here); keyboard handling stays in PromptBox.
 */
export const PromptComposer: Component<PromptComposerProps> = (props) => {
	let textarea!: HTMLTextAreaElement;
	// Stable id for the combobox/listbox wiring (aria-controls/activedescendant).
	const listId = createUniqueId();

	// QueueBar dequeue / HistoryModal picks land here.
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

	const onPaste = (e: ClipboardEvent) => {
		const pasted = [...(e.clipboardData?.items ?? [])].filter((it) => it.type.startsWith("image/"));
		if (pasted.length === 0) return; // non-image paste: default behavior
		e.preventDefault();
		for (const item of pasted) {
			const file = item.getAsFile();
			if (!file) continue;
			const { promise, resolve } = Promise.withResolvers<string>();
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsDataURL(file);
			void promise.then((dataUrl) => {
				const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
				props.setImages((prev) => [...prev, { type: "image", data, mimeType: item.type }]);
			});
		}
	};

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
					onInput={(e) => {
						props.setMessage(e.currentTarget.value);
						props.ac.setDismissed(false);
						props.ac.setSelected(0);
						props.ac.autoGrow();
						props.ac.refreshToken();
					}}
					onKeyDown={props.onKeyDown}
					onKeyUp={props.ac.refreshToken}
					onClick={props.ac.refreshToken}
					onPaste={onPaste}
					placeholder="Message the agent… (Enter send, Ctrl+Enter follow-up, / for commands)"
					rows={3}
				/>
			</div>
		</>
	);
};
