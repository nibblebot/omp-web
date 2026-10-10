import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
	type Component,
} from "solid-js";
import { ChevronDownIcon, ChevronRightIcon } from "../web/components/ui/icons";
import {
	currentThemePreference,
	setTheme,
	THEME_OPTIONS,
	type ThemePreference,
} from "../web/prefs/theme";
import {
	byTitle,
	entries,
	entryByNodeId,
	entryByStoryId,
	navChildren,
	navExtras,
	navGroupLabel,
	navPath,
	nodeById,
	nodeLabel,
	rootNode,
	type StoryEntry,
} from "./catalog";
import { Coverage } from "./coverage";
import { StoryView } from "./stage";

type Route =
	| { kind: "home" }
	| { kind: "coverage" }
	| { kind: "story"; entry: StoryEntry }
	| { kind: "missing"; id: string };

function parseRoute(hash: string): Route {
	const path = hash.replace(/^#\/?/, "");
	if (path === "") return { kind: "home" };
	if (path === "coverage") return { kind: "coverage" };
	const entry = entryByStoryId.get(path);
	return entry ? { kind: "story", entry } : { kind: "missing", id: path };
}

const [hash, setHash] = createSignal(location.hash);

/** Search text: title, id, folder or section, and every component the story shows (so "check" finds Icons). */
const matches = (entry: StoryEntry, query: string): boolean =>
	[
		entry.story.title,
		entry.story.id,
		entry.story.section ?? entry.node?.group ?? "",
		...entry.nodes.map(nodeLabel),
	]
		.join(" ")
		.toLowerCase()
		.includes(query.toLowerCase());

const extras = navExtras();

/** Expanded tree rows, keyed by their drill-down path ("App>ModalHost>…"); App starts open. */
const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(
	new Set(rootNode ? [rootNode.id] : []),
);

function toggle(key: string): void {
	setExpanded((prev) => {
		const next = new Set(prev);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	});
}

/** Open every row on the shortest path from App to `nodeId`, so the current story is visible. */
function reveal(nodeId: string): void {
	const path = navPath(nodeId);
	if (!path) return;
	setExpanded((prev) => {
		const next = new Set(prev);
		for (let i = 1; i < path.length; i++) next.add(path.slice(0, i).join(">"));
		return next;
	});
}

const NavLink: Component<{ entry: StoryEntry; current: Route; note?: string }> = (props) => (
	<a
		class="ds-nav-link"
		href={`#/${props.entry.story.id}`}
		aria-current={
			props.current.kind === "story" && props.current.entry === props.entry ? "page" : undefined
		}
	>
		{props.entry.story.title}
		<Show when={props.note}>{(note) => <span class="ds-nav-note">{note()}</span>}</Show>
	</a>
);

/**
 * One row in the App tree: a component (a link to its story) or a folder row
 * grouping what a component renders from one feature folder, with a toggle to
 * drill into its children.
 */
const TreeNode: Component<{ id: string; path: string; current: Route }> = (props) => {
	const kids = () => navChildren(props.id);
	const open = () => expanded().has(props.path);
	const label = () => {
		const node = nodeById.get(props.id);
		return navGroupLabel(props.id) ?? (node ? nodeLabel(node) : props.id);
	};
	return (
		<li class="ds-tree-item">
			<div class="ds-tree-row">
				<Show when={kids().length > 0} fallback={<span class="ds-tree-spacer" />}>
					<button
						type="button"
						class="ds-tree-toggle"
						aria-expanded={open()}
						aria-label={`${open() ? "Collapse" : "Expand"} ${label()}`}
						onClick={() => toggle(props.path)}
					>
						<Show when={open()} fallback={<ChevronRightIcon />}>
							<ChevronDownIcon />
						</Show>
					</button>
				</Show>
				<Show
					when={entryByNodeId.get(props.id)}
					fallback={<span class="ds-tree-label">{label()}</span>}
				>
					{(entry) => <NavLink entry={entry()} current={props.current} />}
				</Show>
			</div>
			<Show when={open()}>
				<ul class="ds-tree">
					<For each={kids()}>
						{(child) => (
							<TreeNode id={child} path={`${props.path}>${child}`} current={props.current} />
						)}
					</For>
				</ul>
			</Show>
		</li>
	);
};

const NavList: Component<{ title: string; list: StoryEntry[]; current: Route }> = (props) => (
	<Show when={props.list.length > 0}>
		<section class="ds-nav-section">
			<h2 class="ds-nav-heading">{props.title}</h2>
			<For each={props.list}>{(entry) => <NavLink entry={entry} current={props.current} />}</For>
		</section>
	</Show>
);

const ThemeSwitcher: Component = () => {
	const [pref, setPref] = createSignal<ThemePreference>(currentThemePreference());
	return (
		<label class="ds-theme">
			<span>Theme</span>
			<select
				value={pref()}
				onChange={(e) => setPref(setTheme(e.currentTarget.value as ThemePreference))}
			>
				<For each={THEME_OPTIONS}>{(opt) => <option value={opt.id}>{opt.label}</option>}</For>
			</select>
		</label>
	);
};

/**
 * App at the top, drilled down by what each component renders, with pieces
 * from other feature folders grouped under folder rows. App's file-local
 * screens ("Chat Mode", "Analysis Mode") are rows of their own, each drilled
 * down the same way. `ui/` primitives and Icons sit in one list below the
 * tree; a search replaces both with a flat list of matches.
 */
const Sidebar: Component<{ current: Route }> = (props) => {
	const [query, setQuery] = createSignal("");
	const results = createMemo(() =>
		query().trim() === "" ? [] : entries.filter((e) => matches(e, query().trim())).sort(byTitle),
	);
	createEffect(() => {
		const route = props.current;
		if (route.kind !== "story" || !route.entry.node) return;
		reveal(route.entry.node.id);
		requestAnimationFrame(() =>
			document.querySelector(".ds-nav [aria-current=page]")?.scrollIntoView({ block: "nearest" }),
		);
	});
	return (
		<nav class="ds-nav">
			<a class="ds-brand" href="#/">
				omp web design system
			</a>
			<ThemeSwitcher />
			<input
				class="ds-search"
				type="search"
				placeholder="Filter components"
				value={query()}
				onInput={(e) => setQuery(e.currentTarget.value)}
			/>
			<Show
				when={query().trim() === ""}
				fallback={
					<section class="ds-nav-section">
						<For each={results()} fallback={<p class="ds-empty">No component matches.</p>}>
							{(entry) => (
								<NavLink
									entry={entry}
									current={props.current}
									note={entry.story.section ?? entry.node?.group}
								/>
							)}
						</For>
					</section>
				}
			>
				<Show when={rootNode}>
					{(root) => (
						<ul class="ds-tree ds-tree-root">
							<TreeNode id={root().id} path={root().id} current={props.current} />
						</ul>
					)}
				</Show>
				<NavList
					title="Primitives"
					list={[...extras.sections, ...extras.primitives]}
					current={props.current}
				/>
				<NavList title="Not rendered by App" list={extras.unreached} current={props.current} />
				<NavList title="Broken references" list={extras.broken} current={props.current} />
			</Show>
			<a
				class="ds-nav-link ds-nav-footer"
				href="#/coverage"
				aria-current={props.current.kind === "coverage" ? "page" : undefined}
			>
				Coverage
			</a>
		</nav>
	);
};

export const Shell: Component = () => {
	const onHash = () => setHash(location.hash);
	window.addEventListener("hashchange", onHash);
	onCleanup(() => window.removeEventListener("hashchange", onHash));
	const route = createMemo(() => parseRoute(hash()));
	return (
		<div class="ds-shell">
			<Sidebar current={route()} />
			<main class="ds-main">
				<Switch>
					<Match when={route().kind === "home"}>
						<h1 class="ds-page-title">Component showcase</h1>
						<p class="ds-lede">
							Real components from apps/web with example data. The sidebar starts at App and drills
							down through what each component renders; shared primitives and icons are listed below
							it. See <a href="#/coverage">Coverage</a> for every exported component.
						</p>
					</Match>
					<Match when={route()} keyed>
						{(r) => (
							<Switch>
								<Match when={r.kind === "coverage"}>
									<Coverage />
								</Match>
								<Match when={r.kind === "story" && r}>
									{(s) => <StoryView entry={s().entry} />}
								</Match>
								<Match when={r.kind === "missing" && r}>
									{(m) => <p class="ds-error">Unknown story: {m().id}</p>}
								</Match>
							</Switch>
						)}
					</Match>
				</Switch>
			</main>
		</div>
	);
};
