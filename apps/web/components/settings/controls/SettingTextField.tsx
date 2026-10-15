import { createEffect, createSignal, on, Show, type Component } from "solid-js";

/**
 * Monospace text for URLs, paths and keys. Commits on change (blur or Enter),
 * not per keystroke. An empty value shows "Not set". Secrets are masked until revealed.
 */
export const SettingTextField: Component<{
	label: string;
	value: unknown;
	secret?: boolean;
	disabled?: boolean;
	onCommit: (value: string) => void;
}> = (props) => {
	const stored = () => (typeof props.value === "string" ? props.value : "");
	const [draft, setDraft] = createSignal(stored());
	createEffect(on(stored, (value) => setDraft(value)));
	const [revealed, setRevealed] = createSignal(false);

	return (
		<span class="settings-text-field">
			<input
				type={props.secret && !revealed() ? "password" : "text"}
				class="settings-text-input"
				aria-label={props.label}
				placeholder="Not set"
				value={draft()}
				disabled={props.disabled}
				spellcheck={false}
				autocomplete="off"
				onInput={(e) => setDraft(e.currentTarget.value)}
				onChange={() => {
					if (draft() !== stored()) props.onCommit(draft());
				}}
			/>
			<Show when={props.secret}>
				<button
					type="button"
					class="settings-text-reveal"
					aria-label={`${revealed() ? "Hide" : "Show"} ${props.label}`}
					onClick={() => setRevealed(!revealed())}
				>
					{revealed() ? "Hide" : "Show"}
				</button>
			</Show>
		</span>
	);
};
