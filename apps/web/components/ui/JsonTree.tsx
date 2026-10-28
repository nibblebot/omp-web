import { createMemo, For, Show, type Component } from "solid-js";
import { createLazyOpen } from "./lazy-open";

/** Entries of one object or array shown before the rest fold into a count. */
const MAX_ENTRIES = 100;
/** Nesting levels drawn; a deeper container shows only its size. */
const MAX_DEPTH = 8;
/** Characters of a string value shown (the full string stays in the tooltip). */
const MAX_STRING = 240;

interface JsonNodeProps {
	value: unknown;
	depth: number;
	/** Containers at a depth below this start open. */
	openDepth: number;
}

function sizeOf(value: object): number {
	return Array.isArray(value) ? value.length : Object.keys(value).length;
}

function sizeLabel(size: number, isArray: boolean): string {
	return isArray
		? `[${size} item${size === 1 ? "" : "s"}]`
		: `{${size} key${size === 1 ? "" : "s"}}`;
}

/** The first `limit` entries of an object or array, without copying the rest. */
function firstEntries(value: object, limit: number): [string, unknown][] {
	if (Array.isArray(value)) return value.slice(0, limit).map((item, i) => [String(i), item]);
	const out: [string, unknown][] = [];
	for (const key of Object.keys(value)) {
		if (out.length >= limit) break;
		out.push([key, (value as Record<string, unknown>)[key]]);
	}
	return out;
}

/** Class, display text and (for a clipped string) full text of a scalar value. */
function scalarView(value: unknown): { cls: string; text: string; title?: string } {
	if (typeof value === "string") {
		const clipped = value.length > MAX_STRING;
		return {
			cls: "json-string",
			text: JSON.stringify(clipped ? `${value.slice(0, MAX_STRING)}\u2026` : value),
			title: clipped ? value : undefined,
		};
	}
	if (typeof value === "number") return { cls: "json-number", text: String(value) };
	if (typeof value === "boolean") return { cls: "json-boolean", text: String(value) };
	return { cls: "json-null", text: String(value) };
}

const Scalar: Component<{ value: unknown }> = (props) => {
	const view = () => scalarView(props.value);
	return (
		<span class={view().cls} title={view().title}>
			{view().text}
		</span>
	);
};

const JsonNode: Component<JsonNodeProps> = (props) => {
	const container = () =>
		typeof props.value === "object" && props.value !== null ? props.value : undefined;
	return (
		<Show when={container()} fallback={<Scalar value={props.value} />}>
			{(object) => (
				<JsonContainer value={object()} depth={props.depth} openDepth={props.openDepth} />
			)}
		</Show>
	);
};

/** An object or array row: the entries mount when the row first opens, so a closed subtree costs one <details>. */
const JsonContainer: Component<{ value: object; depth: number; openDepth: number }> = (props) => {
	const size = createMemo(() => sizeOf(props.value));
	const label = () => sizeLabel(size(), Array.isArray(props.value));
	const startsOpen = props.depth < props.openDepth;
	const { opened, onToggle } = createLazyOpen(startsOpen);
	return (
		<Show
			when={props.depth < MAX_DEPTH && size() > 0}
			fallback={<span class="json-size">{label()}</span>}
		>
			<details class="json-node" open={startsOpen} onToggle={onToggle}>
				<summary class="json-summary">
					<span class="json-size">{label()}</span>
				</summary>
				<Show when={opened()}>
					<ul class="json-entries">
						<For each={firstEntries(props.value, MAX_ENTRIES)}>
							{([key, child]) => (
								<li class="json-entry">
									<span class="json-key">{key}</span>
									<JsonNode value={child} depth={props.depth + 1} openDepth={props.openDepth} />
								</li>
							)}
						</For>
						<Show when={size() > MAX_ENTRIES}>
							<li class="json-more">{size() - MAX_ENTRIES} more</li>
						</Show>
					</ul>
				</Show>
			</details>
		</Show>
	);
};

/**
 * A JSON value as a collapsible tree: objects and arrays are disclosure rows
 * with their size, scalars are colored by type. Containers nest `openDepth`
 * levels open (default: the root only); entries, nesting and long strings are
 * capped so a large value stays a bounded block. Domain-free.
 */
export const JsonTree: Component<{ value: unknown; openDepth?: number }> = (props) => (
	<div class="json-tree">
		<JsonNode value={props.value} depth={0} openDepth={props.openDepth ?? 1} />
	</div>
);
