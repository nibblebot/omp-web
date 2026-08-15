import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { cancelUiRequest, sendUiResponse, state } from "../state";
import { Modal } from "./Modal";

// Wire shapes mirror the ExtensionUIContext dialog surface
// (extensibility/extensions/types.ts: ExtensionAskDialogQuestion,
// ExtensionAskDialogResult, ExtensionUISelectItem). Redefined locally — the
// web client must not import the server package.

type AskOption = { label: string; description?: string; preview?: string };

type AskQuestion = {
	id: string;
	question: string;
	header?: string;
	options: AskOption[];
	multi?: boolean;
	recommended?: number;
};

type UiRequest = { id: string; method: string; params: unknown };

/**
 * Server-pushed ExtensionUIContext dialogs (Phase 3): the ask tool's rich
 * multi-question form (askDialog) plus select/confirm/input/editor fallbacks
 * rendered with the same modal. Answers go back as ui_response; cancelling
 * resolves the request undefined, which AskTool surfaces as "Ask tool was
 * cancelled by the user".
 */
export const AskDialog: Component = () => (
	<Show when={state.uiRequest} keyed>
		{(req: UiRequest) => {
			switch (req.method) {
				case "askDialog": {
					const p = req.params as { questions: AskQuestion[] };
					return (
						<Modal title="Agent asks" onClose={() => cancelUiRequest(req.id)}>
							<AskForm id={req.id} questions={p.questions ?? []} />
						</Modal>
					);
				}
				case "select":
					return <SelectForm id={req.id} params={req.params} />;
				case "confirm":
					return <ConfirmForm id={req.id} params={req.params} />;
				case "input":
					return <InputForm id={req.id} params={req.params} />;
				case "editor":
					return <EditorForm id={req.id} params={req.params} />;
				default:
					return null;
			}
		}}
	</Show>
);

/** Rich multi-question form: ExtensionAskDialogSubmitResult on submit. */
const AskForm: Component<{ id: string; questions: AskQuestion[] }> = props => {
	// Per-question answer state, keyed by question index.
	const [selected, setSelected] = createSignal<Record<number, string[]>>({});
	const [custom, setCustom] = createSignal<Record<number, string>>({});

	const toggle = (qi: number, label: string, multi: boolean) => {
		const cur = selected()[qi] ?? [];
		const next = multi
			? cur.includes(label)
				? cur.filter(l => l !== label)
				: [...cur, label]
			: cur.includes(label)
				? []
				: [label];
		setSelected({ ...selected(), [qi]: next });
	};

	const answered = (qi: number) => (selected()[qi]?.length ?? 0) > 0 || (custom()[qi]?.trim() ?? "") !== "";
	const allAnswered = () => props.questions.every((_, qi) => answered(qi));

	const submit = () => {
		// ExtensionAskDialogSubmitResult — AskTool validates result count,
		// order, and ids against the request, so map the questions verbatim.
		sendUiResponse(props.id, {
			kind: "submit",
			results: props.questions.map((q, qi) => {
				const customText = custom()[qi]?.trim();
				return {
					id: q.id,
					question: q.question,
					options: q.options.map(o => o.label),
					multi: q.multi ?? false,
					selectedOptions: selected()[qi] ?? [],
					...(customText ? { customInput: customText } : {}),
				};
			}),
		});
	};

	return (
		<form
			onSubmit={e => {
				e.preventDefault();
				if (allAnswered()) submit();
			}}
		>
			<div class="ask-questions">
				<For each={props.questions}>
					{(q, qi) => (
						<div class="ask-question">
							{q.header && <div class="ask-header">{q.header}</div>}
							<div class="ask-label">{q.question}</div>
							<div class="picker-list ask-options">
								<For each={q.options}>
									{(opt, oi) => {
										const isSelected = () => (selected()[qi()] ?? []).includes(opt.label);
										return (
											<button
												type="button"
												class="picker-row ask-option"
												classList={{ active: isSelected() }}
												aria-pressed={isSelected()}
												onClick={() => toggle(qi(), opt.label, q.multi ?? false)}
											>
												<span class="ask-marker">{isSelected() ? (q.multi ? "☑" : "●") : q.multi ? "☐" : "○"}</span>
												<span class="picker-label">{opt.label}</span>
												{oi() === q.recommended && <span class="ask-recommended">recommended</span>}
												{opt.description && <span class="picker-detail">{opt.description}</span>}
											</button>
										);
									}}
								</For>
							</div>
							<input
								class="picker-filter ask-custom"
								aria-label="Custom answer"
								placeholder="Other…"
								value={custom()[qi()] ?? ""}
								onInput={e => setCustom({ ...custom(), [qi()]: e.currentTarget.value })}
							/>
						</div>
					)}
				</For>
			</div>
			<div class="ask-actions">
				<button type="submit" class="send" disabled={!allAnswered()}>
					Submit
				</button>
				<button type="button" onClick={() => cancelUiRequest(props.id)}>
					Cancel
				</button>
			</div>
		</form>
	);
};

