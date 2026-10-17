import { createSignal, Show, type ParentComponent } from "solid-js";
import { ChevronDownIcon } from "../ui/icons";

/**
 * A settings section: a sentence-case label sitting above a bordered card of
 * rows. The label is outside the card, matching the reference layout.
 *
 * `collapsible` groups fold their card behind a toggle header on narrow
 * viewports (CSS-gated below 768px; wide layouts always show every card), so a
 * long SDK tab reads as a short list of section headers. Groups start folded.
 */
export const SettingsGroup: ParentComponent<{
	title?: string;
	id?: string;
	collapsible?: boolean;
}> = (props) => {
	const [open, setOpen] = createSignal(false);
	return (
		<div
			class="settings-block"
			id={props.id}
			data-collapsible={props.collapsible === true ? "" : undefined}
			data-open={open() ? "" : undefined}
		>
			<Show when={props.title}>
				<h3 class="settings-group-title">
					<Show when={props.collapsible === true} fallback={props.title}>
						<button
							type="button"
							class="settings-group-toggle"
							aria-expanded={open()}
							onClick={() => setOpen(!open())}
						>
							<span>{props.title}</span>
							<ChevronDownIcon class="settings-group-caret" />
						</button>
					</Show>
				</h3>
			</Show>
			<div class="settings-group">{props.children}</div>
		</div>
	);
};
