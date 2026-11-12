import { createSignal, For, onCleanup, onMount, Show, type Component, type JSX } from "solid-js";
import { cancelUiRequest, sendUiResponse } from "../../state";
import {
	buildSubmit,
	clearOther,
	initialFormState,
	inputType,
	isImageDataUri,
	isOptionChosen,
	isOtherActive,
	setChecked,
	setNote,
	setOther,
	spansText,
	toggleOption,
	validateForm,
	type ChoiceState,
	type FormState,
	type TextState,
} from "../../prompt/ask-form";
import { isImeKey } from "../../prompt/key-input";
import {
	formFields,
	UI_FORM_NOTE_MAX_LENGTH,
	type UiFormBlock,
	type UiFormChoiceField,
	type UiFormField,
	type UiFormParams,
	type UiFormSpan,
	type UiFormTextField,
} from "#lib/wire/ask-form";
import { PencilIcon } from "../ui/icons";

/** Longest textarea the form draws (rows); a taller `rows` scrolls. */
const MAX_TEXTAREA_ROWS = 12;

/** What every field of one form shares: the request id, working state and per-field errors. */
interface FormContext {
	id: string;
	state: () => FormState;
	errors: () => Record<number, string>;
	update: (field: UiFormField, next: ChoiceState | TextState) => void;
}

/** Inline text with the form's emphasis; hard line breaks show through `pre-line`. */
const Spans: Component<{ spans: UiFormSpan[] }> = (props) => (
	<For each={props.spans}>
		{(span) => {
			switch (span.style) {
				case "code":
					return <code>{span.text}</code>;
				case "strong":
					return <strong>{span.text}</strong>;
				case "em":
					return <em>{span.text}</em>;
				default:
					return span.text;
			}
		}}
	</For>
);

/** Label of a field's control: its own label, else nothing (the surrounding text is its question). */
const FieldLabel: Component<{ field: UiFormField }> = (props) => (
	<Show when={spansText(props.field.label).trim() !== ""}>
		<span class="ask-form-label">
			<Spans spans={props.field.label} />
			<Show when={props.field.required}>
				<span class="ask-form-required" aria-hidden="true">
					*
				</span>
			</Show>
		</span>
	</Show>
);

/** An option's label; an empty one shows its value. */
const optionLabel = (spans: UiFormSpan[], value: string): string =>
	spansText(spans).trim() || value;

/**
 * One option's note, kept the way the SDK's TUI dialog keeps them: a Note button on a
 * chosen option of a named field opens a text box under the option row, and the note
 * goes with the answer while the option stays chosen. A note left on an option that is
 * no longer chosen stays visible as a draft and is not sent. Esc in the box returns to
 * the button without cancelling the form; an empty box closes. `standalone` rows (under
 * a select) exist only while there is a note to offer; option rows always draw their
 * `children`.
 */
