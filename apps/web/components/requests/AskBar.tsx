import {
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
	type Component,
} from "solid-js";
import { cancelUiRequest, sendUiResponse, state } from "../../state";
import type { AskOption, AskQuestion, UiRequest } from "../../prompt/ask-types";
import { PickerRow } from "../ui/PickerRow";

/**
 * Agent-to-user dialogs (ExtensionUIContext): docked above the prompt in the
 * composer slot, not an overlay. Keys: 1-9 pick an option, Up/Down move the
 * cursor, Enter activates it, Esc cancels. Typing in the "Other" field or the
 * input/editor fields keeps its own keys. The pending request is state.uiRequest;
 * answers go back as ui_response and cancels resolve undefined.
 */
export const AskBar: Component = () => (
	<Show when={state.uiRequest} keyed>
		{(req: UiRequest) => <AskRequest req={req} />}
	</Show>
);

/** Dialog params as the SDK sends them; each method reads only the fields it defines. */
interface AskParams {
	title?: string;
	message?: string;
	placeholder?: string;
	prefill?: string;
	options?: (string | AskOption)[];
	questions?: AskQuestion[];
}

const AskRequest: Component<{ req: UiRequest }> = (props) => {
	// Trusted boundary: ui_request params follow the SDK dialog shape for the method.
	const params = props.req.params as AskParams;
	// The composer regains focus when the dialog settles, however it settled.
	onCleanup(() => document.querySelector<HTMLTextAreaElement>(".prompt-box textarea")?.focus());
	return (
		<Switch fallback={null}>
			<Match when={props.req.method === "askDialog"}>
				<AskQuestions id={props.req.id} questions={params.questions ?? []} />
			</Match>
			<Match when={props.req.method === "select"}>
				<AskSelect id={props.req.id} title={params.title ?? ""} options={params.options ?? []} />
			</Match>
			<Match when={props.req.method === "confirm"}>
				<AskConfirm id={props.req.id} title={params.title ?? ""} message={params.message ?? ""} />
			</Match>
			<Match when={props.req.method === "input" || props.req.method === "editor"}>
				<AskText
					id={props.req.id}
					multiline={props.req.method === "editor"}
					title={params.title ?? ""}
					placeholder={params.placeholder}
					prefill={params.prefill}
				/>
			</Match>
		</Switch>
	);
};

interface Keys {
	/** Rows navigable with Up/Down. */
	rows: () => number;
	/** Leading rows a digit key can pick (digit N picks row N-1). */
	digitRows?: () => number;
	cursor: () => number;
	setCursor: (index: number) => void;
	pick: (index: number) => void;
	cancel: () => void;
}

/** Shared key map for a row list; text fields keep every key except Esc. */
function rowKeys(k: Keys) {
	return (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			k.cancel();
			return;
		}
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
		if (/^[1-9]$/.test(e.key)) {
			const index = Number(e.key) - 1;
			if (index < (k.digitRows?.() ?? k.rows())) {
				e.preventDefault();
				k.pick(index);
			}
			return;
		}
		const count = k.rows();
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (count === 0) return;
			const step = e.key === "ArrowDown" ? 1 : -1;
			k.setCursor((k.cursor() + step + count) % count);
			return;
		}
		if (e.key === "Enter" && count > 0) {
			e.preventDefault();
			k.pick(k.cursor());
		}
	};
}

const AskHeader: Component<{ id: string; title: string; progress?: string }> = (props) => (
	<header class="ask-bar-head">
		<span class="ask-bar-title">{props.title}</span>
		<Show when={props.progress}>
			<span class="ask-bar-progress">{props.progress}</span>
		</Show>
		<button type="button" class="ask-bar-cancel" onClick={() => cancelUiRequest(props.id)}>
			Cancel <kbd>Esc</kbd>
		</button>
	</header>
);

interface Answer {
	selected: string[];
	custom: string;
}

