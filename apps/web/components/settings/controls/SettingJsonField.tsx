import { createEffect, createSignal, Show, type Component } from "solid-js";
import { parseJsonDraft } from "../../../prefs/setting-controls";

/**
 * Lists and records edited as JSON. The row shows a count and an "Edit…"
 * button; the editor opens inline below it with Save and Cancel. Opening
 * moves focus into the textarea; while open, Escape cancels (the wrapper
 * listener stops it, and the marked wrapper keeps Modal from closing the
 * sheet); Ctrl/Cmd+Enter saves; Cancel and Save return focus to "Edit…".
 */
export const SettingJsonField: Component<{
	label: string;
	type: "list" | "record";
	value: unknown;
	disabled?: boolean;
	onCommit: (value: unknown) => void;
}> = (props) => {
	const [editing, setEditing] = createSignal(false);
	const [draft, setDraft] = createSignal("");
	const [error, setError] = createSignal("");
	let editButton: HTMLButtonElement | undefined;
	let textarea: HTMLTextAreaElement | undefined;

	// Runs after the editor is mounted, so focus lands in the attached textarea.
	createEffect(() => {
		if (editing()) textarea?.focus();
	});

	const count = () => {
		const v = props.value;
		if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? "item" : "items"}`;
		if (v && typeof v === "object") {
			const n = Object.keys(v).length;
			return `${n} ${n === 1 ? "entry" : "entries"}`;
		}
		return "None";
	};

	const open = () => {
		setDraft(JSON.stringify(props.value ?? (props.type === "list" ? [] : {}), null, 2));
		setError("");
		setEditing(true);
	};
	const close = () => {
		setEditing(false);
		editButton?.focus();
	};
	const save = () => {
		const parsed = parseJsonDraft(draft(), props.type);
		if (!parsed.ok) {
			setError(parsed.error);
			return;
		}
		props.onCommit(parsed.value);
		close();
	};

	return (
		<span
			class="settings-json-field"
			data-inline-escape={editing() ? "" : undefined}
			ref={(el) =>
				el.addEventListener("keydown", (e) => {
					if (e.key === "Escape" && editing()) {
						e.stopPropagation();
						close();
					} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && editing()) {
						e.preventDefault();
						save();
					}
				})
			}
		>
			<span class="settings-json-summary">{count()}</span>
			<button
				type="button"
				class="settings-control-btn"
				aria-label={`Edit ${props.label}`}
				aria-expanded={editing()}
				disabled={props.disabled}
				ref={(el) => (editButton = el)}
				onClick={() => (editing() ? close() : open())}
			>
				Edit…
			</button>
			<Show when={editing()}>
				<span class="settings-json-editor">
					<textarea
						class="settings-json-input"
						aria-label={`${props.label} JSON`}
						spellcheck={false}
						value={draft()}
						ref={(el) => (textarea = el)}
						onInput={(e) => setDraft(e.currentTarget.value)}
					/>
					<Show when={error()}>
						<span class="settings-json-error" role="alert">
							{error()}
						</span>
					</Show>
					<span class="settings-json-actions">
						<button type="button" class="settings-control-btn" onClick={save}>
							Save
						</button>
						<button type="button" class="settings-control-btn" onClick={close}>
							Cancel
						</button>
					</span>
				</span>
			</Show>
		</span>
	);
};
