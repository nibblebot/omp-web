import { createMemo, For, Match, Show, Switch, type Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { pushToast } from "../../../store/toasts";
import { copyText } from "../../../text/clipboard";
import { highlightLines, languageForPath } from "../../../text/highlight";
import { HighlightedLine } from "./HighlightedLine";
import { parseGrepOutput, type SearchRow } from "./search-view";
import { ToolCardShell } from "./ToolCardShell";

type HitRow = Extract<SearchRow, { kind: "line" }>;
type ShownRow = SearchRow & { html?: string | null };

/** Copy a path (or path:line) and confirm it: the result lines show no copy affordance, so a tap needs visible feedback. */
const copy = (text: string) =>
	void copyText(text).then((ok) =>
		pushToast(ok ? `Copied ${text}` : "Could not copy to the clipboard", { durationMs: 2_000 }),
	);

/**
 * Highlight each run of adjacent hit lines of one file together (so a block
 * comment spanning context lines colors right); a gap, header or note ends the
 * run, so snippets from distant parts of a file never share lexer state.
 */
function withHighlight(rows: SearchRow[]): ShownRow[] {
	const out: ShownRow[] = rows.map((row) => ({ ...row }));
	let run: number[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const first = out[run[0]] as HitRow;
		const html = first.path
			? highlightLines(
					run.map((i) => (out[i] as HitRow).text).join("\n"),
					languageForPath(first.path),
				)
			: null;
		run.forEach((index, k) => {
			out[index].html = html?.[k] ?? null;
		});
		run = [];
	};
	for (let i = 0; i < out.length; i++) {
		const row = out[i];
		if (row.kind !== "line") {
			flush();
			continue;
		}
		const prev = run.length > 0 ? (out[run[run.length - 1]] as HitRow) : undefined;
		if (prev && (prev.path !== row.path || prev.no + 1 !== row.no)) flush();
		run.push(i);
	}
	flush();
	return out;
}

/**
 * grep/glob: monospace result lines. grep hits are grouped under copyable file
 * paths with line numbers and syntax-highlighted code; glob lists plain paths.
 */
export const SearchToolCard: Component<{ item: ToolItem }> = (props) => {
	const args = () =>
		props.item.args as { pattern?: string; query?: string; glob?: string; path?: string } | null;
	const summary = () => args()?.pattern ?? args()?.query ?? args()?.glob ?? "";
	const plainLines = () => props.item.output.split("\n").filter((l) => l.length > 0);
	const grepRows = createMemo(() =>
		props.item.name === "grep" && props.item.status !== "error"
			? withHighlight(parseGrepOutput(props.item.output, args()?.path))
			: null,
	);
	return (
		<ToolCardShell
			name={props.item.name}
			arg={summary()}
			status={props.item.status}
			class="search-tool"
		>
			<div class="search-body" title="Wheel scrolls the session; Alt+wheel scrolls these results">
				<Show
					when={grepRows()}
					fallback={
						<For each={plainLines()}>{(line) => <div class="search-line">{line}</div>}</For>
					}
				>
					{(rows) => (
						<For each={rows()}>
							{(row) => (
								<Switch>
									<Match when={row.kind === "file" && row}>
										{(file) => (
											<div class="search-line search-file">
												<button
													class="search-path"
													title="Copy path"
													onClick={() => copy(file().path)}
												>
													{file().path}
												</button>
											</div>
										)}
									</Match>
									<Match when={row.kind === "line" && row}>
										{(hit) => <SearchHit row={hit()} html={hit().html ?? null} />}
									</Match>
									<Match when={row.kind === "gap"}>
										<div class="search-gap">…</div>
									</Match>
									<Match when={row.kind === "text" && row}>
										{(note) => <div class="search-line search-note">{note().text}</div>}
									</Match>
								</Switch>
							)}
						</For>
					)}
				</Show>
			</div>
		</ToolCardShell>
	);
};

const SearchHit: Component<{ row: HitRow; html: string | null }> = (props) => (
	<div class="search-line search-hit" data-match={props.row.mark}>
		<Show when={props.row.path} fallback={<span class="search-no">{props.row.no}</span>}>
			{(path) => (
				<button
					class="search-no"
					title="Copy path:line"
					onClick={() => copy(`${path()}:${props.row.no}`)}
				>
					{props.row.no}
				</button>
			)}
		</Show>
		<span class="search-text">
			<HighlightedLine html={props.html} text={props.row.text} />
		</span>
		<Show when={props.row.col}>
			<span class="search-col"> col {props.row.col}</span>
		</Show>
	</div>
);