const OptionNote: Component<{
	ctx: FormContext;
	field: UiFormChoiceField;
	option: number;
	label: string;
	standalone?: boolean;
	children: JSX.Element;
}> = (props) => {
	const choice = () => props.ctx.state()[props.field.index] as ChoiceState;
	const text = () => choice().notes[props.option] ?? "";
	const chosen = () => isOptionChosen(props.field, choice(), props.option);
	const offered = () => props.field.name !== "" && (chosen() || text() !== "");
	const [open, setOpen] = createSignal(false);
	const editing = () => offered() && (open() || text() !== "");
	const editorId = `ask-form-${props.ctx.id}-${props.field.index}-note-${props.option}`;
	let toggle: HTMLButtonElement | undefined;
	let editor: HTMLTextAreaElement | undefined;
	return (
		<Show when={!props.standalone || offered()}>
			<div class="ask-form-option-row">
				{props.children}
				<Show when={offered()}>
					<button
						ref={toggle}
						type="button"
						class="ask-form-note-toggle"
						classList={{ noted: text().trim() !== "" }}
						aria-label={`${text() === "" ? "Add" : "Edit"} note on ${props.label}`}
						aria-expanded={editing()}
						aria-controls={editorId}
						onClick={() => {
							if (editing() && text() === "") {
								setOpen(false);
								return;
							}
							setOpen(true);
							editor?.focus();
						}}
					>
						<PencilIcon />
						Note
					</button>
				</Show>
			</div>
			<Show when={editing()}>
				<div class="ask-form-note">
					<textarea
						ref={editor}
						id={editorId}
						class="ask-form-input ask-form-note-input"
						aria-label={`Note on ${props.label}`}
						aria-describedby={chosen() ? undefined : `${editorId}-draft`}
						placeholder="A note for the agent on this choice"
						maxLength={UI_FORM_NOTE_MAX_LENGTH}
						rows={2}
						value={text()}
						onInput={(e) =>
							props.ctx.update(props.field, setNote(choice(), props.option, e.currentTarget.value))
						}
						onKeyDown={(e) => {
							if (e.key !== "Escape" || isImeKey(e)) return;
							// Esc leaves the note, never the whole form.
							e.preventDefault();
							e.stopPropagation();
							setOpen(false);
							toggle?.focus();
						}}
					/>
					<Show when={!chosen()}>
						<span id={`${editorId}-draft`} class="ask-form-note-draft">
							Draft: sent only if this option is chosen
						</span>
					</Show>
				</div>
			</Show>
		</Show>
	);
};

const ChoiceControls: Component<{ ctx: FormContext; field: UiFormChoiceField }> = (props) => {
	const choice = () => props.ctx.state()[props.field.index] as ChoiceState;
	const name = () => `ask-form-${props.ctx.id}-${props.field.index}`;
	let otherInput!: HTMLInputElement;
	return (
		<Show
			when={!props.field.select}
			fallback={
				<>
					<select
						class="ask-form-input ask-form-select"
						multiple={props.field.multi}
						size={props.field.multi ? Math.min(props.field.options.length, 6) : undefined}
						aria-label={props.field.question}
						aria-required={props.field.required}
						onChange={(e) => {
							const picked = Array.from(e.currentTarget.selectedOptions, (o) =>
								Number(o.value),
							).filter((n) => Number.isInteger(n));
							props.ctx.update(props.field, setChecked(props.field, choice(), picked));
						}}
					>
						<Show when={!props.field.multi}>
							<option value="" selected={choice().checked.length === 0}>
								Select…
							</option>
						</Show>
						<For each={props.field.options}>
							{(option, i) => (
								<option
									value={i()}
									selected={choice().checked.includes(i())}
									disabled={option.disabled}
								>
									{optionLabel(option.label, option.value)}
								</option>
							)}
						</For>
					</select>
					<For each={props.field.options}>
						{(option, i) => (
							<OptionNote
								ctx={props.ctx}
								field={props.field}
								option={i()}
								label={optionLabel(option.label, option.value)}
								standalone
							>
								<span class="ask-form-note-option">{optionLabel(option.label, option.value)}</span>
							</OptionNote>
						)}
					</For>
				</>
			}
		>
			<div
				class="ask-form-group"
				role={props.field.multi ? "group" : "radiogroup"}
				aria-label={props.field.question}
				aria-required={props.field.required}
			>
				<For each={props.field.options}>
					{(option, i) => (
						<OptionNote
							ctx={props.ctx}
							field={props.field}
							option={i()}
							label={optionLabel(option.label, option.value)}
						>
							<label class="ask-form-option" classList={{ disabled: option.disabled }}>
								<input
									type={props.field.multi ? "checkbox" : "radio"}
									name={name()}
									checked={choice().checked.includes(i())}
									disabled={option.disabled}
									onChange={() =>
										props.ctx.update(props.field, toggleOption(props.field, choice(), i()))
									}
								/>
								<span class="ask-form-option-text">{optionLabel(option.label, option.value)}</span>
							</label>
						</OptionNote>
					)}
				</For>
				<Show when={props.field.other}>
					<div class="ask-form-option ask-form-other">
						<input
							type={props.field.multi ? "checkbox" : "radio"}
							name={name()}
							aria-label="Other"
							checked={isOtherActive(props.field, choice())}
							onChange={() => {
								// Other is on while it has text: a click on its marker either
								// clears a checkbox group's text or goes to the text field.
								if (props.field.multi && isOtherActive(props.field, choice())) {
									props.ctx.update(props.field, clearOther(choice()));
								} else {
									otherInput.focus();
								}
							}}
						/>
						<input
							ref={otherInput}
							class="ask-form-input"
							type="text"
							aria-label={`Other: ${props.field.question}`}
							placeholder="Other: type your own answer"
							autocomplete="off"
							enterkeyhint="done"
							value={choice().other}
							onInput={(e) =>
								props.ctx.update(
									props.field,
									setOther(props.field, choice(), e.currentTarget.value),
								)
							}
						/>
					</div>
				</Show>
			</div>
		</Show>
	);
};

