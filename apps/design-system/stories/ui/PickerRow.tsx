import { For, Show, type JSX } from "solid-js";
import { PickerRow } from "../../../web/components/ui/PickerRow";
import { pickerModels } from "../../fixtures/shared";
import { defineStory } from "../../registry";

/** The model picker list: one PickerRow per model, with the first row selected. */
function modelRows(selectedId: string): JSX.Element {
	return (
		<div class="picker-list">
			<For each={pickerModels}>
				{(model) => (
					<PickerRow
						class="picker-row"
						title={model.id}
						aria-selected={model.id === selectedId}
						onClick={() => undefined}
					>
						<span class="picker-label">{model.label}</span>
						<Show when={model.chip}>
							<span class="picker-chip">{model.chip}</span>
						</Show>
						<span class="picker-meta">{model.meta}</span>
						<Show when={model.detail}>
							<span class="picker-detail">{model.detail}</span>
						</Show>
					</PickerRow>
				)}
			</For>
		</div>
	);
}

export default defineStory({
	id: "ui-picker-row",
	title: "PickerRow",
	component: { file: "apps/web/components/ui/PickerRow.tsx", export: "PickerRow" },
	variants: [
		{
			name: "Model list",
			description: "Rows with a label, chip, meta, and detail. The first row is selected.",
			render: () => modelRows(pickerModels[0].id),
		},
		{
			name: "Pressed toggles",
			description: "aria-pressed rows for on/off filter options.",
			render: () => (
				<div class="picker-list">
					<PickerRow class="picker-row" aria-pressed={true} onClick={() => undefined}>
						<span class="picker-label">Show archived sessions</span>
					</PickerRow>
					<PickerRow class="picker-row" aria-pressed={false} onClick={() => undefined}>
						<span class="picker-label">Include subagent transcripts</span>
					</PickerRow>
				</div>
			),
		},
		{
			name: "Disabled",
			description: "A disabled row stays visible but cannot be activated.",
			render: () => (
				<div class="picker-list">
					<PickerRow class="picker-row" disabled title="Requires a fleet connection">
						<span class="picker-label">Use remote worktree</span>
						<span class="picker-meta">fleet only</span>
					</PickerRow>
				</div>
			),
		},
	],
});
