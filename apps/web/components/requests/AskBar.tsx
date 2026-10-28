import {
	createEffect,
	createSignal,
	For,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
	type Component,
} from "solid-js";
import { cancelUiRequest, sendUiResponse, state } from "../../state";
import {
	answerSummary,
	buildResults,
	entryCursor,
	initialAnswer,
	isAnswered,
	tabLabel,
	type AskAnswer,
} from "../../prompt/ask-dialog";
import { approvalChoices, splitApprovalPrompt } from "../../prompt/approval";
import type { AskOption, AskQuestion, UiRequest } from "../../prompt/ask-types";
import type { UiApprovalParams } from "#lib/wire/protocol";
import { isImeKey } from "../../prompt/key-input";
import { mayAutoFocusComposer } from "../../store/chat";
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
	// The main composer regains focus when the dialog settles, however it settled (never an agent pane's steer box).
	// Not on a touch screen: a programmatic focus there raises the soft keyboard the user did not ask for.
	onCleanup(() => {
		if (!mayAutoFocusComposer()) return;
		document
			.querySelector<HTMLTextAreaElement>(".prompt-box:not(.subagent-composer) textarea")
			?.focus();
	});
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
			<Match when={props.req.method === "approve"}>
				<AskApproval id={props.req.id} prompt={props.req.params as UiApprovalParams} />
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
	/** Left/Right move between steps (-1 previous, 1 next); omitted when there are none. */
	step?: (direction: -1 | 1) => void;
	cancel: () => void;
}

/**
 * Shared key map for a row list; text fields keep every key except Esc, and a
 * focused button keeps Enter/Space so it activates natively.
 */
