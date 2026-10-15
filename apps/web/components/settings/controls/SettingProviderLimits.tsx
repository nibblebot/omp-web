import { createSignal, For, Show, type Component } from "solid-js";
import { applyProviderLimit, asRecord } from "../../../prefs/setting-controls";
import { SettingTextField } from "./SettingTextField";

/**
 * Per-provider in-flight request limits. The row shows "Edit…" which expands
 * one number input per provider inline; an empty input removes that limit.
 */
export const SettingProviderLimits: Component<{
	label: string;
	value: unknown;
	providers: string[];
	disabled?: boolean;
	onCommit: (value: Record<string, unknown>) => void;
}> = (props) => {
	const [open, setOpen] = createSignal(false);
	let editButton: HTMLButtonElement | undefined;
	const limits = () => asRecord(props.value);
	const setCount = () => props.providers.filter((p) => limits()[p] !== undefined).length;

	return (
		<span
			class="settings-provider-limits"
			data-inline-escape={open() ? "" : undefined}
			ref={(el) =>
				el.addEventListener("keydown", (e) => {
					if (e.key !== "Escape" || !open()) return;
					e.stopPropagation();
					setOpen(false);
					editButton?.focus();
				})
			}
		>
			<span class="settings-json-summary">
				{setCount() === 0 ? "Default" : `${setCount()} set`}
			</span>
			<button
				type="button"
				class="settings-control-btn"
				ref={(el) => (editButton = el)}
				aria-label={`Edit ${props.label}`}
				aria-expanded={open()}
				disabled={props.disabled}
				onClick={() => setOpen(!open())}
			>
				Edit…
			</button>
			<Show when={open()}>
				<span class="settings-provider-limits-list">
					<For each={props.providers}>
						{(provider) => (
							<span class="settings-provider-limit">
								<span class="settings-provider-name">{provider}</span>
								<SettingTextField
									label={`${provider} limit`}
									value={limits()[provider] === undefined ? "" : String(limits()[provider])}
									disabled={props.disabled}
									onCommit={(raw) => props.onCommit(applyProviderLimit(limits(), provider, raw))}
								/>
							</span>
						)}
					</For>
				</span>
			</Show>
		</span>
	);
};