/** select fallback: single option list, click answers with the option label. */
const SelectForm: Component<{ id: string; params: unknown }> = props => {
	const p = () => props.params as { title: string; options: (string | AskOption)[] };
	const label = (o: string | AskOption) => (typeof o === "string" ? o : o.label);
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<div class="picker-list">
				<For each={p().options ?? []}>
					{opt => (
						<button
							type="button"
							class="picker-row ask-option"
							onClick={() => sendUiResponse(props.id, label(opt))}
						>
							<span class="picker-label">{label(opt)}</span>
							{typeof opt !== "string" && opt.description && <span class="picker-detail">{opt.description}</span>}
						</button>
					)}
				</For>
			</div>
			<div class="ask-actions">
				<button type="button" onClick={() => cancelUiRequest(props.id)}>
					Cancel
				</button>
			</div>
		</Modal>
	);
};

/** confirm fallback: OK/Cancel returning a boolean. */
const ConfirmForm: Component<{ id: string; params: unknown }> = props => {
	const p = () => props.params as { title: string; message: string };
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<p class="ask-message">{p().message}</p>
			<div class="ask-actions">
				<button type="button" class="send" onClick={() => sendUiResponse(props.id, true)}>
					OK
				</button>
				<button type="button" onClick={() => sendUiResponse(props.id, false)}>
					Cancel
				</button>
			</div>
		</Modal>
	);
};

/** input fallback: single-line text returning a string. */
const InputForm: Component<{ id: string; params: unknown }> = props => {
	const p = () => props.params as { title: string; placeholder?: string };
	const [value, setValue] = createSignal("");
	let el!: HTMLInputElement;
	onMount(() => el.focus());
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<form
				onSubmit={e => {
					e.preventDefault();
					sendUiResponse(props.id, value());
				}}
			>
				<input
					class="picker-filter"
					ref={el}
					aria-label={p().title}
					placeholder={p().placeholder}
					value={value()}
					onInput={e => setValue(e.currentTarget.value)}
				/>
				<div class="ask-actions">
					<button type="submit" class="send">
						Submit
					</button>
					<button type="button" onClick={() => cancelUiRequest(props.id)}>
						Cancel
					</button>
				</div>
			</form>
		</Modal>
	);
};

/** editor fallback: multiline text (prefilled) returning a string. */
const EditorForm: Component<{ id: string; params: unknown }> = props => {
	const p = () => props.params as { title: string; prefill?: string };
	const [value, setValue] = createSignal(p().prefill ?? "");
	let el!: HTMLTextAreaElement;
	onMount(() => el.focus());
	return (
		<Modal title={p().title} onClose={() => cancelUiRequest(props.id)}>
			<form
				onSubmit={e => {
					e.preventDefault();
					sendUiResponse(props.id, value());
				}}
			>
				<textarea class="ask-editor" ref={el} aria-label={p().title} value={value()} onInput={e => setValue(e.currentTarget.value)} />
				<div class="ask-actions">
					<button type="submit" class="send">
						Submit
					</button>
					<button type="button" onClick={() => cancelUiRequest(props.id)}>
						Cancel
					</button>
				</div>
			</form>
		</Modal>
	);
};
