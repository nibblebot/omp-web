/**
 * Message row renderers (assistant/user/toolResult/developer/fileMention),
 * including the tool-call card with its paired result subsection.
 */
import { For, Show } from "solid-js";
import type { RawEntry } from "../../../api";
import type { ContentBlock } from "../../../util/entries";
import {
	assistantMetaOf,
	contentBlocks,
	entryTimestamp,
	entryTs,
	messageObj,
	num,
	prettyArgs,
	str,
	toolCallIdOf,
	toolResultIsError,
	toolResultMetaOf,
	toolResultText,
	userHasImage,
	userMetaOf,
	userText,
} from "../../../util/entries";
import { formatCompact, formatCost, formatDateTime, formatMs } from "../../../util/format";
import { ChevronDownIcon, CornerDownRightIcon } from "../../../../components/shared/icons";
import { Markdown } from "../../../../components/shared/Markdown";
import type { PairingMaps, ToolCallInfo } from "../pairing";
import { useRowCollapse } from "../collapse";
import { RawJson, ToggleDetails, prettyJson, rowAriaLabel, scalar } from "./shared";

/** Tool results can be huge (hundreds of KB); cap what we render per card. */
const MAX_RESULT_CHARS = 10_000;

export function AssistantMsg(props: { entry: RawEntry; pairing: PairingMaps }) {
	const e = props.entry;
	const m = messageObj(e);
	const model = str(m.model);
	const meta = assistantMetaOf(e);
	const provider = meta?.provider ?? null;
	const apiName = meta?.api ?? null;
	const ttft = meta?.ttft ?? null;
	const errorId = meta?.errorId ?? null;
	const errorStatus = meta?.errorStatus;
	const usage = meta?.usage ?? null;
	const ctx = meta?.contextSnapshot ?? null;
	// Runtime-narrowed plain object (typeof + non-null + non-array), then cast once to a named const.
	const rawUsage =
		typeof m.usage === "object" && m.usage !== null && !Array.isArray(m.usage)
			? (m.usage as Record<string, unknown>)
			: null;
	const tokens = num(rawUsage?.totalTokens);
	const duration = num(m.duration);
	const stopReason = str(m.stopReason);
	const errorMessage = str(m.errorMessage);
	const ts = entryTs(e);
	const error =
		stopReason === "error" || errorMessage !== "" || errorId !== null || errorStatus != null;
	const blocks = contentBlocks(e);
	const row = useRowCollapse(e);

	return (
		<div classList={{ "tx-msg": true, assistant: true, error: error, collapsed: row.collapsed() }}>
			<div class="tx-msg-meta">
				<button
					class="tx-msg-toggle"
					onClick={row.toggle}
					aria-expanded={!row.collapsed()}
					aria-label={rowAriaLabel(e)}
				>
					<ChevronDownIcon class="tx-caret" />
					<span class="meta-time">{ts !== null ? formatDateTime(ts) : ""}</span>
					<span class="meta-who">assistant</span>
					<Show when={model !== ""}>
						<span class="meta-model">{model}</span>
					</Show>
					{/* provider and api are the same string on most sessions — render once */}
					<Show when={provider !== null && provider !== apiName}>
						<span class="tx-badge">{provider}</span>
					</Show>
					<Show when={apiName !== null}>
						<span class="tx-badge">{apiName}</span>
					</Show>
					<Show when={ttft !== null}>
						<span class="meta-ttft">ttft {formatMs(ttft)}</span>
					</Show>
					<Show when={stopReason !== ""}>
						<span class="meta-stop">
							<CornerDownRightIcon /> {stopReason}
						</span>
					</Show>
					<Show when={tokens !== null}>
						<span class="meta-tok">{formatCompact(tokens)} tok</span>
					</Show>
					<Show when={duration !== null}>
						<span class="meta-dur">{formatMs(duration)}</span>
					</Show>
					<Show when={errorMessage !== ""}>
						<span class="meta-err">{errorMessage}</span>
					</Show>
					<Show when={errorId !== null}>
						<span class="meta-err">error {errorId}</span>
					</Show>
					<Show when={errorStatus != null}>
						<span class="meta-err">status {String(errorStatus)}</span>
					</Show>
				</button>
				<RawJson entry={e} />
			</div>
			<For each={blocks}>
				{(b, i) => <Block block={b} pairing={props.pairing} entry={e} idx={i()} />}
			</For>
			<Show when={usage !== null || ctx !== null || meta?.stopDetails != null}>
				<ToggleDetails entry={e} purpose="usage" class="usage-details" summary="usage">
					<Show when={usage !== null}>
						<div class="usage-grid">
							<span class="usage-cell">
								<b>input</b> {formatCompact(usage?.input)}
							</span>
							<span class="usage-cell">
								<b>output</b> {formatCompact(usage?.output)}
							</span>
							<span class="usage-cell">
								<b>cacheRead</b> {formatCompact(usage?.cacheRead)}
							</span>
							<span class="usage-cell">
								<b>cacheWrite</b> {formatCompact(usage?.cacheWrite)}
							</span>
							<Show when={usage?.reasoningTokens !== null}>
								<span class="usage-cell">
									<b>reasoning</b> {formatCompact(usage?.reasoningTokens)}
								</span>
							</Show>
							<Show when={usage?.costTotal !== null}>
								<span class="usage-cell">
									<b>cost</b> {formatCost(usage?.costTotal)}
								</span>
							</Show>
						</div>
					</Show>
					<Show when={ctx !== null}>
						<div class="usage-grid">
							<span class="usage-cell">
								<b>ctx prompt</b> {formatCompact(ctx?.promptTokens)}
							</span>
							<span class="usage-cell">
								<b>ctx non-message</b> {formatCompact(ctx?.nonMessageTokens)}
							</span>
						</div>
					</Show>
					<Show when={meta?.stopDetails != null}>
						<pre class="mini-pre">{prettyJson(meta?.stopDetails)}</pre>
					</Show>
				</ToggleDetails>
			</Show>
		</div>
	);
}

