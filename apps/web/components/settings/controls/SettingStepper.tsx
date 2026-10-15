import { createEffect, createSignal, on, Show, type Component } from "solid-js";
import {
	numberUnit,
	numericOptionValue,
	optionStep,
	parseNumberInput,
	stepNumber,
} from "../../../prefs/setting-controls";
import type { SettingsOption } from "#lib/wire/protocol";
import { MinusIcon, PlusIcon } from "../../ui/icons";

/**
 * Minus, value, plus. With `options` it walks the option list (`default` is -1)
 * and shows the option label. Without them it is a typed number with a unit
 * taken from the path. Either way it writes a number, never a string.
 *
 * A step shows its result at once, so rapid clicks step from each other; the
 * model value takes over again when it changes.
 */
export const SettingStepper: Component<{
	label: string;
	path: string;
	/** Stored value; a number, or a string form of one. */
	value: unknown;
	options?: SettingsOption[];
	disabled?: boolean;
	/** Resolves true when the write is applied, false when it failed; a failure reverts the step. */
	onChange: (value: number) => Promise<boolean>;
}> = (props) => {
	const stored = (): number | undefined =>
		typeof props.value === "number" ? props.value : numericOptionValue(String(props.value ?? ""));
	const [pending, setPending] = createSignal<number | undefined>(undefined);
	createEffect(
		on(
			() => props.value,
			() => setPending(undefined),
			{ defer: true },
		),
	);
	const current = () => pending() ?? stored();
	// The latest write owns the pending value: an older failure must not undo a newer step.
	let latestWrite = 0;
	const write = (value: number) => {
		const id = ++latestWrite;
		setPending(value);
		void props.onChange(value).then((ok) => {
			if (!ok && id === latestWrite) setPending(undefined);
		});
	};

	const step = () => {
		const n = current();
		if (n === undefined || !props.options) return undefined;
		return optionStep(props.options, n);
	};
	const stepTo = (direction: -1 | 1) => {
		const n = current();
		if (n === undefined) return;
		if (props.options) {
			const target = direction < 0 ? step()?.previous : step()?.next;
			if (target) write(numericOptionValue(target.value)!);
			return;
		}
		write(stepNumber(n, direction));
	};
	const atEdge = (direction: -1 | 1) => {
		if (props.options) {
			return direction < 0 ? !step()?.previous : !step()?.next;
		}
		return false;
	};

	const unit = () => numberUnit(props.path);
	const [draft, setDraft] = createSignal("");
	createEffect(() => setDraft(current() === undefined ? "" : String(current())));
	const commitDraft = () => {
		const n = parseNumberInput(draft());
		if (n === undefined || n === current()) {
			setDraft(current() === undefined ? "" : String(current()));
			return;
		}
		write(n);
	};

	return (
		<span class="settings-stepper" classList={{ typed: !props.options }}>
			<button
				type="button"
				class="settings-stepper-btn"
				aria-label={`Decrease ${props.label}`}
				disabled={props.disabled || current() === undefined || atEdge(-1)}
				onClick={() => stepTo(-1)}
			>
				<MinusIcon />
			</button>
			<Show
				when={props.options}
				fallback={
					<span class="settings-stepper-number">
						<input
							type="number"
							aria-label={props.label}
							value={draft()}
							disabled={props.disabled}
							onInput={(e) => setDraft(e.currentTarget.value)}
							onChange={commitDraft}
						/>
						<Show when={unit()}>
							<span class="settings-stepper-unit">{unit()}</span>
						</Show>
					</span>
				}
			>
				<span class="settings-stepper-value" aria-live="polite">
					{step()?.text ?? String(props.value ?? "")}
				</span>
			</Show>
			<button
				type="button"
				class="settings-stepper-btn"
				aria-label={`Increase ${props.label}`}
				disabled={props.disabled || current() === undefined || atEdge(1)}
				onClick={() => stepTo(1)}
			>
				<PlusIcon />
			</button>
		</span>
	);
};
