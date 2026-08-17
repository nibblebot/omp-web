import { createSignal, For, type Component } from "solid-js";
import { cancelUiRequest, sendUiResponse } from "../../../state";
import { DialogActions } from "../../shared";
import { CircleDotIcon, CircleIcon, SquareCheckIcon, SquareIcon } from "../../shared/icons";
import { PickerRow } from "../../shared/PickerRow";
import type { AskQuestion } from "./types";

/** Rich multi-question form: ExtensionAskDialogSubmitResult on submit. */
export const AskForm: Component<{ id: string; questions: AskQuestion[] }> = (props) => {
	// Per-question answer state, keyed by question index.
	const [selected, setSelected] = createSignal<Record<number, string[]>>({});
	const [custom, setCustom] = createSignal<Record<number, string>>({});

	const toggle = (qi: number, label: string, multi: boolean) => {
		const cur = selected()[qi] ?? [];
		const next = multi
			? cur.includes(label)
				? cur.filter((l) => l !== label)
				: [...cur, label]
			: cur.includes(label)
				? []
				: [label];
		setSelected({ ...selected(), [qi]: next });
	};

	const answered = (qi: number) =>
		(selected()[qi]?.length ?? 0) > 0 || (custom()[qi]?.trim() ?? "") !== "";
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
					options: q.options.map((o) => o.label),
					multi: q.multi ?? false,
					selectedOptions: selected()[qi] ?? [],
					...(customText ? { customInput: customText } : {}),
				};
			}),
		});
	};

	return (
		<form
			onSubmit={(e) => {
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
											<PickerRow
												class="picker-row ask-option"
												classList={{ active: isSelected() }}
												aria-pressed={isSelected()}
												onClick={() => toggle(qi(), opt.label, q.multi ?? false)}
											>
												<span class="ask-marker">
													{isSelected() ? (
														q.multi ? (
															<SquareCheckIcon />
														) : (
															<CircleDotIcon />
														)
													) : q.multi ? (
														<SquareIcon />
													) : (
														<CircleIcon />
													)}
												</span>
												<span class="picker-label">{opt.label}</span>
												{oi() === q.recommended && <span class="ask-recommended">recommended</span>}
												{opt.description && <span class="picker-detail">{opt.description}</span>}
											</PickerRow>
										);
									}}
								</For>
							</div>
							<input
								class="picker-filter ask-custom"
								aria-label="Custom answer"
								placeholder="Other…"
								value={custom()[qi()] ?? ""}
								onInput={(e) => setCustom({ ...custom(), [qi()]: e.currentTarget.value })}
							/>
						</div>
					)}
				</For>
			</div>
			<DialogActions
				onCancel={() => cancelUiRequest(props.id)}
				onPrimary={submit}
				primaryLabel="Submit"
				primaryDisabled={!allAnswered()}
			/>
		</form>
	);
};
