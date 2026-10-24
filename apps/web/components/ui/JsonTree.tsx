import { For, Show, type Component } from "solid-js";

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

function entriesOf(value: object): [string, unknown][] {
	return Array.isArray(value)
		? value.map((item, i) => [String(i), item])
		: Object.entries(value as Record<string, unknown>);
}

function sizeLabel(value: object): string {
	const size = Array.isArray(value) ? value.length : Object.keys(value).length;
	return Array.isArray(value)
		? `[${size} item${size === 1 ? "" : "s"}]`
		: `{${size} key${size === 1 ? "" : "s"}}`;
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
				<Show
					when={props.depth < MAX_DEPTH && entriesOf(object()).length > 0}
					fallback={<span class="json-size">{sizeLabel(object())}</span>}
				>
					<details class="json-node" open={props.depth < props.openDepth}>
						<summary class="json-summary">
							<span class="json-size">{sizeLabel(object())}</span>
						</summary>
						<ul class="json-entries">
							<For each={entriesOf(object()).slice(0, MAX_ENTRIES)}>
								{([key, child]) => (
									<li class="json-entry">
										<span class="json-key">{key}</span>
										<JsonNode value={child} depth={props.depth + 1} openDepth={props.openDepth} />
									</li>
								)}
							</For>
							<Show when={entriesOf(object()).length > MAX_ENTRIES}>
								<li class="json-more">{entriesOf(object()).length - MAX_ENTRIES} more</li>
							</Show>
						</ul>
					</details>
				</Show>
			)}
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
