import { createSignal } from "solid-js";
import {
	AutocompletePopup,
	type AcItem,
} from "../../../../web/components/chat/composer/AutocompletePopup";
import {
	fileMentionItems,
	longSlashCommandItems,
	slashCommandItems,
} from "../../../fixtures/composer";
import { defineStory } from "../../../registry";

/**
 * The popup is absolutely positioned above its `.prompt-input` anchor, the same
 * element the composer uses. The spacer leaves room above the anchor so the
 * popup (max 300px) stays inside the frame.
 */
const anchorOffset = { "margin-top": "320px" };

/** Holds the highlighted row so hovering moves the selection like the composer does. */
function Picker(props: { items: AcItem[]; initial: number; listId: string }) {
	const [selected, setSelected] = createSignal(props.initial);
	return (
		<div class="ds-frame">
			<div class="prompt-input" style={anchorOffset}>
				<AutocompletePopup
					items={props.items}
					selected={selected()}
					onHover={setSelected}
					onApply={() => {}}
					listId={props.listId}
				/>
			</div>
		</div>
	);
}

export default defineStory({
	id: "chat-composer-autocomplete-popup",
	title: "AutocompletePopup",
	component: {
		file: "apps/web/components/chat/composer/AutocompletePopup.tsx",
		export: "AutocompletePopup",
	},
	variants: [
		{
			name: "Slash commands",
			description: "Command completions after typing / in the composer.",
			render: () => <Picker items={slashCommandItems} initial={1} listId="ds-ac-commands" />,
		},
		{
			name: "File mentions",
			description: "@-file completions while referencing repo paths.",
			render: () => <Picker items={fileMentionItems} initial={0} listId="ds-ac-files" />,
		},
		{
			name: "Long list",
			description: "A full command list that scrolls, with the selection near the bottom.",
			render: () => <Picker items={longSlashCommandItems} initial={9} listId="ds-ac-long" />,
		},
	],
});