/** The ask tool's dialog: one question at a time; Enter or a digit answers single-select and advances. */
const AskQuestions: Component<{ id: string; questions: AskQuestion[] }> = (props) => {
	let root!: HTMLDivElement;
	let other!: HTMLInputElement;
	// The recommended option is preselected so a plain Enter accepts it.
	const initialAnswer = (q: AskQuestion): Answer => {
		const rec = q.recommended !== undefined ? q.options[q.recommended] : undefined;
		return { selected: rec ? [rec.label] : [], custom: "" };
	};
	const [step, setStep] = createSignal(0);
	const [cursor, setCursor] = createSignal(props.questions[0]?.recommended ?? 0);
	const [answers, setAnswers] = createSignal<Answer[]>(props.questions.map(initialAnswer));
	const current = () => props.questions[step()];
	const otherIndex = () => current().options.length;

	const setAnswer = (i: number, next: (a: Answer) => Answer) =>
		setAnswers((all) => all.map((a, j) => (j === i ? next(a) : a)));

	/** Accept the current question when it has an answer; the last one submits. */
	const commit = () => {
		const a = answers()[step()];
		if (a.selected.length === 0 && a.custom.trim() === "") return;
		if (step() + 1 < props.questions.length) {
			const next = step() + 1;
			setStep(next);
			setCursor(props.questions[next].recommended ?? 0);
			return;
		}
		// ExtensionAskDialogSubmitResult: AskToolCard validates count, order, and ids.
		sendUiResponse(props.id, {
			kind: "submit",
			results: props.questions.map((q, i) => {
				const text = answers()[i].custom.trim();
				return {
					id: q.id,
					question: q.question,
					options: q.options.map((o) => o.label),
					multi: q.multi ?? false,
					selectedOptions: answers()[i].selected,
					...(text ? { customInput: text } : {}),
				};
			}),
		});
	};

	const pick = (index: number) => {
		setCursor(index);
		if (index === otherIndex()) {
			other.focus();
			return;
		}
		const q = current();
		const label = q.options[index].label;
		if (q.multi) {
			setAnswer(step(), (a) => ({
				...a,
				selected: a.selected.includes(label)
					? a.selected.filter((l) => l !== label)
					: [...a.selected, label],
			}));
			return;
		}
		setAnswer(step(), (a) => ({ ...a, selected: [label] }));
		commit();
	};

	onMount(() => root.focus());
	const onKey = rowKeys({
		rows: () => otherIndex() + 1,
		digitRows: otherIndex,
		cursor,
		setCursor,
		pick,
		cancel: () => cancelUiRequest(props.id),
	});

	return (
		<div
			class="ask-bar"
			role="dialog"
			aria-label="Agent asks"
			ref={root}
			tabIndex={-1}
			onKeyDown={onKey}
		>
			<AskHeader
				id={props.id}
				title="Agent asks"
				progress={
					props.questions.length > 1
						? `Question ${step() + 1} of ${props.questions.length}`
						: undefined
				}
			/>
			<Show when={current()?.header}>
				<div class="ask-header">{current().header}</div>
			</Show>
			<div class="ask-label">{current()?.question}</div>
			<div class="picker-list ask-options">
				<For each={current()?.options ?? []}>
					{(opt, oi) => {
						const selected = () => answers()[step()]?.selected.includes(opt.label) ?? false;
						return (
							<PickerRow
								class="picker-row ask-option"
								classList={{ active: selected(), cursor: cursor() === oi() }}
								onClick={() => pick(oi())}
							>
								<span class="ask-key">{oi() < 9 ? oi() + 1 : ""}</span>
								<span class="ask-marker">
									{current().multi ? (selected() ? "☑" : "☐") : selected() ? "●" : "○"}
								</span>
								<span class="picker-label">{opt.label}</span>
								{oi() === current().recommended && <span class="ask-recommended">recommended</span>}
								{opt.description && <span class="picker-detail">{opt.description}</span>}
							</PickerRow>
						);
					}}
				</For>
				<PickerRow
					class="picker-row ask-option"
					classList={{ cursor: cursor() === otherIndex() }}
					onClick={() => pick(otherIndex())}
				>
					<span class="ask-key" />
					<span class="ask-marker">✎</span>
					<span class="picker-label">Other</span>
				</PickerRow>
			</div>
			<input
				ref={other}
				class="picker-filter ask-custom"
				aria-label="Custom answer"
				placeholder="Type your own answer"
				value={answers()[step()]?.custom ?? ""}
				onInput={(e) => setAnswer(step(), (a) => ({ ...a, custom: e.currentTarget.value }))}
				onKeyDown={(e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					commit();
				}}
			/>
			<Show when={current()?.multi}>
				<div class="ask-actions">
					<button type="button" class="ask-bar-next" onClick={commit}>
						{step() + 1 < props.questions.length ? "Next" : "Submit"}
					</button>
				</div>
			</Show>
		</div>
	);
};

