/**
 * System entry row renderers (session/session_init/mode_change/model_change/
 * thinking_level_change/service_tier_change/title_change/ttsr_injection/
 * compaction/label/credential_pin/custom_message/custom/session_exit/
 * goal-completed).
 */
import { For, Show } from "solid-js";
import type { RawEntry } from "../../../api";
import { Markdown } from "../../../../components/Markdown";
import {
	compactionSummaryOf,
	customEntryOf,
	customMessageOf,
	modeChangeOf,
	num,
	sessionHeaderOf,
	sessionInitOf,
	str,
	titleChangeOf,
	ttsrInjectionOf,
} from "../../../util/entries";
import { formatCompact, formatDateTime, formatMs } from "../../../util/format";
import { DataKv, GenericSysRow, Kv, SysCard, ToggleDetails, prettyJson } from "./shared";

/** CSS modifier class per note severity; unknown severities fall back to muted. */
const NOTE_SEV_CLASS: Record<string, string> = {
	error: "err",
	warn: "warn",
	warning: "warn",
	concern: "warn",
	info: "ok",
	ok: "ok",
	success: "ok",
};

export function SessionHeader(props: { entry: RawEntry }) {
	const h = sessionHeaderOf(props.entry);
	return (
		<SysCard entry={props.entry} label="session">
			<Show when={h !== null}>
				<>
					<Kv k="title" v={h?.title} />
					<Kv k="id" v={h?.id} />
					<Kv k="cwd" v={h?.cwd} />
					<Kv k="version" v={h?.version} />
					<Kv k="titleSource" v={h?.titleSource} />
				</>
			</Show>
		</SysCard>
	);
}

export function SessionInitRow(props: { entry: RawEntry }) {
	const s = sessionInitOf(props.entry);
	return (
		<SysCard entry={props.entry} label="session_init">
			<Show when={s !== null}>
				<>
					<div class="sys-summary">
						<Show when={s?.resolvedModel !== null}>
							<span class="tx-badge">{s?.resolvedModel}</span>
						</Show>
						<Show when={s?.modelRole !== null}>
							<span class="tx-badge">{s?.modelRole}</span>
						</Show>
						<Show when={s?.agent !== null}>
							<span class="tx-badge">{s?.agent}</span>
						</Show>
						<span class="tx-badge">
							{(s?.tools.length ?? 0) === 1 ? "1 tool" : `${s?.tools.length ?? 0} tools`}
						</span>
						<Show when={s?.readOnly === true}>
							<span class="tx-badge tx-badge-warn">read-only</span>
						</Show>
						<Show when={s?.outputSchemaMode !== null}>
							<span class="tx-badge">{`output schema: ${s?.outputSchemaMode}`}</span>
						</Show>
					</div>
					<ToggleDetails
						entry={props.entry}
						purpose="big-payload:sysprompt"
						class="big-payload"
						summary={`system prompt · ${s?.systemPrompt.length ?? 0} chars`}
					>
						<pre>{s?.systemPrompt}</pre>
					</ToggleDetails>
					<Show when={(s?.tools.length ?? 0) > 0}>
						<div class="chip-row">
							<span class="sys-sub">tools</span>
							<For each={s?.tools ?? []}>{(t) => <span class="mini-chip">{t}</span>}</For>
						</div>
					</Show>
					<Show when={s?.task !== null && s?.task !== ""}>
						<ToggleDetails
							entry={props.entry}
							purpose="big-payload:task"
							class="big-payload"
							summary={`task · ${s?.task?.length ?? 0} chars`}
						>
							<pre>{s?.task}</pre>
						</ToggleDetails>
					</Show>
					<Show when={s?.outputSchema !== null}>
						<ToggleDetails
							entry={props.entry}
							purpose="big-payload:schema"
							class="big-payload"
							summary="output schema"
						>
							<pre>{prettyJson(s?.outputSchema)}</pre>
						</ToggleDetails>
					</Show>
					<Show when={s?.spawns !== undefined && s?.spawns !== null}>
						<Kv k="spawns" v={s?.spawns} />
					</Show>
					<Show when={s?.readSummarize !== undefined && s?.readSummarize !== null}>
						<Kv k="readSummarize" v={s?.readSummarize} />
					</Show>
				</>
			</Show>
		</SysCard>
	);
}

export function ModeChangeRow(props: { entry: RawEntry }) {
	const m = modeChangeOf(props.entry);
	return (
		<SysCard entry={props.entry} label="mode_change">
			<Show when={m !== null}>
				<>
					<div class="sys-summary">
						<span class="tx-badge tx-badge-ok">{m?.mode ?? "mode"}</span>
					</div>
					<Show when={m?.data !== null}>
						<For each={Object.entries(m?.data ?? {})}>
							{([k, v]) => <DataKv k={k} v={v} entry={props.entry} />}
						</For>
					</Show>
				</>
			</Show>
		</SysCard>
	);
}

