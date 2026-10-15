import { Show, type ParentComponent } from "solid-js";

/**
 * A settings section: a sentence-case label sitting above a bordered card of
 * rows. The label is outside the card, matching the reference layout.
 */
export const SettingsGroup: ParentComponent<{ title?: string; id?: string }> = (props) => (
	<div class="settings-block" id={props.id}>
		<Show when={props.title}>
			<h3 class="settings-group-title">{props.title}</h3>
		</Show>
		<div class="settings-group">{props.children}</div>
	</div>
);
