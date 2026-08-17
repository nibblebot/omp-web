import { For, type Component } from "solid-js";
import type { ModelInfo, ModelRoleCatalogEntry } from "../../../shared/protocol";
import { thinkingOptions } from "../../usage/model-options";
import { ArrowLeftIcon } from "../shared/icons";
import { PickerRow } from "../shared/PickerRow";

/**
 * Step 3 of the model-role wizard: thinking level for a reasoning model
 * ("inherit" / "off" / the model's effort ladder, TUI labels). Selecting a
 * level commits the role assignment with the level baked into the role
 * value via onSelect; ModelModal closes the wizard.
 */
export const ThinkingStep: Component<{
	role: ModelRoleCatalogEntry | undefined;
	model: ModelInfo | undefined;
	onBack: () => void;
	onSelect: (value: string) => void;
}> = (props) => {
	return (
		<>
			<div class="picker-group-head">
				<button class="picker-back" onClick={props.onBack}>
					<ArrowLeftIcon /> model
				</button>
			</div>
			<div class="picker-list">
				<For
					each={thinkingOptions(props.model?.thinking?.efforts as readonly string[] | undefined)}
				>
					{(opt) => (
						<PickerRow
							class="picker-row"
							classList={{ active: (props.role?.thinkingLevel ?? "inherit") === opt.value }}
							aria-pressed={(props.role?.thinkingLevel ?? "inherit") === opt.value}
							onClick={() => props.onSelect(opt.value)}
						>
							<span class="picker-label">{opt.label}</span>
							{opt.hint && <span class="picker-meta">{opt.hint}</span>}
						</PickerRow>
					)}
				</For>
			</div>
		</>
	);
};