const TextControl: Component<{ ctx: FormContext; field: UiFormTextField }> = (props) => {
	const text = () => (props.ctx.state()[props.field.index] as TextState).text;
	const onInput = (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
		props.ctx.update(props.field, { text: e.currentTarget.value });
	return (
		<Show
			when={props.field.multiline}
			fallback={
				<input
					class="ask-form-input"
					type={inputType(props.field)}
					aria-label={props.field.question}
					aria-required={props.field.required}
					placeholder={props.field.placeholder || undefined}
					min={props.field.min}
					max={props.field.max}
					autocomplete={props.field.type === "password" ? "new-password" : "off"}
					enterkeyhint="send"
					value={text()}
					onInput={onInput}
				/>
			}
		>
			<textarea
				class="ask-form-input ask-form-textarea"
				aria-label={props.field.question}
				aria-required={props.field.required}
				placeholder={props.field.placeholder || undefined}
				rows={Math.min(MAX_TEXTAREA_ROWS, Math.max(2, props.field.rows))}
				value={text()}
				onInput={onInput}
			/>
		</Show>
	);
};

const Field: Component<{ ctx: FormContext; field: UiFormField }> = (props) => {
	const error = () => props.ctx.errors()[props.field.index];
	return (
		<div
			class="ask-form-field"
			classList={{ invalid: error() !== undefined }}
			data-field={props.field.index}
		>
			<FieldLabel field={props.field} />
			{props.field.kind === "choice" ? (
				<ChoiceControls ctx={props.ctx} field={props.field} />
			) : (
				<TextControl ctx={props.ctx} field={props.field} />
			)}
			<Show when={error()}>
				<div class="ask-form-error" role="alert">
					{error()}
				</div>
			</Show>
		</div>
	);
};

/** One block of a section. A picture draws only from a `data:` URI the session resolved. */
function renderBlock(block: UiFormBlock, ctx: FormContext): JSX.Element {
	switch (block.kind) {
		case "text":
			return block.heading ? (
				<h4 class="ask-form-heading">
					<Spans spans={block.spans} />
				</h4>
			) : (
				<p class="ask-form-text">
					<Spans spans={block.spans} />
				</p>
			);
		case "list": {
			const items = (
				<For each={block.items}>
					{(item) => (
						<li>
							<Spans spans={item} />
						</li>
					)}
				</For>
			);
			return block.ordered ? (
				<ol class="ask-form-list">{items}</ol>
			) : (
				<ul class="ask-form-list">{items}</ul>
			);
		}
		case "pre":
			return <pre class="ask-form-pre">{block.text}</pre>;
		case "table":
			return (
				<div class="ask-form-table-wrap">
					<table class="ask-form-table">
						<tbody>
							<For each={block.rows}>
								{(row, r) => (
									<tr>
										<For each={row}>
											{(cell) =>
												r() < block.headerRows ? (
													<th scope="col">
														<Spans spans={cell} />
													</th>
												) : (
													<td>
														<Spans spans={cell} />
													</td>
												)
											}
										</For>
									</tr>
								)}
							</For>
						</tbody>
					</table>
				</div>
			);
		case "image":
			return (
				<Show
					when={isImageDataUri(block.src)}
					fallback={block.alt ? <p class="ask-form-text">{block.alt}</p> : null}
				>
					<img class="ask-form-image" src={block.src} alt={block.alt} decoding="async" />
				</Show>
			);
		case "field":
			return <Field ctx={ctx} field={block.field} />;
	}
}

/**
 * The ask tool's HTML form (`formDialog` ui_request), whole: titled sections, context
 * blocks and fields. A chosen option can carry a note for the agent (see OptionNote).
 * Enter in a field (Ctrl+Enter in a textarea) or Submit validates with the SDK's field
 * rules and sends one answer per field with its notes; Esc or Cancel resolves undefined.
 * A deadline from the session counts down in the header; the session submits the form's
 * defaults, without notes, when it passes.
 */
export const AskForm: Component<{ id: string; params: UiFormParams }> = (props) => {
	let root!: HTMLDivElement;
	const fields = formFields(props.params);
	const [state, setState] = createSignal<FormState>(initialFormState(fields));
	const [errors, setErrors] = createSignal<Record<number, string>>({});
	const ctx: FormContext = {
		id: props.id,
		state,
		errors,
		update: (field, next) => {
			setState((all) => ({ ...all, [field.index]: next }));
			setErrors((all) => {
				if (!(field.index in all)) return all;
				const { [field.index]: _cleared, ...rest } = all;
				return rest;
			});
		},
	};

	const deadline = props.params.deadline;
	const [now, setNow] = createSignal(Date.now());
	if (deadline !== undefined) {
		const tick = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => clearInterval(tick));
	}
	const remaining = () =>
		deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now()) / 1000));

	const submit = () => {
		const found = validateForm(fields, state());
		setErrors(found);
		const first = fields.find((field) => found[field.index] !== undefined);
		if (first) {
			root
				.querySelector<HTMLElement>(`[data-field="${first.index}"] :is(input, select, textarea)`)
				?.focus();
			return;
		}
		sendUiResponse(props.id, buildSubmit(fields, state()));
	};

	onMount(() => {
		// The first control takes focus, so Enter accepts the preselected answers at once.
		(
			root.querySelector<HTMLElement>(":is(input, select, textarea):not(:disabled)") ?? root
		).focus();
	});

	return (
		<div
			class="ask-bar ask-form"
			role="dialog"
			aria-label="Agent asks"
			ref={root}
			tabIndex={-1}
			onKeyDown={(e) => {
				if (isImeKey(e)) return;
				if (e.key === "Escape") {
					e.preventDefault();
					cancelUiRequest(props.id);
					return;
				}
				// A textarea keeps Enter for newlines; Ctrl/Cmd+Enter submits from it.
				if (
					e.key === "Enter" &&
					(e.ctrlKey || e.metaKey) &&
					e.target instanceof HTMLTextAreaElement
				) {
					e.preventDefault();
					submit();
				}
			}}
		>
			<header class="ask-bar-head">
				<span class="ask-bar-title">Agent asks</span>
				<Show when={remaining()}>
					<span class="ask-form-countdown">Submits defaults in {remaining()}s</span>
				</Show>
				<button type="button" class="ask-bar-cancel" onClick={() => cancelUiRequest(props.id)}>
					<kbd>esc</kbd> Cancel
				</button>
			</header>
			<form
				class="ask-form-main"
				novalidate
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div class="ask-form-body">
					<For each={props.params.sections}>
						{(section) => (
							<Show
								when={spansText(section.title).trim() !== ""}
								fallback={
									<div class="ask-form-section">
										<For each={section.blocks}>{(block) => renderBlock(block, ctx)}</For>
									</div>
								}
							>
								<fieldset class="ask-form-section">
									<legend class="ask-form-legend">
										<Spans spans={section.title} />
									</legend>
									<For each={section.blocks}>{(block) => renderBlock(block, ctx)}</For>
								</fieldset>
							</Show>
						)}
					</For>
				</div>
				<div class="ask-actions">
					<button type="submit" class="ask-bar-next">
						Submit
					</button>
				</div>
			</form>
		</div>
	);
};
