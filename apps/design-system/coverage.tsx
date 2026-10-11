import { For, Show, type Component } from "solid-js";
import {
	compareGroups,
	entries,
	entryByNodeId,
	exportedNodes,
	nodeLabel,
	nodes,
	tierLabel,
} from "./catalog";
import { NodeLink } from "./meta";

const ordered = [...exportedNodes].sort(
	(a, b) =>
		a.tier - b.tier ||
		compareGroups(a.group, b.group) ||
		nodeLabel(a).localeCompare(nodeLabel(b)) ||
		a.file.localeCompare(b.file),
);
const locals = nodes
	.filter((n) => n.exportNames.length === 0)
	.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const covered = ordered.filter((n) => entryByNodeId.has(n.id)).length;
const broken = entries.filter((e) => e.error !== null);

/** Every exported component with its tier and story status, plus locals and broken story refs. */
export const Coverage: Component = () => (
	<>
		<h1 class="ds-page-title">Coverage</h1>
		<p class="ds-lede" data-testid="coverage-count">
			{covered} of {ordered.length} exported components have a story ({ordered.length - covered}{" "}
			missing). {locals.length} file-local components are shown via their parents.
		</p>
		<Show when={broken.length > 0}>
			<h2 class="ds-section-title">Broken story references</h2>
			<For each={broken}>
				{(entry) => (
					<p class="ds-error">
						<strong>{entry.story.id}</strong>: {entry.error}
					</p>
				)}
			</For>
		</Show>
		<h2 class="ds-section-title">Exported components</h2>
		<table class="ds-table">
			<thead>
				<tr>
					<th>Component</th>
					<th>Tier</th>
					<th>Group</th>
					<th>File</th>
					<th>Story</th>
				</tr>
			</thead>
			<tbody>
				<For each={ordered}>
					{(node) => (
						<tr>
							<td>{nodeLabel(node)}</td>
							<td title={tierLabel(node.tier)}>{node.tier}</td>
							<td>{node.group}</td>
							<td>
								<code class="ds-story-file">
									{node.file}:{node.line}
								</code>
							</td>
							<td>
								<Show
									when={entryByNodeId.get(node.id)}
									fallback={<span class="ds-missing">missing</span>}
								>
									{(entry) => <a href={`#/stories/${entry().story.id}`}>{entry().story.title}</a>}
								</Show>
							</td>
						</tr>
					)}
				</For>
			</tbody>
		</table>
		<h2 class="ds-section-title">File-local components</h2>
		<table class="ds-table">
			<thead>
				<tr>
					<th>Component</th>
					<th>Tier</th>
					<th>Shown via</th>
				</tr>
			</thead>
			<tbody>
				<For each={locals}>
					{(node) => (
						<tr>
							<td>
								{node.name}
								<span class="ds-chip-note">
									{node.file}:{node.line}
								</span>
							</td>
							<td>{node.tier}</td>
							<td>
								<Show
									when={node.parents.length > 0}
									fallback={<span class="ds-missing">rendered by no component</span>}
								>
									<For each={node.parents}>{(id) => <NodeLink id={id} />}</For>
								</Show>
							</td>
						</tr>
					)}
				</For>
			</tbody>
		</table>
	</>
);
