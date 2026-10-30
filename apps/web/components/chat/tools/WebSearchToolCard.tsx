import { For, Show, type Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { GenericToolCard } from "./GenericToolCard";
import { ToolCardShell } from "./ToolCardShell";

const URL_RE = /https?:\/\/[^\s)"'<>]+/g;
const NOTE_RE = /^Note: /;

/** The SDK leads a result with `Note: ...` lines (a fallback provider answered; a constraint was relaxed).
 *  They quote failure reasons that carry URLs, so they are split off before links are read. */
export function splitSearchNotes(output: string): { notes: string[]; body: string } {
	const lines = output.split("\n");
	let count = 0;
	while (count < lines.length && NOTE_RE.test(lines[count]!)) count++;
	return {
		notes: lines.slice(0, count).map((line) => line.slice("Note: ".length)),
		body: lines.slice(count).join("\n"),
	};
}

/** The distinct result URLs of a web_search output, leading notes excluded. */
export function searchResultUrls(output: string): string[] {
	return [...new Set(splitSearchNotes(output).body.match(URL_RE) ?? [])];
}

/** web_search: link list when the output carries URLs; generic card otherwise. */
export const WebSearchToolCard: Component<{ item: ToolItem }> = (props) => {
	const query = () => (props.item.args as { query?: string } | null)?.query ?? "";
	const notes = () => splitSearchNotes(props.item.output).notes;
	const urls = () => searchResultUrls(props.item.output);
	return (
		<Show
			when={props.item.status === "running" || urls().length > 0}
			fallback={<GenericToolCard item={props.item} />}
		>
			<ToolCardShell
				name="web_search"
				arg={query()}
				status={props.item.status}
				class="websearch-tool"
			>
				<div class="websearch-body">
					<For each={notes()}>{(note) => <div class="search-note">{note}</div>}</For>
					<For each={urls()}>
						{(url) => (
							<a class="websearch-link" href={url} target="_blank" rel="noreferrer">
								{url}
							</a>
						)}
					</For>
				</div>
			</ToolCardShell>
		</Show>
	);
};
