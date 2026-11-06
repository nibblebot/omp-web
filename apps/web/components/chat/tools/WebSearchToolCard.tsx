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

/** A provider that failed before another answered (or before the search gave up): the SDK's `SearchFailureDetail`. */
export interface SearchFailure {
	/** Display name: the SDK's `label`, or the provider id when the label is missing. */
	label: string;
	reason: string;
	/** HTTP-style status the provider error carried; absent when it had none. */
	status?: number;
}

/** The failed providers a web_search result records in `details.failures`. Entries without a provider name are dropped; any other shape yields none. */
export function searchFailures(details: unknown): SearchFailure[] {
	if (typeof details !== "object" || details === null || !("failures" in details)) return [];
	const raw = details.failures;
	if (!Array.isArray(raw)) return [];
	const out: SearchFailure[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const label: unknown = "label" in entry ? entry.label : undefined;
		const provider: unknown = "provider" in entry ? entry.provider : undefined;
		const reason: unknown = "reason" in entry ? entry.reason : undefined;
		const status: unknown = "status" in entry ? entry.status : undefined;
		const name = [label, provider].find(
			(v): v is string => typeof v === "string" && v.trim() !== "",
		);
		if (name === undefined) continue;
		out.push({
			label: name.trim(),
			reason: typeof reason === "string" ? reason.trim() : "",
			...(typeof status === "number" && Number.isInteger(status) ? { status } : {}),
		});
	}
	return out;
}

/** web_search: link list when the output carries URLs; generic card otherwise. A result that records failed providers keeps its own card so they show. */
export const WebSearchToolCard: Component<{ item: ToolItem }> = (props) => {
	const query = () => (props.item.args as { query?: string } | null)?.query ?? "";
	const notes = () => splitSearchNotes(props.item.output).notes;
	const urls = () => searchResultUrls(props.item.output);
	const failures = () => searchFailures(props.item.details);
	return (
		<Show
			when={props.item.status === "running" || urls().length > 0 || failures().length > 0}
			fallback={<GenericToolCard item={props.item} />}
		>
			<ToolCardShell
				name="web_search"
				arg={query()}
				status={props.item.status}
				class="websearch-tool"
				meta={
					<Show when={failures().length > 0}>
						<span class="websearch-failed-count" title="Providers that failed">
							{failures().length} failed
						</span>
					</Show>
				}
			>
				<div class="websearch-body">
					<For each={notes()}>{(note) => <div class="search-note">{note}</div>}</For>
					<Show when={urls().length === 0 && props.item.output}>
						<pre class="websearch-output">{props.item.output}</pre>
					</Show>
					<For each={urls()}>
						{(url) => (
							<a class="websearch-link" href={url} target="_blank" rel="noreferrer">
								{url}
							</a>
						)}
					</For>
					<Show when={failures().length > 0}>
						<ul class="websearch-failures" aria-label="Failed providers">
							<For each={failures()}>
								{(failure) => (
									<li class="websearch-failure">
										<span class="websearch-failure-provider">{failure.label}</span>
										<Show when={failure.status !== undefined}>
											<span class="websearch-failure-status">{failure.status}</span>
										</Show>
										<Show when={failure.reason}>
											<span class="websearch-failure-reason">{failure.reason}</span>
										</Show>
									</li>
								)}
							</For>
						</ul>
					</Show>
				</div>
			</ToolCardShell>
		</Show>
	);
};