function Block(props: { block: ContentBlock; pairing: PairingMaps; entry: RawEntry; idx: number }) {
	const b = props.block;
	if (b.type === "text") {
		const text = str(b.text);
		return text !== "" ? <Markdown src={text} /> : null;
	}
	if (b.type === "thinking") {
		const text = str(b.thinking ?? b.text ?? b.content);
		return text !== "" ? (
			<ToggleDetails
				entry={props.entry}
				purpose={`thinking:${props.idx}`}
				class="thinking"
				summary="thinking"
			>
				<Markdown src={text} />
			</ToggleDetails>
		) : null;
	}
	if (b.type === "toolCall")
		return <ToolCallCard block={b} pairing={props.pairing} entry={props.entry} idx={props.idx} />;
	return (
		<div class="unknown-block">
			[{str(b.type)}] <span class="muted">{str(b.text)}</span>
		</div>
	);
}

function ToolCallCard(props: {
	block: ContentBlock;
	pairing: PairingMaps;
	entry: RawEntry;
	idx: number;
}) {
	const name = str(props.block.name);
	const id = str(props.block.id);
	const args = prettyArgs(props.block.arguments);
	const call: ToolCallInfo | undefined = id !== "" ? props.pairing.calls.get(id) : undefined;
	const resultEntries = id !== "" ? (props.pairing.results.get(id) ?? []) : [];
	return (
		<div class="tool-call">
			<div class="tc-head">
				<span class="tc-name">{name || "tool"}</span>
				<Show when={id !== ""}>
					<span class="tc-id">{id}</span>
				</Show>
				<Show when={call !== undefined && !call.hasResult}>
					<span class="tx-badge tx-badge-warn">pending…</span>
				</Show>
			</div>
			<ToggleDetails
				entry={props.entry}
				purpose={`tc-args:${props.idx}`}
				class="tc-args"
				summary="arguments"
			>
				<pre>{args}</pre>
			</ToggleDetails>
			<For each={resultEntries}>
				{(r) => <ToolResultSub entry={r} startedAt={call?.startedAt ?? null} />}
			</For>
		</div>
	);
}

