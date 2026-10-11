import { For, Show, type Component } from "solid-js";
import { entryByNodeId, nodeById, nodeLabel, type StoryEntry } from "./catalog";

/** A graph component as a link to its story, or plain text with the reason there is none. */
export const NodeLink: Component<{ id: string }> = (props) => {
	const node = () => nodeById.get(props.id);
	const entry = () => entryByNodeId.get(props.id);
	return (
		<Show when={node()} fallback={<span class="ds-chip">{props.id}</span>}>
			{(n) => (
				<Show
					when={entry()}
					fallback={
						<span class="ds-chip ds-chip-plain" title={`${n().file}:${n().line}`}>
							{nodeLabel(n())}
							<span class="ds-chip-note">{n().exportNames.length > 0 ? "no story" : "local"}</span>
						</span>
					}
				>
					{(e) => (
						<a class="ds-chip" href={`#/stories/${e().story.id}`} title={`${n().file}:${n().line}`}>
							{nodeLabel(n())}
							<span class="ds-chip-note">tier {n().tier}</span>
						</a>
					)}
				</Show>
			)}
		</Show>
	);
};

/** A graph component as a button that retargets the inspector to it (no story link). */
const NodePick: Component<{ id: string; onPick: (id: string) => void }> = (props) => {
	const node = () => nodeById.get(props.id);
	return (
		<Show when={node()} fallback={<span class="ds-chip">{props.id}</span>}>
			{(n) => (
				<button
					type="button"
					class="ds-chip ds-chip-button"
					title={`${n().file}:${n().line}`}
					onClick={() => props.onPick(props.id)}
				>
					{nodeLabel(n())}
					<span class="ds-chip-note">tier {n().tier}</span>
				</button>
			)}
		</Show>
	);
};

/** A labeled list of components: story links, or buttons when `onPick` is given. */
export const NodeList: Component<{
	label: string;
	ids: string[];
	empty: string;
	onPick?: (id: string) => void;
}> = (props) => (
	<div class="ds-meta-row">
		<dt>{props.label}</dt>
		<dd>
			<Show when={props.ids.length > 0} fallback={<span class="ds-empty">{props.empty}</span>}>
				<For each={props.ids}>
					{(id) =>
						props.onPick ? <NodePick id={id} onPick={props.onPick} /> : <NodeLink id={id} />
					}
				</For>
			</Show>
		</dd>
	</div>
);

/** Source location, rendered children, and parents of the story's component. */
export const StoryMeta: Component<{ entry: StoryEntry }> = (props) => (
	<>
		<Show when={props.entry.error}>{(message) => <p class="ds-error">{message()}</p>}</Show>
		<Show when={props.entry.node === null && props.entry.error === null}>
			<dl class="ds-meta">
				<div class="ds-meta-row">
					<dt>Source</dt>
					<dd>
						<For each={[...new Set(props.entry.nodes.map((n) => n.file))]}>
							{(file) => <code class="ds-story-file">{file}</code>}
						</For>
					</dd>
				</div>
				<NodeList label="Shows" ids={props.entry.nodes.map((n) => n.id)} empty="no components" />
			</dl>
		</Show>
		<Show when={props.entry.node}>
			{(node) => (
				<dl class="ds-meta">
					<div class="ds-meta-row">
						<dt>Source</dt>
						<dd>
							<code class="ds-story-file">
								{node().file}:{node().line}
							</code>
							<span class="ds-chip-note">
								{node().exportNames.length > 0
									? `export ${node().exportNames.join(", ")}`
									: "not exported"}
							</span>
						</dd>
					</div>
					<NodeList label="Renders" ids={node().children} empty="no project components (leaf)" />
					<NodeList
						label="Used by"
						ids={node().parents}
						empty="not rendered by another component"
					/>
				</dl>
			)}
		</Show>
	</>
);