function rowKeys(k: Keys) {
	return (e: KeyboardEvent) => {
		if (isImeKey(e)) return;
		if (e.key === "Escape") {
			e.preventDefault();
			k.cancel();
			return;
		}
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
		if (target.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
		if (/^[1-9]$/.test(e.key)) {
			const index = Number(e.key) - 1;
			if (index < (k.digitRows?.() ?? k.rows())) {
				e.preventDefault();
				k.pick(index);
			}
			return;
		}
		if (
			k.step &&
			(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
			!(e.altKey || e.ctrlKey || e.metaKey)
		) {
			e.preventDefault();
			k.step(e.key === "ArrowRight" ? 1 : -1);
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

const AskHeader: Component<{ id: string; title: string }> = (props) => (
	<header class="ask-bar-head">
		<span class="ask-bar-title">{props.title}</span>
		<button type="button" class="ask-bar-cancel" onClick={() => cancelUiRequest(props.id)}>
			<kbd>esc</kbd> Cancel
		</button>
	</header>
);

/**
 * The ask tool's dialog. One question: a single-select pick submits, a
 * multi-select has its Submit button. Two or more: a tab per question plus a
 * review step; picks and Next/Skip/arrows only move between steps and the
 * review step's Submit button is the only way to send.
 */
const AskQuestions: Component<{ id: string; questions: AskQuestion[] }> = (props) => {
	let root!: HTMLDivElement;
	let other!: HTMLInputElement;
	let submitButton: HTMLButtonElement | undefined;
	const tabs: HTMLButtonElement[] = [];
	const count = props.questions.length;
	const stepped = count > 1;
	/** Steps 0..count-1 are the questions; step `count` is the review. */
	const [step, setStep] = createSignal(0);
	const [answers, setAnswers] = createSignal<AskAnswer[]>(props.questions.map(initialAnswer));
	const [cursor, setCursor] = createSignal(
		props.questions[0] ? entryCursor(props.questions[0], answers()[0]) : 0,
	);
	const reviewing = () => stepped && step() === count;
	const current = (): AskQuestion | undefined =>
		reviewing() ? undefined : props.questions[step()];

	const setAnswer = (i: number, next: (a: AskAnswer) => AskAnswer) =>
		setAnswers((all) => all.map((a, j) => (j === i ? next(a) : a)));

	const goTo = (target: number) => {
		const next = Math.max(0, Math.min(target, count));
		if (next === step()) return;
		setStep(next);
		if (next < count) setCursor(entryCursor(props.questions[next], answers()[next]));
	};

	// ExtensionAskDialogSubmitResult: the SDK validates count, order, and ids.
	const submit = () =>
		sendUiResponse(props.id, { kind: "submit", results: buildResults(props.questions, answers()) });

	/** Steps forward; a lone question submits instead, once it has an answer. */
	const advance = () => {
		if (stepped) goTo(step() + 1);
		else if (isAnswered(answers()[0])) submit();
	};

	const skip = () => {
		setAnswer(step(), () => ({ selected: [], custom: "" }));
		goTo(step() + 1);
	};

	const pick = (index: number) => {
		setCursor(index);
		const q = current();
		if (!q) return;
		if (index === q.options.length) {
			other.focus();
			return;
		}
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
		advance();
	};

	onMount(() => root.focus());
	// After a step change: keep the active tab visible, focus Submit on the review,
	// and keep keys flowing to the dialog when the focused control went away.
	createEffect(
		on(
			step,
			(s) => {
				tabs[s]?.scrollIntoView({ block: "nearest", inline: "nearest" });
				if (s === count) {
					submitButton?.focus();
					return;
				}
				const active = document.activeElement;
				if (
					!root.contains(active) ||
					active === other ||
					(active instanceof HTMLButtonElement && active.disabled)
				) {
					root.focus();
				}
			},
			{ defer: true },
		),
	);
	const onKey = rowKeys({
		rows: () => {
			const q = current();
			return q ? q.options.length + 1 : 0;
		},
		digitRows: () => current()?.options.length ?? 0,
		cursor,
		setCursor,
		pick,
		step: stepped ? (direction) => goTo(step() + direction) : undefined,
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
			<AskHeader id={props.id} title="Agent asks" />
			<Show when={stepped}>
				<div class="ask-tabs" role="tablist" aria-label="Questions">
					<For each={props.questions}>
						{(q, i) => {
							const answered = () => isAnswered(answers()[i()]);
							return (
								<button
									type="button"
									role="tab"
									class="ask-tab"
									classList={{ answered: answered() }}
									aria-selected={step() === i()}
									aria-label={`${tabLabel(q, i())}, ${answered() ? "answered" : "unanswered"}`}
									ref={(el) => {
										tabs[i()] = el;
									}}
									onClick={() => goTo(i())}
								>
									<span class="ask-tab-mark" aria-hidden="true">
										{answered() ? "✓" : "○"}
									</span>
									<span class="ask-tab-label">{tabLabel(q, i())}</span>
								</button>
							);
						}}
					</For>
					<button
						type="button"
						role="tab"
						class="ask-tab"
						aria-selected={reviewing()}
						ref={(el) => {
							tabs[count] = el;
						}}
						onClick={() => goTo(count)}
					>
						Review
					</button>
				</div>
			</Show>
			<Show when={current()} keyed>
				{(q) => {
					// Fixed per render: the question's view is rebuilt when the step changes.
					const qi = step();
					return (
						<>
							<Show when={q.header}>
								<div class="ask-header">{q.header}</div>
							</Show>
							<div class="ask-label">{q.question}</div>
							<div class="picker-list ask-options">
								<For each={q.options}>
									{(opt, oi) => {
										const selected = () => answers()[qi].selected.includes(opt.label);
										return (
											<PickerRow
												class="picker-row ask-option"
												classList={{ active: selected(), cursor: cursor() === oi() }}
												onClick={() => pick(oi())}
											>
												<span class="ask-key">{oi() < 9 ? oi() + 1 : ""}</span>
												<span class="ask-marker">
													{q.multi ? (selected() ? "☑" : "☐") : selected() ? "●" : "○"}
												</span>
												<span class="ask-option-text">
													<span class="picker-label">{opt.label}</span>
													{oi() === q.recommended && (
														<span class="ask-recommended">recommended</span>
													)}
													{opt.description && <span class="picker-detail">{opt.description}</span>}
												</span>
											</PickerRow>
										);
									}}
								</For>
								<PickerRow
									class="picker-row ask-option"
									classList={{ cursor: cursor() === q.options.length }}
									onClick={() => pick(q.options.length)}
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
								autocomplete="off"
								enterkeyhint="done"
								value={answers()[qi].custom}
								onInput={(e) => setAnswer(qi, (a) => ({ ...a, custom: e.currentTarget.value }))}
								onKeyDown={(e) => {
									if (e.key !== "Enter" || isImeKey(e)) return;
									e.preventDefault();
									advance();
								}}
							/>
							<Show when={!stepped && q.multi}>
								<div class="ask-actions">
									<button type="button" class="ask-bar-next" onClick={advance}>
										Submit
									</button>
								</div>
							</Show>
						</>
					);
				}}
			</Show>
			<Show when={stepped && !reviewing()}>
				<div class="ask-actions ask-nav">
					<button
						type="button"
						class="ask-bar-nav"
						disabled={step() === 0}
						onClick={() => goTo(step() - 1)}
					>
						Back
					</button>
					<button type="button" class="ask-bar-nav ask-nav-skip" onClick={skip}>
						Skip
					</button>
					<button type="button" class="ask-bar-next" onClick={() => goTo(step() + 1)}>
						Next
					</button>
				</div>
			</Show>
			<Show when={reviewing()}>
				<div class="ask-header">Review</div>
				<div class="ask-review">
					<For each={props.questions}>
						{(q, i) => (
							<button type="button" class="ask-review-row" onClick={() => goTo(i())}>
								<span class="ask-review-q">{q.question}</span>
								<span
									class="ask-review-a"
									classList={{ "ask-review-skipped": !isAnswered(answers()[i()]) }}
								>
									{isAnswered(answers()[i()]) ? answerSummary(answers()[i()]) : "Skipped"}
								</span>
							</button>
						)}
					</For>
				</div>
				<div class="ask-actions">
					<button type="button" class="ask-bar-nav" onClick={() => goTo(count - 1)}>
						Back
					</button>
					<button type="button" class="ask-bar-next" ref={submitButton} onClick={submit}>
						Submit
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
							<span class="ask-option-text">
								<span class="picker-label">{typeof opt === "string" ? opt : opt.label}</span>
								{typeof opt !== "string" && opt.description && (
									<span class="picker-detail">{opt.description}</span>
								)}
							</span>
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
					<kbd>1</kbd> OK
				</button>
				<button
					type="button"
					class="ask-bar-cancel"
					classList={{ cursor: cursor() === 1 }}
					onClick={() => sendUiResponse(props.id, false)}
				>
					<kbd>2</kbd> Cancel
				</button>
			</div>
		</div>
	);
};

/**
 * Tool approval: the prompt's title line, its details (monospace, whitespace
 * preserved, scrolls on its own) and one row per answer. Digit keys, Up/Down + Enter or a
 * click answers; Esc and Cancel answer nothing, which the session reads as Deny.
 * PageUp/PageDown scroll the details while the keys above own the arrows.
 */
const AskApproval: Component<{ id: string; prompt: UiApprovalParams }> = (props) => {
	let root!: HTMLDivElement;
	let details: HTMLPreElement | undefined;
	const [cursor, setCursor] = createSignal(0);
	onMount(() => root.focus());
	const split = () => splitApprovalPrompt(props.prompt.full);
	const choices = () => approvalChoices(props.prompt);
	const onKeys = rowKeys({
		rows: () => choices().length,
		cursor,
		setCursor,
		pick: (index) => sendUiResponse(props.id, choices()[index].answer),
		cancel: () => cancelUiRequest(props.id),
	});
	const onKey = (e: KeyboardEvent) => {
		if ((e.key === "PageUp" || e.key === "PageDown") && details) {
			e.preventDefault();
			details.scrollBy({ top: (e.key === "PageDown" ? 1 : -1) * details.clientHeight * 0.9 });
			return;
		}
		onKeys(e);
	};
	return (
		<div
			class="ask-bar ask-approval"
			role="dialog"
			aria-label={split().title}
			ref={root}
			tabIndex={-1}
			onKeyDown={onKey}
		>
			<AskHeader id={props.id} title={split().title} />
			<Show when={split().details}>
				<pre class="ask-approval-details" ref={details}>
					{split().details}
				</pre>
			</Show>
			<div class="picker-list ask-options">
				<For each={choices()}>
					{(choice, ci) => (
						<PickerRow
							class="picker-row ask-option"
							classList={{ cursor: cursor() === ci() }}
							onClick={() => sendUiResponse(props.id, choice.answer)}
						>
							<span class="ask-key">{ci() < 9 ? ci() + 1 : ""}</span>
							<span class="ask-option-text">
								<span class="picker-label">{choice.label}</span>
								{choice.detail && <span class="picker-detail">{choice.detail}</span>}
							</span>
						</PickerRow>
					)}
				</For>
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
		if (e.key !== "Enter" || isImeKey(e)) return;
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
				if (e.key === "Escape" && !isImeKey(e)) cancelUiRequest(props.id);
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
						autocomplete="off"
						enterkeyhint="send"
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
