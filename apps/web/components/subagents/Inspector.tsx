import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import type { SubagentInfo } from "../../state";

/**
 * Worker inspector (G04): tabbed context|lineage|patch|output view rendering
 * WorkerRecord fields plus progress-snapshot extras when present on
 * SubagentInfo as unknown. Every access is defensive — SubagentInfo carries
 * only the mirror subset, so missing fields render "n/a", never crash.
 */
export type InspectorTab = "context" | "lineage" | "patch" | "output";

/**
 * WorkerRecord extras ride on SubagentInfo as unknown (P0 publishes the
 * typed mirror). Named shape with optional fields, asserted once at the
 * component boundary — every read below is a typed optional access.
 */
interface WorkerExtras {
	model?: unknown;
	sessionFile?: unknown;
	tokensUsed?: unknown;
	cost?: unknown;
	context?: unknown;
	contextFiles?: unknown;
	progress?: unknown;
	progressSnapshot?: unknown;
	lineage?: unknown;
	parents?: unknown;
	patch?: unknown;
	diff?: unknown;
	changedFiles?: unknown;
	files?: unknown;
	output?: unknown;
	result?: unknown;
	yielded?: unknown;
}

// Invariant: the server mirror only ever adds optional JSON fields, so a
// direct named assertion at this in-process boundary is sound.
const extrasOf = (sub: SubagentInfo): WorkerExtras => sub as unknown as WorkerExtras;

const textOf = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value : null;

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

const firstText = (...values: unknown[]): string | null => {
	for (const value of values) {
		const text = textOf(value);
		if (text !== null) return text;
	}
	return null;
};

const firstList = (...values: unknown[]): string[] => {
	for (const value of values) {
		const list = listOf(value);
		if (list.length > 0) return list;
	}
	return [];
};

const Field: Component<{ label: string; value: string }> = (props) => (
	<div class="goal-meta">
		<span class="picker-label">{props.label}</span> {props.value}
	</div>
);

const ContextTab: Component<{ sub: SubagentInfo }> = (props) => {
	const extras = () => extrasOf(props.sub);
	const contextFiles = () => firstList(extras().context, extras().contextFiles);
	return (
		<div class="goal-panel">
			<Field label="id" value={props.sub.id} />
			<Field label="agent" value={props.sub.agent} />
			<Field label="status" value={props.sub.status} />
			<Show
				when={textOf(extras().model)}
				fallback={<Field label="model" value="n/a (not in mirror)" />}
			>
				{(model) => <Field label="model" value={model()} />}
			</Show>
			<Show when={textOf(extras().sessionFile)}>
				{(file) => <Field label="sessionFile" value={file()} />}
			</Show>
			<Show when={extras().tokensUsed !== undefined || extras().cost !== undefined}>
				<Field
					label="usage"
					value={`tokens ${String(extras().tokensUsed ?? "n/a")} · cost ${String(extras().cost ?? "n/a")}`}
				/>
			</Show>
			<Show when={contextFiles().length > 0}>
				<div class="goal-meta">
					<span class="picker-label">context</span>
				</div>
				<For each={contextFiles()}>{(entry) => <div class="tool-collapsed-note">{entry}</div>}</For>
			</Show>
			<Show when={contextFiles().length === 0 && extras().progressSnapshot === undefined}>
				<div class="tool-collapsed-note">no context snapshot in mirror</div>
			</Show>
		</div>
	);
};

const LineageTab: Component<{ sub: SubagentInfo }> = (props) => {
	const parents = () => firstList(extrasOf(props.sub).lineage, extrasOf(props.sub).parents);
	return (
		<div class="goal-panel">
			<Field label="worker" value={props.sub.id} />
			<Field label="parent tool call" value={props.sub.parentToolCallId ?? "not recorded"} />
			<Show
				when={parents().length > 0}
				fallback={<div class="tool-collapsed-note">No additional lineage snapshot available.</div>}
			>
				<For each={parents()}>{(parent) => <Field label="ancestor" value={parent} />}</For>
			</Show>
		</div>
	);
};

const PatchTab: Component<{ sub: SubagentInfo }> = (props) => {
	const extras = () => extrasOf(props.sub);
	const patch = () => firstText(extras().patch, extras().diff);
	const files = () => firstList(extras().changedFiles, extras().files);
	return (
		<div class="goal-panel">
			<Show when={files().length > 0}>
				<div class="goal-meta">
					<span class="picker-label">files</span>
				</div>
				<For each={files()}>{(file) => <div class="tool-collapsed-note">{file}</div>}</For>
			</Show>
			<Show when={patch()} fallback={<div class="tool-collapsed-note">no patch in mirror</div>}>
				{(text) => (
					<pre class="dim-block" style={{ margin: "0", "white-space": "pre-wrap" }}>
						{text()}
					</pre>
				)}
			</Show>
		</div>
	);
};

const OutputTab: Component<{ sub: SubagentInfo }> = (props) => {
	const extras = () => extrasOf(props.sub);
	const output = () => firstText(extras().output, extras().result, extras().yielded);
	return (
		<div class="goal-panel">
			<Show
				when={output()}
				fallback={
					<div class="tool-collapsed-note">no output snapshot in mirror — see transcript</div>
				}
			>
				{(text) => (
					<pre class="dim-block" style={{ margin: "0", "white-space": "pre-wrap" }}>
						{text()}
					</pre>
				)}
			</Show>
		</div>
	);
};

export const Inspector: Component<{ sub: SubagentInfo; tab: InspectorTab }> = (props) => (
	<Show
		when={props.tab === "lineage"}
		fallback={
			<Show
				when={props.tab === "patch"}
				fallback={
					<Show when={props.tab === "output"} fallback={<ContextTab sub={props.sub} />}>
						<OutputTab sub={props.sub} />
					</Show>
				}
			>
				<PatchTab sub={props.sub} />
			</Show>
		}
	>
		<LineageTab sub={props.sub} />
	</Show>
);
