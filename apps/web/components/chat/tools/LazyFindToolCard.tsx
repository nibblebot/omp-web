import { createSignal, ErrorBoundary, Show, type Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { lazyComponent } from "../../ui/lazy";
import { GenericToolCard } from "./GenericToolCard";

/** The find card and its view code load with their own chunk, not with the entry. */
const FindToolCard = lazyComponent<{ item: ToolItem }>(() =>
	import("./FindToolCard").then((module) => module.FindToolCard),
);

/**
 * find's renderer. The row is a generic card until the find card's chunk arrives (so it always has a
 * card root to jump to and scroll by), then the real card replaces it. Should the chunk fail to
 * load, or the card throw, the generic card stays.
 */
export const LazyFindToolCard: Component<{ item: ToolItem }> = (props) => {
	const [loaded, setLoaded] = createSignal(false);
	FindToolCard.preload().then(
		() => setLoaded(true),
		() => undefined,
	);
	return (
		<ErrorBoundary fallback={() => <GenericToolCard item={props.item} />}>
			<Show when={loaded()} fallback={<GenericToolCard item={props.item} />}>
				<FindToolCard item={props.item} />
			</Show>
		</ErrorBoundary>
	);
};