/** Paired toolResult, rendered as a subsection of its tool call card. */
function ToolResultSub(props: { entry: RawEntry; startedAt: number | null }) {
	const e = props.entry;
	const isErr = toolResultIsError(e);
	const meta = toolResultMetaOf(e);
	const text = toolResultText(e);
	const ts = entryTimestamp(e);
	const dur = props.startedAt != null && ts != null ? ts - props.startedAt : null;
	const shown =
		text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (truncated)` : text;
	const details = meta?.details ?? null;
	const detailChips =
		details === null ? [] : Object.entries(details).filter(([, v]) => scalar(v) !== null);
	return (
		<div classList={{ "tool-result-sub": true, error: isErr }}>
			<div class="result-head">
				<span class="result-label">toolResult</span>
				<Show when={isErr}>
					<span class="tx-badge tx-badge-err">error</span>
				</Show>
				<Show when={dur !== null}>
					<span class="meta-dur">{formatMs(dur)}</span>
				</Show>
				<Show when={meta?.useless === true}>
					<span class="tx-badge tx-badge-faint">useless</span>
				</Show>
				<Show when={meta?.prunedAt != null}>
					<span class="tx-badge tx-badge-faint">pruned</span>
				</Show>
				<RawJson entry={e} />
			</div>
			<Show when={detailChips.length > 0}>
				<div class="chip-row">
					<For each={detailChips}>
						{([k, v]) => (
							<span class="mini-chip">
								{k}: {scalar(v)}
							</span>
						)}
					</For>
				</div>
			</Show>
			<pre class="result-text">{shown}</pre>
		</div>
	);
}

export function UserMsg(props: { entry: RawEntry }) {
	const e = props.entry;
	const ts = entryTs(e);
	const text = userText(e);
	const hasImage = userHasImage(e);
	const meta = userMetaOf(e);
	const attribution = typeof meta?.attribution === "string" ? meta.attribution : null;
	const row = useRowCollapse(e);
	return (
		<div classList={{ "tx-msg": true, user: true, collapsed: row.collapsed() }}>
			<div class="tx-msg-meta">
				<button
					class="tx-msg-toggle"
					onClick={row.toggle}
					aria-expanded={!row.collapsed()}
					aria-label={rowAriaLabel(e)}
				>
					<ChevronDownIcon class="tx-caret" />
					<span class="meta-time">{ts !== null ? formatDateTime(ts) : ""}</span>
					<span class="meta-who">user</span>
					<Show when={attribution !== null}>
						<span class="tx-badge">{attribution}</span>
					</Show>
					<Show when={meta?.steering === true}>
						<span class="tx-badge tx-badge-warn">steering</span>
					</Show>
					<Show when={meta?.synthetic === true}>
						<span class="tx-badge tx-badge-warn">synthetic</span>
					</Show>
				</button>
				<RawJson entry={e} />
			</div>
			<div class="user-bubble">
				<Show when={text !== ""}>
					<Markdown src={text} />
				</Show>
				<Show when={hasImage}>
					<span class="image-chip">[image attachment]</span>
				</Show>
			</div>
		</div>
	);
}

/** Standalone toolResult row — only rendered while its call's message isn't loaded. */
export function ToolResultMsg(props: { entry: RawEntry; calls: Map<string, ToolCallInfo> }) {
	const e = props.entry;
	const m = messageObj(e);
	const isErr = toolResultIsError(e);
	const id = toolCallIdOf(e);
	const call = id !== null ? props.calls.get(id) : undefined;
	const meta = toolResultMetaOf(e);
	// Prefer the paired toolCall's name; fall back to the message's own toolName.
	const name = call !== undefined && call.name !== "" ? call.name : (meta?.toolName ?? "");
	const text = toolResultText(e);
	const ts = entryTimestamp(e);
	const base = call?.startedAt ?? null;
	const dur = base != null && ts != null ? ts - base : null;
	const shown =
		text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (truncated)` : text;
	const details = meta?.details ?? null;
	const detailChips =
		details === null ? [] : Object.entries(details).filter(([, v]) => scalar(v) !== null);
	const row = useRowCollapse(e);

	return (
		<div
			classList={{ "tx-msg": true, "tool-result": true, error: isErr, collapsed: row.collapsed() }}
		>
			<div class="tx-msg-meta">
				<button
					class="tx-msg-toggle"
					onClick={row.toggle}
					aria-expanded={!row.collapsed()}
					aria-label={rowAriaLabel(e)}
				>
					<ChevronDownIcon class="tx-caret" />
					<span class="meta-time">{ts !== null ? formatDateTime(ts) : ""}</span>
					<span class="meta-who">toolResult</span>
					<Show when={name !== ""}>
						<span class="meta-model">{name}</span>
					</Show>
					<Show when={id !== null}>
						<span class="tc-id">{id}</span>
					</Show>
					<Show when={isErr}>
						<span class="meta-err">error</span>
					</Show>
					<Show when={meta?.useless === true}>
						<span class="tx-badge tx-badge-faint">useless</span>
					</Show>
					<Show when={meta?.prunedAt != null}>
						<span class="tx-badge tx-badge-faint">pruned</span>
					</Show>
					<Show when={dur !== null}>
						<span class="meta-dur">{formatMs(dur)}</span>
					</Show>
				</button>
				<RawJson entry={e} />
			</div>
			<Show when={detailChips.length > 0}>
				<div class="chip-row">
					<For each={detailChips}>
						{([k, v]) => (
							<span class="mini-chip">
								{k}: {scalar(v)}
							</span>
						)}
					</For>
				</div>
			</Show>
			<pre class="result-text">{shown}</pre>
		</div>
	);
}

