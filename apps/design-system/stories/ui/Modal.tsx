import { For, type Component } from "solid-js";
import { Markdown } from "../../../web/components/ui/Markdown";
import { createModalLayer, Modal, ModalLayerContext } from "../../../web/components/ui/Modal";
import { PickerRow } from "../../../web/components/ui/PickerRow";
import { markdownLong, pickerModels } from "../../fixtures/shared";
import { defineStory } from "../../registry";

/**
 * A side sheet inside the same layer ModalHost provides: it slides in on mount
 * and slides out on close (Esc, scrim, close button), and `close` (the
 * stage's dismiss) runs once the exit has ended.
 */
const SideSheet: Component<{ close: () => void }> = (props) => {
	const layer = createModalLayer(props.close);
	return (
		<ModalLayerContext.Provider value={layer}>
			<Modal title="Session stats" variant="sheet" onClose={layer.close}>
				<dl class="ds-meta">
					<div class="ds-meta-row">
						<dt>Turns</dt>
						<dd>64</dd>
					</div>
					<div class="ds-meta-row">
						<dt>Tool calls</dt>
						<dd>142</dd>
					</div>
					<div class="ds-meta-row">
						<dt>Tokens</dt>
						<dd>1,284,310</dd>
					</div>
					<div class="ds-meta-row">
						<dt>Subagents</dt>
						<dd>8</dd>
					</div>
				</dl>
			</Modal>
		</ModalLayerContext.Provider>
	);
};

export default defineStory({
	id: "ui-modal",
	title: "Modal",
	component: { file: "apps/web/components/ui/Modal.tsx", export: "Modal" },
	tabs: true,
	variants: [
		{
			name: "Titled picker",
			description: "A titled dialog holding a picker list, as the model picker uses it.",
			render: (ctx) => (
				<Modal title="Switch model" onClose={ctx.close}>
					<div class="picker-list">
						<For each={pickerModels.slice(0, 3)}>
							{(model) => (
								<PickerRow class="picker-row" aria-selected={model.id === pickerModels[0].id}>
									<span class="picker-label">{model.label}</span>
									{model.chip && <span class="picker-chip">{model.chip}</span>}
									<span class="picker-meta">{model.meta}</span>
								</PickerRow>
							)}
						</For>
					</div>
				</Modal>
			),
		},
		{
			name: "Side sheet",
			description:
				'variant="sheet" anchors the dialog to the right edge at full height. It slides in from the right and back out when closed; Reopen replays the slide-in.',
			render: (ctx) => <SideSheet close={ctx.close} />,
		},
		{
			name: "Aria-labelled, no title",
			description: "Without a title, the dialog takes its accessible name from ariaLabel.",
			render: (ctx) => (
				<Modal ariaLabel="Keyboard shortcuts" onClose={ctx.close}>
					<p class="picker-note">Esc closes this dialog. Tab cycles through its controls.</p>
				</Modal>
			),
		},
		{
			name: "Long content",
			description:
				"Long markdown inside the dialog, to check that the body scrolls under the title.",
			render: (ctx) => (
				<Modal title="Transport review" onClose={ctx.close}>
					<Markdown src={markdownLong} />
				</Modal>
			),
		},
	],
});
