import graph from "ds:graph";
import stories from "ds:stories";
import type { GraphNode } from "./graph-types";
import type { ComponentRef, Story } from "./registry";

/** A story joined with the graph node(s) it showcases. */
export interface StoryEntry {
	story: Story;
	/** The single component's node, which places the story in its tier. Null for component lists and broken refs. */
	node: GraphNode | null;
	/** Every resolved node the story shows (one, or the whole family for a list). */
	nodes: GraphNode[];
	/** Why the entry is unusable: unknown component ref, list without a section, duplicate id. */
	error: string | null;
}

export const nodes: GraphNode[] = graph.nodes;
export const nodeById = new Map(nodes.map((n) => [n.id, n]));

/** Display name: the first export name, else the local declaration name. */
export function nodeLabel(node: GraphNode): string {
	const exported = node.exportNames[0];
	return exported === undefined || exported === "default" ? node.name : exported;
}

const seenIds = new Set<string>();
export const entries: StoryEntry[] = stories.map((story) => {
	const refs: ComponentRef[] = Array.isArray(story.component) ? story.component : [story.component];
	const resolved: GraphNode[] = [];
	const unknown: string[] = [];
	for (const ref of refs) {
		const found = nodes.find((n) => n.file === ref.file && n.exportNames.includes(ref.export));
		if (found) resolved.push(found);
		else unknown.push(`${ref.file} does not export a component named "${ref.export}"`);
	}
	let error: string | null = null;
	if (unknown.length > 0) {
		error = `Unknown component: ${unknown.join("; ")} (not in the component graph).`;
	} else if (Array.isArray(story.component) && story.section === undefined) {
		error = "A story that lists several components needs a `section` for its nav placement.";
	} else if (seenIds.has(story.id)) {
		error = `Duplicate story id "${story.id}".`;
	}
	seenIds.add(story.id);
	const node = !Array.isArray(story.component) && error === null ? (resolved[0] ?? null) : null;
	return { story, node, nodes: resolved, error };
});

/** First story per graph node, for child/parent links and coverage. */
export const entryByNodeId = new Map<string, StoryEntry>();
for (const entry of entries) {
	if (entry.error !== null) continue;
	for (const node of entry.nodes) {
		if (!entryByNodeId.has(node.id)) entryByNodeId.set(node.id, entry);
	}
}

export const entryByStoryId = new Map(entries.map((e) => [e.story.id, e]));

export function tierLabel(tier: number): string {
	if (tier === 0) return "Tier 0: leaves";
	return `Tier ${tier}: composes ${tier === 1 ? "tier 0" : `tiers 0-${tier - 1}`}`;
}

/**
 * Coverage-table order of top-level feature folders (apps/web/components/<feature>,
 * then tx and root app files): primitives first, then the shell, then
 * features roughly in screen order. Anything else sorts after, alphabetically.
 */
const FEATURE_ORDER = [
	"ui",
	"app",
	"chat",
	"requests",
	"sessions",
	"models",
	"settings",
	"usage",
	"fleet",
	"subagents",
	"review",
	"tx",
];

/** Splits a group path ("chat/tools") into its feature ("chat") and subfolder ("tools", or null at the feature root). */
function splitGroup(group: string): { feature: string; folder: string | null } {
	const [feature = group, ...rest] = group.split("/");
	return { feature, folder: rest.length > 0 ? rest.join("/") : null };
}

/** Orders group paths by feature (FEATURE_ORDER), then the feature root, then subfolders alphabetically. */
export function compareGroups(a: string, b: string): number {
	const ga = splitGroup(a);
	const gb = splitGroup(b);
	if (ga.feature !== gb.feature) {
		const ia = FEATURE_ORDER.indexOf(ga.feature);
		const ib = FEATURE_ORDER.indexOf(gb.feature);
		if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		return ga.feature.localeCompare(gb.feature);
	}
	if (ga.folder === gb.folder) return 0;
	if (ga.folder === null) return -1;
	if (gb.folder === null) return 1;
	return ga.folder.localeCompare(gb.folder);
}

export const byTitle = (a: StoryEntry, b: StoryEntry): number =>
	a.story.title.localeCompare(b.story.title);

/** The top of the drill-down nav: the App component every screen hangs off. */
export const rootNode: GraphNode | null =
	nodes.find((n) => n.file === "apps/web/App.tsx" && n.exportNames.includes("App")) ?? null;

const isPrimitive = (node: GraphNode): boolean => node.group === "ui";

/** A folder row in the drill-down nav: the stories one component renders from one feature folder. */
interface NavGroup {
	label: string;
	children: string[];
}
const navGroups = new Map<string, NavGroup>();

/**
 * Whether `child` (a node `parentId` renders) is a mode row: a story-less
 * component declared in the root's own file, so App's file-local screens
 * ("ChatMode", "AnalysisMode") stay as rows of their own instead of being
 * flattened into App's children.
 */
function isModeRow(parentId: string, child: GraphNode): boolean {
	return (
		rootNode !== null &&
		parentId === rootNode.id &&
		child.file === rootNode.file &&
		!entryByNodeId.has(child.id)
	);
}

/**
 * Row label of a nav row that isn't a plain component: the folder label
 * ("chat/", "status/") of a nav group, or the PascalCase name split into words
 * ("Chat Mode") of a mode row. Null for a component id.
 */
