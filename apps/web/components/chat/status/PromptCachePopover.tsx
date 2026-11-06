import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { promptCacheView, refreshPromptCache } from "../../../store/prompt-cache";
import { Popover } from "../../ui/Popover";

/**
 * What the next message finds in the prompt cache, above the bar's cache chip: the session's own two-line
 * brief and its detail rows (the SDK words both; the browser carries no copy of the rules). Opening it reads
 * the status again so the rows are current. `cold` colors the head line like the chip.
 */
export const PromptCachePopover: Component<{
	anchor: HTMLElement;
	cold: boolean;
	onClose: () => void;
}> = (props) => {
	const [refreshing, setRefreshing] = createSignal(true);
	onMount(() => {
		void refreshPromptCache().finally(() => setRefreshing(false));
	});
	return (
		<Popover
			anchor={props.anchor}
			onClose={props.onClose}
			label="Prompt cache"
			class="cache-popover"
			width={340}
		>
			<Show when={promptCacheView()}>
				{(shown) => (
					<div class="cache-popover-body" aria-busy={refreshing()}>
						<p class="cache-popover-head" classList={{ "is-cold": props.cold }}>
							{shown().brief[0]}
						</p>
						<p class="cache-popover-next">{shown().brief[1]}</p>
						<dl class="cache-popover-rows">
							<For each={shown().details}>
								{(row) => (
									<div class="cache-popover-row">
										<dt>{row.label}</dt>
										<dd data-tone={row.tone}>{row.value}</dd>
									</div>
								)}
							</For>
						</dl>
					</div>
				)}
			</Show>
		</Popover>
	);
};
