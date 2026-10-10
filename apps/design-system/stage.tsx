import {
	createMemo,
	createSignal,
	ErrorBoundary,
	For,
	Show,
	type Component,
	type JSX,
} from "solid-js";
import type { StoryEntry } from "./catalog";
import { StoryMeta } from "./meta";
import type { Story, StoryVariant } from "./registry";
import { applySeeds } from "./seed";

/** A broken variant shows its error inline and cannot blank the page. */
const VariantFrame: Component<{ variant: StoryVariant }> = (props) => (
	<section class="ds-variant">
		<header class="ds-variant-head">
			<h3 class="ds-variant-name">{props.variant.name}</h3>
			<Show when={props.variant.description}>
				<p class="ds-variant-desc">{props.variant.description}</p>
			</Show>
		</header>
		<div class="ds-variant-body">
			<ErrorBoundary
				fallback={(err: unknown) => (
					<pre class="ds-error">
						{err instanceof Error ? (err.stack ?? err.message) : String(err)}
					</pre>
				)}
			>
				{props.variant.render()}
			</ErrorBoundary>
		</div>
	</section>
);

/**
 * One story. The store is global, so seeding is per story: unseeded variants
 * stack under the story seed; if any variant carries its own seed (or the story
 * sets `tabs`), tabs show one at a time and every switch resets and re-seeds
 * before rendering.
 */
export const StoryView: Component<{ entry: StoryEntry }> = (props) => {
	const story = () => props.entry.story;
	const exclusive = createMemo(
		() => story().tabs === true || story().variants.some((v) => v.seed !== undefined),
	);
	const [selected, setSelected] = createSignal(0);
	const active = createMemo(() => story().variants[selected()] ?? story().variants[0]);
	// Seeding runs inside the keyed callbacks, after the previous subtree is
	// disposed and before the new one renders.
	const stacked = (story: Story): JSX.Element => {
		applySeeds(story.seed);
		return <For each={story.variants}>{(variant) => <VariantFrame variant={variant} />}</For>;
	};
	return (
		<article class="ds-story" id={`story-${story().id}`}>
			<header class="ds-story-head">
				<h2 class="ds-story-title">
					<a href={`#/${story().id}`}>{story().title}</a>
				</h2>
			</header>
			<StoryMeta entry={props.entry} />
			<Show
				when={exclusive()}
				fallback={
					<Show when={story()} keyed>
						{(story) => stacked(story)}
					</Show>
				}
			>
				<div class="ds-tabs" role="tablist">
					<For each={story().variants}>
						{(variant, index) => (
							<button
								type="button"
								role="tab"
								class="ds-tab"
								aria-selected={selected() === index()}
								onClick={() => setSelected(index())}
							>
								{variant.name}
							</button>
						)}
					</For>
				</div>
				<Show when={active()} keyed>
					{(variant) => {
						applySeeds(story().seed, variant.seed);
						return <VariantFrame variant={variant} />;
					}}
				</Show>
			</Show>
		</article>
	);
};