export function navGroupLabel(id: string): string | null {
	const group = navGroups.get(id);
	if (group) return group.label;
	const node = nodeById.get(id);
	if (!node || !rootNode || node.id === rootNode.id) return null;
	if (node.file !== rootNode.file || entryByNodeId.has(id)) return null;
	return nodeLabel(node).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

const storyCache = new Map<string, string[]>();
/**
 * The stories a node renders, in render order: `ui/` primitives are left to
 * their own section (they appear under almost everything), and nodes without
 * a story (file-local helpers) are skipped with their own children pulled up
 * in their place. The exception is the root's own file-local components
 * (App's "ChatMode" and "AnalysisMode"), which stay as mode rows.
 */
function renderedStories(id: string): string[] {
	const cached = storyCache.get(id);
	if (cached) return cached;
	const out: string[] = [];
	for (const childId of nodeById.get(id)?.children ?? []) {
		const child = nodeById.get(childId);
		if (!child || isPrimitive(child)) continue;
		const pulled =
			entryByNodeId.has(childId) || isModeRow(id, child) ? [childId] : renderedStories(childId);
		for (const next of pulled) if (!out.includes(next)) out.push(next);
	}
	storyCache.set(id, out);
	return out;
}

/**
 * Buckets `ids` by `keyOf`. Two or more members sharing a key become one group
 * row (`<owner>@<key>`, children from `inner`) at the first member's position;
 * null keys and lone members stay in place. A group whose members all sit in
 * one inner group is that inner group, relabeled with both folders ("fleet/workspaces/").
 */
function groupRows(
	owner: string,
	ids: string[],
	keyOf: (node: GraphNode) => string | null,
	inner: (members: string[]) => string[],
): string[] {
	const keyById = new Map<string, string | null>();
	for (const id of ids) {
		const node = nodeById.get(id);
		keyById.set(id, node ? keyOf(node) : null);
	}
	const buckets = new Map<string, string[]>();
	for (const [id, key] of keyById)
		if (key !== null) buckets.set(key, [...(buckets.get(key) ?? []), id]);
	const out: string[] = [];
	const placed = new Set<string>();
	for (const [id, key] of keyById) {
		const members = key === null ? undefined : buckets.get(key);
		if (key === null || !members || members.length < 2) {
			out.push(id);
			continue;
		}
		if (placed.has(key)) continue;
		placed.add(key);
		const label = `${key.split("/").at(-1)}/`;
		const children = inner(members);
		const only = children.length === 1 ? navGroups.get(children[0] as string) : undefined;
		if (only) {
			only.label = `${label}${only.label}`;
			out.push(children[0] as string);
			continue;
		}
		const groupId = `${owner}@${key}`;
		navGroups.set(groupId, { label, children });
		out.push(groupId);
	}
	return out;
}

const childCache = new Map<string, string[]>();
/**
 * A row's children as the drill-down nav shows them, in render order. For a
 * component: the stories it renders (see renderedStories), with the ones from
 * other features grouped into a folder row per feature ("chat/"), and inside
 * that a row per subfolder ("status/"), so a component that composes many
 * features (App, ModalHost) shows a few big pieces instead of every piece.
 * Stories from the component's own feature, feature roots, and a folder's
 * only story stay ungrouped, as do App's mode rows ("Chat Mode"), which are
 * grouped by feature relative to themselves like any other component. For a
 * folder row: its members.
 */
export function navChildren(id: string): string[] {
	const group = navGroups.get(id);
	if (group) return group.children;
	const cached = childCache.get(id);
	if (cached) return cached;
	const node = nodeById.get(id);
	const ownFeature = node ? splitGroup(node.group).feature : null;
	const out = groupRows(
		id,
		renderedStories(id),
		(child) => {
			if (isModeRow(id, child)) return null;
			const { feature } = splitGroup(child.group);
			return feature === ownFeature ? null : feature;
		},
		(members) =>
			groupRows(
				id,
				members,
				(child) => {
					const { feature, folder } = splitGroup(child.group);
					return folder === null ? null : `${feature}/${folder.split("/")[0]}`;
				},
				(sub) => sub,
			),
	);
	childCache.set(id, out);
	return out;
}

/** Shortest drill-down path from the root to a node (root first), or null when App never renders it. */
export function navPath(target: string): string[] | null {
	if (!rootNode) return null;
	const prev = new Map<string, string | null>([[rootNode.id, null]]);
	const queue = [rootNode.id];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (id === target) {
			const path: string[] = [];
			for (let at: string | null = id; at !== null; at = prev.get(at) ?? null) path.unshift(at);
			return path;
		}
		for (const child of navChildren(id)) {
			if (!prev.has(child)) {
				prev.set(child, id);
				queue.push(child);
			}
		}
	}
	return null;
}

/**
 * Stories outside the App tree: `ui/` primitives, named-section pages
 * (Icons), anything App never renders, and broken refs.
 */
export function navExtras(): {
	primitives: StoryEntry[];
	sections: StoryEntry[];
	unreached: StoryEntry[];
	broken: StoryEntry[];
} {
	const reached = new Set<string>();
	const walk = (id: string): void => {
		if (reached.has(id)) return;
		reached.add(id);
		for (const child of navChildren(id)) walk(child);
	};
	if (rootNode) walk(rootNode.id);
	const valid = entries.filter((e) => e.error === null);
	return {
		primitives: valid
			.filter((e) => e.story.section === undefined && e.node && isPrimitive(e.node))
			.sort(byTitle),
		sections: valid.filter((e) => e.story.section !== undefined).sort(byTitle),
		unreached: valid
			.filter((e) => e.story.section === undefined && e.node && !isPrimitive(e.node))
			.filter((e) => e.node && !reached.has(e.node.id))
			.sort(byTitle),
		broken: entries.filter((e) => e.error !== null),
	};
}

/** Every graph component that its file exports, i.e. the ones that need a story. */
export const exportedNodes = nodes.filter((n) => n.exportNames.length > 0);
