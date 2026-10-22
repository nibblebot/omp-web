import { createSignal, Show, type ParentComponent } from "solid-js";
import { ChevronDownIcon } from "../ui/icons";

/**
 * A settings section: a small title above a flat list of rows.
 *
 * `collapsible` groups fold their rows behind a toggle header on narrow
 * viewports (CSS-gated below 768px; wide layouts show every group open), so a
 * long SDK tab reads as a short list of section headers. The "Advanced" group
 * is the exception: it folds on every width, since its rows are rarely wanted.
 * Groups start folded wherever they fold.
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
			data-foldable={props.collapsible === true && props.title === "Advanced" ? "" : undefined}
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
