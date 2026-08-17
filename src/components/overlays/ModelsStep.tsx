import { For, onMount, type Component } from "solid-js";
import type { ModelInfo, ModelRoleCatalogEntry } from "../../../shared/protocol";
import { formatCtx } from "../../model-options";
import { ArrowLeftIcon } from "../shared/icons";
import { PickerRow } from "../shared/PickerRow";

/**
 * Step 2 of the model-role wizard: fuzzy-filtered, provider-grouped model
 * list for the picked role. The filter input is controlled by ModelModal
 * (its value survives back-navigation), and the grouped list is the
 * createMemo living in ModelModal. Picking a row is handed up via
 * onPickModel so ModelModal can decide between the thinking step and a
 * direct commit.
 */
export const ModelsStep: Component<{
	role: ModelRoleCatalogEntry | undefined;
	filter: string;
	onFilterChange: (value: string) => void;
	groups: Array<[string, ModelInfo[]]>;
	onBack: () => void;
	onPickModel: (m: ModelInfo) => void;
}> = (props) => {
	let input!: HTMLInputElement;

	// The filter mounts when the model step opens; focus it after the step
	// change flushes so typing filters immediately.
	onMount(() => input?.focus());

	return (
		<>
			<div class="picker-group-head">
				<button class="picker-back" onClick={props.onBack}>
					<ArrowLeftIcon /> roles
				</button>
			</div>
			<input
				class="picker-filter"
				ref={input}
				aria-label="Filter models"
				placeholder="Filter models…"
				value={props.filter}
				onInput={(e) => props.onFilterChange(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						const first = props.groups[0]?.[1][0];
						if (first) props.onPickModel(first);
					}
				}}
			/>
			<div class="picker-list">
				<For each={props.groups}>
					{([provider, models]) => (
						<div class="picker-group">
							<div class="picker-group-name">{provider}</div>
							<For each={models}>
								{(m) => (
									<PickerRow
										class="picker-row"
										classList={{
											active: props.role?.provider === m.provider && props.role?.id === m.id,
										}}
										aria-pressed={props.role?.provider === m.provider && props.role?.id === m.id}
										onClick={() => props.onPickModel(m)}
									>
										<span class="picker-label">{m.id}</span>
										{m.reasoning && <span class="picker-chip">reasoning</span>}
										{formatCtx(m.contextWindow) && (
											<span class="picker-meta">{formatCtx(m.contextWindow)}</span>
										)}
									</PickerRow>
								)}
							</For>
						</div>
					)}
				</For>
			</div>
		</>
	);
};
