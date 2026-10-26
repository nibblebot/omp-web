import { For, Show, type Component } from "solid-js";
import { state } from "../../../state";
import { applyModelPreset, openModelDialog } from "../../../store/models";
import { CheckIcon } from "../../ui/icons";
import { Popover } from "../../ui/Popover";
import { moveRovingFocus, setRovingTabStop } from "../../ui/roving";

/**
 * Preset dropdown above the bar's preset chip: every saved preset with the active one
 * checked (a pick applies it and closes), then "Manage presets…", which opens the Models
 * dialog on its Presets tab. Arrow keys move, Enter picks, Escape closes.
 */
export const ModelPresetPopover: Component<{ anchor: HTMLElement; onClose: () => void }> = (
	props,
) => {
	let listEl: HTMLDivElement | undefined;

	const names = (): readonly string[] => state.modelPresets?.names ?? [];
	const items = (): HTMLButtonElement[] =>
		Array.from(listEl?.querySelectorAll<HTMLButtonElement>("button") ?? []);

	const choose = async (name: string): Promise<void> => {
		if (!(await applyModelPreset(name))) return;
		props.anchor.focus();
		props.onClose();
	};

	const manage = (): void => {
		// The dialog restores focus to whatever held it when it opened: the chip, not an unmounted row.
		props.anchor.focus();
		props.onClose();
		openModelDialog("presets");
	};

	const initialFocus = (): HTMLElement | undefined => {
		const buttons = items();
		const checked = buttons.findIndex((b) => b.getAttribute("aria-pressed") === "true");
		const at = Math.max(0, checked);
		setRovingTabStop(buttons, at);
		return buttons[at];
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		const buttons = items();
		moveRovingFocus(
			e,
			buttons,
			buttons.indexOf(document.activeElement as HTMLButtonElement),
			"vertical",
			true,
		);
	};

	return (
		<Popover
			anchor={props.anchor}
			onClose={props.onClose}
			label="Model presets"
			class="status-menu"
			width={240}
			initialFocus={initialFocus}
		>
			<div
				class="status-menu-list"
				ref={(el) => {
					listEl = el;
				}}
				onKeyDown={onKeyDown}
			>
				<Show
					when={names().length > 0}
					fallback={<p class="status-menu-empty">No saved presets yet.</p>}
				>
					<For each={names()}>
						{(name) => (
							<button
								type="button"
								class="status-menu-item"
								tabindex="-1"
								aria-pressed={name === state.modelPresets?.active}
								onClick={() => void choose(name)}
							>
								<span class="status-menu-check">
									<Show when={name === state.modelPresets?.active}>
										<CheckIcon />
									</Show>
								</span>
								<span class="status-menu-label" title={name}>
									{name}
								</span>
							</button>
						)}
					</For>
				</Show>
				<button
					type="button"
					class="status-menu-item status-menu-manage"
					tabindex="-1"
					onClick={manage}
				>
					<span class="status-menu-label">Manage presets…</span>
				</button>
			</div>
		</Popover>
	);
};