/** select fallback: one option list; digit, Up/Down + Enter, or click answers with the option label. */
const AskSelect: Component<{ id: string; title: string; options: (string | AskOption)[] }> = (
	props,
) => {
	let root!: HTMLDivElement;
	const [cursor, setCursor] = createSignal(0);
	onMount(() => root.focus());
	const onKey = rowKeys({
		rows: () => props.options.length,
		cursor,
		setCursor,
		pick: (index) => {
			const opt = props.options[index];
			sendUiResponse(props.id, typeof opt === "string" ? opt : opt.label);
		},
		cancel: () => cancelUiRequest(props.id),
	});
	return (
		<div
			class="ask-bar"
			role="dialog"
			aria-label={props.title}
			ref={root}
			tabIndex={-1}
			onKeyDown={onKey}
		>
			<AskHeader id={props.id} title={props.title} />
			<div class="picker-list ask-options">
				<For each={props.options}>
					{(opt, oi) => (
						<PickerRow
							class="picker-row ask-option"
							classList={{ cursor: cursor() === oi() }}
							onClick={() => sendUiResponse(props.id, typeof opt === "string" ? opt : opt.label)}
						>
							<span class="ask-key">{oi() < 9 ? oi() + 1 : ""}</span>
							<span class="picker-label">{typeof opt === "string" ? opt : opt.label}</span>
							{typeof opt !== "string" && opt.description && (
								<span class="picker-detail">{opt.description}</span>
							)}
						</PickerRow>
					)}
				</For>
			</div>
		</div>
	);
};

/** confirm fallback: OK/Cancel returning a boolean; Esc cancels (resolves undefined, read as no). */
const AskConfirm: Component<{ id: string; title: string; message: string }> = (props) => {
	let root!: HTMLDivElement;
	const [cursor, setCursor] = createSignal(0);
	onMount(() => root.focus());
	const onKey = rowKeys({
		rows: () => 2,
		cursor,
		setCursor,
		pick: (index) => sendUiResponse(props.id, index === 0),
		cancel: () => cancelUiRequest(props.id),
	});
	return (
		<div
			class="ask-bar"
			role="dialog"
			aria-label={props.title}
			ref={root}
			tabIndex={-1}
			onKeyDown={onKey}
		>
			<AskHeader id={props.id} title={props.title} />
			<p class="ask-message">{props.message}</p>
			<div class="ask-actions">
				<button
					type="button"
					class="ask-bar-next"
					classList={{ cursor: cursor() === 0 }}
					onClick={() => sendUiResponse(props.id, true)}
				>
					OK <kbd>1</kbd>
				</button>
				<button
					type="button"
					class="ask-bar-cancel"
					classList={{ cursor: cursor() === 1 }}
					onClick={() => sendUiResponse(props.id, false)}
				>
					Cancel <kbd>2</kbd>
				</button>
			</div>
		</div>
	);
};

/** input / editor fallbacks: a text field submitted with Enter (input) or Ctrl+Enter (editor). */
const AskText: Component<{
	id: string;
	multiline: boolean;
	title: string;
	placeholder?: string;
	prefill?: string;
}> = (props) => {
	const [value, setValue] = createSignal(props.prefill ?? "");
	let field!: HTMLInputElement | HTMLTextAreaElement;
	onMount(() => field.focus());
	const onFieldKey = (e: KeyboardEvent) => {
		if (e.key !== "Enter") return;
		if (props.multiline && !(e.ctrlKey || e.metaKey)) return;
		e.preventDefault();
		sendUiResponse(props.id, value());
	};
	return (
		<div
			class="ask-bar"
			role="dialog"
			aria-label={props.title}
			onKeyDown={(e) => {
				if (e.key === "Escape") cancelUiRequest(props.id);
			}}
		>
			<AskHeader id={props.id} title={props.title} />
			<Show
				when={props.multiline}
				fallback={
					<input
						ref={(el) => (field = el)}
						class="picker-filter"
						aria-label={props.title}
						placeholder={props.placeholder}
						value={value()}
						onInput={(e) => setValue(e.currentTarget.value)}
						onKeyDown={onFieldKey}
					/>
				}
			>
				<textarea
					ref={(el) => (field = el)}
					class="ask-editor"
					aria-label={props.title}
					value={value()}
					onInput={(e) => setValue(e.currentTarget.value)}
					onKeyDown={onFieldKey}
				/>
			</Show>
			<div class="ask-actions">
				<button
					type="button"
					class="ask-bar-next"
					onClick={() => sendUiResponse(props.id, value())}
				>
					Submit
				</button>
			</div>
		</div>
	);
};