export function TitleChangeRow(props: { entry: RawEntry }) {
	const t = titleChangeOf(props.entry);
	return (
		<SysCard entry={props.entry} label="title_change">
			<Show when={t !== null}>
				<>
					<div class="title-flow">
						<Show when={t?.previousTitle !== null}>
							<span class="sys-title old">{t?.previousTitle}</span>
							<span class="sys-arrow">→</span>
						</Show>
						<Show when={t?.title !== null}>
							<span class="sys-title new">{t?.title}</span>
						</Show>
					</div>
					<div class="sys-summary">
						<Show when={t?.source !== null}>
							<span class="tx-badge">{t?.source}</span>
						</Show>
						<Show when={t?.trigger !== null}>
							<span class="tx-badge">{t?.trigger}</span>
						</Show>
					</div>
				</>
			</Show>
		</SysCard>
	);
}

export function TtsrInjectionRow(props: { entry: RawEntry }) {
	const rules = ttsrInjectionOf(props.entry);
	return (
		<SysCard entry={props.entry} label="ttsr_injection">
			<Show when={rules !== null}>
				<div class="chip-row">
					<For each={rules ?? []}>{(r) => <span class="mini-chip">{r}</span>}</For>
				</div>
			</Show>
		</SysCard>
	);
}

export function CompactionRow(props: { entry: RawEntry }) {
	const s = compactionSummaryOf(props.entry);
	return (
		<SysCard entry={props.entry} label="compaction">
			<Show when={s !== null && s !== ""}>
				<ToggleDetails
					entry={props.entry}
					purpose="big-payload:summary"
					class="big-payload"
					summary={`summary · ${s?.length ?? 0} chars`}
				>
					<pre>{s}</pre>
				</ToggleDetails>
			</Show>
		</SysCard>
	);
}

export function CustomMessageRow(props: { entry: RawEntry }) {
	const c = customMessageOf(props.entry);
	const content = typeof c?.content === "string" ? c.content : "";
	return (
		<SysCard entry={props.entry} label="custom_message">
			<Show when={c !== null}>
				<>
					<div class="sys-summary">
						<Show when={c?.customType !== null}>
							<span class="tx-badge">{c?.customType}</span>
						</Show>
						<Show when={c?.display === false}>
							<span class="tx-badge tx-badge-faint">display:false</span>
						</Show>
					</div>
					<Show when={content.trim() !== ""}>
						<div class="custom-msg-content">
							<Markdown src={content} />
						</div>
					</Show>
					<Show when={c?.details !== null && (c?.details?.notes.length ?? 0) > 0}>
						<ul class="note-list">
							<For each={c?.details?.notes ?? []}>
								{(n) => (
									<li
										classList={{
											"note-item": true,
											[`note-${NOTE_SEV_CLASS[n.severity] ?? "muted"}`]: true,
										}}
									>
										<span class="note-sev">{n.severity}</span>
										{n.note}
									</li>
								)}
							</For>
						</ul>
					</Show>
				</>
			</Show>
		</SysCard>
	);
}

/** `custom` entry dispatch; tool_execution_start is pairing metadata — invisible. */
export function CustomRow(props: { entry: RawEntry }) {
	const c = customEntryOf(props.entry);
	if (c === null) return <GenericSysRow entry={props.entry} label="custom" />;
	if (c.customType === "tool_execution_start") return null;
	if (c.customType === "session_exit") return <SessionExitRow entry={props.entry} data={c.data} />;
	if (c.customType === "goal-completed")
		return <GoalCompletedRow entry={props.entry} data={c.data} />;
	return (
		<SysCard
			entry={props.entry}
			label={c.customType !== "" ? `custom · ${c.customType}` : "custom"}
		>
			<Show when={c.data !== null}>
				<ToggleDetails
					entry={props.entry}
					purpose="big-payload:data"
					class="big-payload"
					summary="data"
				>
					<pre>{prettyJson(c.data)}</pre>
				</ToggleDetails>
			</Show>
		</SysCard>
	);
}

export function SessionExitRow(props: { entry: RawEntry; data: Record<string, unknown> | null }) {
	const d = props.data ?? {};
	const kind = str(d.kind);
	const reason = str(d.reason);
	const recorded = str(d.recordedAt);
	const recordedTs = recorded !== "" ? Date.parse(recorded) : NaN;
	return (
		<SysCard entry={props.entry} label="session_exit">
			<div class="sys-summary">
				<Show when={kind !== ""}>
					<span class="tx-badge">{kind}</span>
				</Show>
				<Show when={reason !== ""}>
					<span class="tx-badge">{reason}</span>
				</Show>
				<Show when={!Number.isNaN(recordedTs)}>
					<span class="meta-time">{formatDateTime(recordedTs)}</span>
				</Show>
			</div>
		</SysCard>
	);
}

export function GoalCompletedRow(props: { entry: RawEntry; data: Record<string, unknown> | null }) {
	const d = props.data ?? {};
	const objective = str(d.objective);
	const seconds = num(d.timeUsedSeconds);
	const durationMs = seconds !== null ? seconds * 1000 : null;
	const tokens = num(d.tokensUsed);
	return (
		<SysCard entry={props.entry} label="goal-completed">
			<Show when={objective !== ""}>
				<div class="tx-goal-objective">{objective}</div>
			</Show>
			<div class="sys-summary">
				<Show when={durationMs !== null}>
					<span class="tx-badge">{formatMs(durationMs)}</span>
				</Show>
				<Show when={tokens !== null}>
					<span class="tx-badge">{formatCompact(tokens)} tokens</span>
				</Show>
			</div>
		</SysCard>
	);
}