/** System-authored developer messages (system reminders etc.) — styled system bubble. */
export function DeveloperMsg(props: { entry: RawEntry }) {
	const e = props.entry;
	const ts = entryTs(e);
	const text = contentBlocks(e)
		.map((b) => (b.type === "text" ? str(b.text) : ""))
		.join("\n");
	const row = useRowCollapse(e);
	return (
		<div classList={{ "tx-msg": true, "dev-system": true, collapsed: row.collapsed() }}>
			<div class="tx-msg-meta">
				<button
					class="tx-msg-toggle"
					onClick={row.toggle}
					aria-expanded={!row.collapsed()}
					aria-label={rowAriaLabel(e)}
				>
					<ChevronDownIcon class="tx-caret" />
					<span class="meta-time">{ts !== null ? formatDateTime(ts) : ""}</span>
					<span class="meta-who">developer</span>
				</button>
				<RawJson entry={e} />
			</div>
			<Show when={text !== ""}>
				<div class="dev-content">
					<Markdown src={text} />
				</div>
			</Show>
		</div>
	);
}

/** File mentions: one collapsible attachment card per file. */
export function FileMentionMsg(props: { entry: RawEntry }) {
	const e = props.entry;
	const ts = entryTs(e);
	const m = messageObj(e);
	const files = (Array.isArray(m.files) ? m.files : []).filter(
		(f): f is { path: string; content?: unknown } =>
			typeof f === "object" &&
			f !== null &&
			!Array.isArray(f) &&
			"path" in f &&
			typeof f.path === "string",
	);
	const row = useRowCollapse(e);
	return (
		<div classList={{ "tx-msg": true, "file-mention": true, collapsed: row.collapsed() }}>
			<div class="tx-msg-meta">
				<button
					class="tx-msg-toggle"
					onClick={row.toggle}
					aria-expanded={!row.collapsed()}
					aria-label={rowAriaLabel(e)}
				>
					<ChevronDownIcon class="tx-caret" />
					<span class="meta-time">{ts !== null ? formatDateTime(ts) : ""}</span>
					<span class="meta-who">fileMention</span>
					<span class="meta-tok">
						{files.length} file{files.length === 1 ? "" : "s"}
					</span>
				</button>
				<RawJson entry={e} />
			</div>
			<For each={files}>
				{(f, i) => (
					<ToggleDetails
						entry={e}
						purpose={`file-attach:${i()}`}
						class="file-attach"
						summary={f.path}
					>
						<pre>{str(f.content)}</pre>
					</ToggleDetails>
				)}
			</For>
		</div>
	);
}
