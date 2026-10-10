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

/**
 * A broken variant shows its error inline and cannot blank the page. `close`
 * unmounts the variant behind a Reopen button; `reopen` (exclusive mode)
 * re-seeds and remounts the frame, otherwise Reopen just renders it again.
 */
const VariantFrame: Component<{ variant: StoryVariant; reopen?: () => void }> = (props) => {
	const [closed, setClosed] = createSignal(false);
	const reopen = () => (props.reopen ? props.reopen() : setClosed(false));
	return (
		<section class="ds-variant">
			<header class="ds-variant-head">
				<h3 class="ds-variant-name">{props.variant.name}</h3>
				<Show when={props.variant.description}>
					<p class="ds-variant-desc">{props.variant.description}</p>
				</Show>
			</header>
			<div class="ds-variant-body">
				<Show
					when={!closed()}
					fallback={
						<div class="ds-closed">
							<span>Closed.</span>
							<button type="button" onClick={reopen}>
								Reopen
							</button>
						</div>
					}
				>
					<ErrorBoundary
						fallback={(err: unknown) => (
							<pre class="ds-error">
								{err instanceof Error ? (err.stack ?? err.message) : String(err)}
							</pre>
						)}
					>
						{props.variant.render({ close: () => setClosed(true) })}
					</ErrorBoundary>
				</Show>
			</div>
		</section>
	);
};

/**
 * One story. The store is global, so seeding is per story: unseeded variants
 * stack under the story seed; if any variant carries its own seed (or the story
 * sets `tabs`), tabs show one at a time and every switch, re-click of the
 * active tab, or Reopen resets and re-seeds before rendering.
 */
export const StoryView: Component<{ entry: StoryEntry }> = (props) => {
	const story = () => props.entry.story;
	const exclusive = createMemo(
		() => story().tabs === true || story().variants.some((v) => v.seed !== undefined),
	);
	const [selected, setSelected] = createSignal(0);
	// Bumped on every tab click and Reopen so the keyed Show below remounts
	// (and re-seeds) even when the selected variant is unchanged.
	const [run, setRun] = createSignal(0);
	const replay = () => setRun((n) => n + 1);
	const active = createMemo(() => ({
		variant: story().variants[selected()] ?? story().variants[0],
		run: run(),
	}));
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
								onClick={() => {
									setSelected(index());
									replay();
								}}
							>
								{variant.name}
							</button>
						)}
					</For>
				</div>
				<Show when={active()} keyed>
					{({ variant }) => {
						applySeeds(story().seed, variant.seed);
						return <VariantFrame variant={variant} reopen={replay} />;
					}}
				</Show>
			</Show>
		</article>
	);
};
