import { For, Show, type Component } from "solid-js";
import type { ToolItem } from "../../state";
import { GenericToolCard } from "./GenericToolCard";
import { ToolShell } from "./ToolShell";

const URL_RE = /https?:\/\/[^\s)"'<>]+/g;

/** web_search: link list when the output carries URLs; generic card otherwise. */
export const WebSearchTool: Component<{ item: ToolItem }> = props => {
	const query = () => (props.item.args as { query?: string } | null)?.query ?? "";
	const urls = () => [...new Set(props.item.output.match(URL_RE) ?? [])];
	return (
		<Show when={props.item.status === "running" || urls().length > 0} fallback={<GenericToolCard item={props.item} />}>
			<ToolShell name={<>web search {query()}</>} status={props.item.status} class="websearch-tool">
				<div class="websearch-body">
					<For each={urls()}>
						{url => (
							<a class="websearch-link" href={url} target="_blank" rel="noreferrer">
								{url}
							</a>
						)}
					</For>
				</div>
			</ToolShell>
		</Show>
	);
};
