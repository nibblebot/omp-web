import { createMemo, For, Show, type Component } from "solid-js";
import { capRows } from "../../../chat/tool-rows";
import type { ToolItem } from "../../../state";
import { pushToast } from "../../../store/toasts";
import { copyText } from "../../../text/clipboard";
import { languageForPath } from "../../../text/highlight";
import {
	accountingLine,
	findCallOf,
	judgedLabel,
	parseFindDetails,
	rangeLabel,
	scoreTone,
	timeoutProgress,
	type FindHit,
	type FindView,
} from "./find-view";
import { HighlightedText } from "./HighlightedText";
import { createRowExpansion, toolRowCap, ToolCardShell } from "./ToolCardShell";

/** Cells in a hit's score gauge. */
const GAUGE_CELLS = 6;
/** Ranges shown under each hit, strongest first. */
const RANGES_PER_HIT = 3;

/** Copy a path (or path:lines) and confirm it, as the grep card does. */
const copy = (text: string) =>
	void copyText(text).then((ok) =>
		pushToast(ok ? `Copied ${text}` : "Could not copy to the clipboard", { durationMs: 2_000 }),
	);

/** The latest progress message of a running call (the tool reports the phase it is in). */
const lastLine = (output: string): string =>
	output
		.split("\n")
		.map((line) => line.trim())
		.findLast((line) => line.length > 0) ?? "";

const ScoreGauge: Component<{ score: number }> = (props) => {
	const filled = () => Math.round(props.score * GAUGE_CELLS);
	return (
		<span
			class="find-gauge"
			data-tone={scoreTone(props.score)}
			role="img"
			aria-label={`score ${props.score.toFixed(2)}`}
		>
			<For each={Array.from({ length: GAUGE_CELLS }, (_, i) => i)}>
				{(cell) => <span class="find-gauge-cell" data-filled={cell < filled()} />}
			</For>
		</span>
	);
};

const FindHitRow: Component<{ hit: FindHit }> = (props) => (
	<div class="find-hit">
		<div class="find-hit-head">
			<ScoreGauge score={props.hit.score} />
			<span class="find-score" data-tone={scoreTone(props.hit.score)}>
				{props.hit.score.toFixed(2)}
			</span>
			<button
				type="button"
				class="search-path find-path"
				title="Copy path"
				onClick={() => copy(props.hit.path)}
			>
				{props.hit.path}
			</button>
			<Show when={judgedLabel(props.hit)}>
				{(label) => <span class="find-judged">{label()}</span>}
			</Show>
		</div>
		<For each={props.hit.ranges.slice(0, RANGES_PER_HIT)}>
			{(range) => (
				<div class="find-range">
					<button
						type="button"
						class="search-path find-range-ref"
						title="Copy path:lines"
						onClick={() => copy(`${props.hit.path}:${rangeLabel(range)}`)}
					>
						:{rangeLabel(range)}
					</button>
					<span class="find-range-p">{range.p.toFixed(2)}</span>
					<Show when={range.snippet.trim()}>
						{(snippet) => (
							<code class="find-snippet">
								<HighlightedText
									code={snippet().replace(/\t/g, "  ")}
									lang={languageForPath(props.hit.path)}
								/>
							</code>
						)}
					</Show>
				</div>
			)}
		</For>
	</div>
);

const hitCount = (n: number) => `${n} ${n === 1 ? "hit" : "hits"}`;

/** What an empty result means: nothing judged says nothing about absence. */
function emptyMessage(view: FindView): string {
	if (view.coverage === "unavailable")
		return "Find unavailable: every judge request failed, so nothing was judged. This is not evidence of absence; use grep.";
	return view.coverage === "partial" || view.timeout
		? "No relevant passages found in the judged files"
		: "No relevant passages found";
}

/**
 * find: the semantic search. The header carries the quoted query, hit count and
 * scope; a call cut short by the SDK's deadline adds a `timed out` marker with
 * how many passages were verified. Hits are ranked rows (score gauge, copyable
 * path, strongest verified ranges with a highlighted snippet). Result details
 * of an unknown shape fall back to the raw output text.
 */
export const FindToolCard: Component<{ item: ToolItem }> = (props) => {
	const call = () => findCallOf(props.item.args);
	const view = createMemo(() =>
		props.item.status === "running" ? null : parseFindDetails(props.item.details),
	);
	const query = () => view()?.query ?? call().query;
	const scope = () => view()?.scope ?? call().path;
	const expansion = createRowExpansion(() => props.item);
	const capped = () => capRows(view()?.hits ?? [], toolRowCap(), "head");
	const shown = () => (expansion.expanded() ? (view()?.hits ?? []) : capped().shown);
	const keywords = () => {
		const used = view()?.keywords ?? [];
		return used.length > 0 ? used : call().keywords;
	};
	return (
		<ToolCardShell
			name="find"
			arg={query() ? `"${query()}"` : undefined}
			status={props.item.status}
			class="find-tool"
			meta={
				<Show when={view()}>
					{(v) => (
						<>
							<span class="find-meta">
								{hitCount(v().hits.length)}
								<Show when={scope()}>{(s) => ` · in ${s()}`}</Show>
							</span>
							<Show when={v().timeout}>
								{(timeout) => (
									<span
										class="find-timeout"
										title="The 20 s budget ran out; unverified files may still match"
									>
										timed out · {timeoutProgress(timeout())}
									</span>
								)}
							</Show>
						</>
					)}
				</Show>
			}
		>
			<div class="find-body">
				<Show
					when={view()}
					fallback={
						<Show
							when={props.item.status === "running"}
							fallback={
								<For each={props.item.output.split("\n").filter((l) => l.length > 0)}>
									{(line) => <div class="search-line find-raw">{line}</div>}
								</For>
							}
						>
							<div class="find-progress">
								{lastLine(props.item.output) || "Searching"}
								<Show when={scope()}>{(s) => ` · in ${s()}`}</Show>
							</div>
						</Show>
					}
				>
					{(v) => (
						<>
							<Show when={v().timeout}>
								{(timeout) => (
									<div class="find-timeout-note">
										Timed out: {timeout().verified} of {timeout().passages} passages were verified.
										These hits were verified before the deadline and unverified files may still
										match. Narrow the path for a complete search.
									</div>
								)}
							</Show>
							<Show
								when={v().hits.length > 0}
								fallback={<div class="find-empty">{emptyMessage(v())}</div>}
							>
								<For each={shown()}>{(hit) => <FindHitRow hit={hit} />}</For>
								<Show when={expansion.noteLabel(capped().hidden)}>
									{(label) => (
										<button
											type="button"
											class="tool-collapsed-note"
											title="Ctrl+O expands every tool output"
											aria-expanded={expansion.userExpanded()}
											onClick={expansion.toggle}
										>
											{label()}
										</button>
									)}
								</Show>
							</Show>
							<Show when={v().failed > 0 || v().failures.length > 0}>
								<div class="find-failures">
									<Show when={v().failed > 0 && v().requests !== undefined}>
										<div>
											{v().failed}/{v().requests} requests failed
										</div>
									</Show>
									<For each={v().failures}>{(failure) => <div>{failure}</div>}</For>
								</div>
							</Show>
							<Show when={accountingLine(v())}>
								{(line) => (
									<div class="find-foot">
										<Show when={keywords().length > 0}>
											<span>keywords: {keywords().join(", ")}</span>
										</Show>
										<span>{line()}</span>
									</div>
								)}
							</Show>
						</>
					)}
				</Show>
			</div>
		</ToolCardShell>
	);
};
