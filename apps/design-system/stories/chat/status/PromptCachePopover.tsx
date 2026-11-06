import { createSignal, Show } from "solid-js";
import { PromptCachePopover } from "../../../../web/components/chat/status/PromptCachePopover";
import { promptCacheFixture, type PromptCacheFixtureName } from "../../../fixtures/prompt-cache";
import { screenSessionSeed } from "../../../fixtures/screen";
import { answerCalls } from "../../../session";
import { defineStory } from "../../../registry";

/** The session answers `getPromptCacheStatus` with `name`'s fixture. */
const cacheSeed = (name: PromptCacheFixtureName) => () =>
	answerCalls({ getPromptCacheStatus: () => promptCacheFixture(name) });

/** A stand-in for the cache chip that owns the open popover; re-click, Esc and an outside press close it. */
function Anchored(props: { cold: boolean }) {
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(true);
	return (
		<div class="ds-frame ds-frame-bar ds-popover-host" data-x="start">
			<button type="button" ref={setAnchor} aria-expanded={open()} onClick={() => setOpen(!open())}>
				Prompt cache
			</button>
			<Show when={open() ? anchor() : undefined}>
				{(el) => (
					<PromptCachePopover anchor={el()} cold={props.cold} onClose={() => setOpen(false)} />
				)}
			</Show>
		</div>
	);
}

export default defineStory({
	id: "chat-status-prompt-cache-popover",
	title: "PromptCachePopover",
	component: {
		file: "apps/web/components/chat/status/PromptCachePopover.tsx",
		export: "PromptCachePopover",
	},
	// Fixed-position surfaces from several variants would stack over each other.
	tabs: true,
	seed: screenSessionSeed,
	variants: [
		{
			name: "Warm",
			description:
				"Opened above its chip: the session's two-line brief and detail rows, read again on open.",
			seed: cacheSeed("warm"),
			render: () => <Anchored cold={false} />,
		},
		{
			name: "Cold with reason",
			description: "The head line takes the warning tone and says why the prefix is re-sent.",
			seed: cacheSeed("cold"),
			render: () => <Anchored cold />,
		},
	],
});
