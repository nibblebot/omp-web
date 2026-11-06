import { createSignal, ErrorBoundary, onMount, Show, type Component } from "solid-js";
import {
	createPromptCacheIndicator,
	promptCacheView,
	watchPromptCache,
} from "../../../store/prompt-cache";
import { DatabaseIcon } from "../../ui/icons";
import { lazyComponent } from "../../ui/lazy";
import { StatusSegment } from "./StatusSegment";

/** The popover loads with its own chunk: fetched when the chip is approached or opened, never with the entry. */
const PromptCachePopover = lazyComponent(() =>
	import("./PromptCachePopover").then((module) => module.PromptCachePopover),
);

/** A popover whose chunk failed to load closes itself; the chip's next click tries the fetch again. */
const ClosePopover: Component<{ onClose: () => void }> = (props) => {
	onMount(props.onClose);
	return null;
};

/** Start fetching the popover on the chip's first pointer or keyboard approach; a failure surfaces on open. */
const preloadOnApproach = (chip: HTMLElement): void => {
	const preload = () => void PromptCachePopover.preload().catch(() => undefined);
	chip.addEventListener("pointerenter", preload, { once: true });
	chip.addEventListener("focus", preload, { once: true });
};

/** The chip itself: mounted only while the session reports a cache, so its clock runs only then. */
const CacheChip: Component = () => {
	const indicator = createPromptCacheIndicator();
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(false);
	const title = () => {
		const brief = promptCacheView()?.brief;
		return brief ? `${brief[0]} · ${brief[1]}` : "Prompt cache";
	};
	return (
		<Show when={indicator()}>
			{(current) => (
				<>
					<StatusSegment
						class="cache-segment"
						dataLevel={current().tone}
						ref={(el) => {
							setAnchor(el);
							preloadOnApproach(el);
						}}
						popover={{ expanded: open() }}
						onClick={() => setOpen(!open())}
						title={title()}
						ariaLabel={`Prompt cache: ${current().label}`}
					>
						<DatabaseIcon />
						<span class="cache-label">{current().label}</span>
					</StatusSegment>
					<Show when={open() ? anchor() : undefined}>
						{(el) => (
							<ErrorBoundary fallback={() => <ClosePopover onClose={() => setOpen(false)} />}>
								<PromptCachePopover
									anchor={el()}
									cold={current().tone === "cold"}
									onClose={() => setOpen(false)}
								/>
							</ErrorBoundary>
						)}
					</Show>
				</>
			)}
		</Show>
	);
};

/**
 * The prompt-cache indicator beside the context usage: warm, likely warm (inferred from a reopened
 * transcript) or cold, with a popover of the session's own explanation. Hidden while the session has no cache
 * to report, or predates the call. Owns keeping the status current (`watchPromptCache`).
 */
export const PromptCacheSegment: Component = () => {
	watchPromptCache();
	return (
		<Show when={promptCacheView()}>
			<CacheChip />
		</Show>
	);
};
