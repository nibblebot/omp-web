import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { pushNotice, state } from "../../state";
import { PickerRow } from "../ui/PickerRow";
import {
	branchFromEntry,
	loadGraph,
	navigateToEntry,
	reanswerAsk,
	takeTreeSeed,
	treeSeed,
	type GraphFilter,
	type GraphNode,
	type GraphPage,
} from "../../store/graph";
import { stashUnsent } from "../../store/drafts";
import { createDebouncer } from "../../store/search-debounce";

/**
 * Session tree pane body, hosted by the dock (DockHost). Mirrors the
 * TUI tree selector: nodes indented by depth, the active path marked, server
 * filters, Up/Down to move, Enter to navigate, Shift+Enter to navigate with an
 * abandoned-branch summary. Navigate stays in this file; Branch copies to a
 * new file. Selecting a node keeps the pane open and the transcript follows.
 */

const FILTERS: Array<{ value: GraphFilter; label: string }> = [
	{ value: "all", label: "all" },
	{ value: "user", label: "user-only" },
	{ value: "conversation", label: "no-tools" },
	{ value: "tool", label: "tools" },
	{ value: "label", label: "labeled-only" },
];

function kindLabel(n: GraphNode): string {
	switch (n.type) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "tool":
			return "tool";
		case "ask":
			return "ask re-answer";
		case "compaction":
			return "compaction";
		case "summary":
			return "summary";
		case "model":
			return "model";
		case "control":
			return "control";
		default:
			return n.label ? `other · ${n.label}` : "other";
	}
}

function relTime(iso: string): string {
	if (!iso) return "";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "";
	const d = Date.now() - t;
	if (d < 60_000) return "just now";
	if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
	if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
	return new Date(t).toLocaleString();
}

/** Depth of each node through its loaded ancestors. A filtered page can drop
 *  intermediate parents, so depth is relative to what is on screen. */
export function depthIndex(nodes: GraphNode[]): Map<string, number> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const depth = new Map<string, number>();
	const chain: GraphNode[] = [];
	const climbing = new Set<string>();
	for (const n of nodes) {
		// Climb to the first ancestor whose depth is known (or off the page), then number the
		// climbed chain on the way down, so every node is visited once. A malformed parent
		// cycle ends where it re-enters itself.
		let above: GraphNode | undefined = n;
		while (above && !depth.has(above.id) && !climbing.has(above.id)) {
			climbing.add(above.id);
			chain.push(above);
			above = above.parentId ? byId.get(above.parentId) : undefined;
		}
		let d = above === undefined || climbing.has(above.id) ? 0 : (depth.get(above.id) ?? 0) + 1;
		while (chain.length > 0) depth.set(chain.pop()!.id, d++);
		climbing.clear();
	}
	return depth;
}

/** Ids from the leaf back to the root through loaded nodes: the active path. */
export function activePath(nodes: GraphNode[], leafId: string | null): Set<string> {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const path = new Set<string>();
	let cur = leafId ? byId.get(leafId) : undefined;
	while (cur && !path.has(cur.id)) {
		path.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return path;
}

export const SessionTreePanel: Component = () => {
	const [page, setPage] = createSignal<GraphPage | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [filter, setFilter] = createSignal("");
	const [kind, setKind] = createSignal<GraphFilter>("all");
	const [selectedId, setSelectedId] = createSignal<string | null>(null);
	const [summarize, setSummarize] = createSignal(false);
	const [instructions, setInstructions] = createSignal("");
	const [busyId, setBusyId] = createSignal<string | null>(null);
	const [askPending, setAskPending] = createSignal(false);
	const [foldNote, setFoldNote] = createSignal<string | null>(null);
	let listEl: HTMLDivElement | undefined;

	const revision = createMemo(() => page()?.revision);
	const nodes = createMemo(() => page()?.nodes ?? []);
	const depths = createMemo(() => depthIndex(nodes()));
	/** Loaded children per parent id: a row's children and siblings are counts off one pass. */
	const childCounts = createMemo(() => {
		const counts = new Map<string, number>();
		for (const n of nodes()) {
			if (n.parentId !== null) counts.set(n.parentId, (counts.get(n.parentId) ?? 0) + 1);
		}
		return counts;
	});
	const onPath = createMemo(() => activePath(nodes(), page()?.leafId ?? null));

	/** Typing in the node search refreshes once per pause, not per keystroke. */
	const typingPause = createDebouncer();
	onCleanup(typingPause.cancel);
	/** Issue number of the latest fresh load: an older answer, or an append for an older page, is dropped. */
	let refreshIssue = 0;
	const refresh = (opts: { cursor?: string; append?: boolean; keepError?: boolean } = {}): void => {
		typingPause.cancel();
		const issue = opts.append ? refreshIssue : ++refreshIssue;
		void loadGraph({
			filter: kind(),
			text: filter().trim(),
			...(opts.cursor ? { cursor: opts.cursor } : {}),
			limit: 100,
		})
			.then((p) => {
				if (issue !== refreshIssue) return;
				if (opts.append && page()) {
					const prev = page()!;
					setPage({ ...p, nodes: [...prev.nodes, ...p.nodes] });
				} else {
					setPage(p);
				}
				if (!opts.keepError) setError(null);
			})
			.catch((err) => {
				if (issue === refreshIssue) setError(String(err instanceof Error ? err.message : err));
			});
	};

	onMount(() => {
		// Stash the leaving composer's unsent text (Main preserved on focus
		// changes); navigation restores returned editorText explicitly.
		stashUnsent();
		const pre = takeTreeSeed();
		if (pre) setFilter(pre);
		refresh();
	});
	// A card branch re-seeds the filter even when the pane is already open.
	createEffect(
		on(
			treeSeed,
			(seed) => {
				if (seed === null) return;
				takeTreeSeed();
				setFilter(seed);
				refresh();
			},
			{ defer: true },
		),
	);
	// A finished turn adds entries and changes the page revision; a pane left open would
	// otherwise keep a stale revision and refuse every navigation.
	createEffect(
		on(
			() => state.streaming,
			(streaming, was) => {
				if (was && !streaming) refresh();
			},
			{ defer: true },
		),
	);

	const onFilterInput = (value: string): void => {
		setFilter(value);
		typingPause.schedule(refresh);
	};

	/** Select a row and move DOM focus to it so Enter acts on the same node. */
	const select = (id: string): void => {
		setSelectedId(id);
		const row = Array.from(listEl?.querySelectorAll<HTMLElement>("[data-node-id]") ?? []).find(
			(el) => el.dataset.nodeId === id,
		);
		row?.querySelector<HTMLElement>("button.graph-row")?.focus();
		row?.scrollIntoView({ block: "nearest" });
	};

	const onListKeyDown = (e: KeyboardEvent): void => {
		// Only the row buttons own these keys; inputs inside the detail keep theirs.
		if (!(e.target instanceof HTMLElement) || !e.target.matches("button.graph-row")) return;
		const rows = nodes();
		if (rows.length === 0) return;
		// Keys act from the focused row so Tab focus and arrows agree; selection is the fallback.
		const focusedId = e.target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
		const idx = rows.findIndex((n) => n.id === (focusedId ?? selectedId()));
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const from = idx < 0 ? (e.key === "ArrowDown" ? -1 : rows.length) : idx;
			const to = Math.min(rows.length - 1, Math.max(0, from + (e.key === "ArrowDown" ? 1 : -1)));
			select(rows[to]!.id);
			return;
		}
		if (e.key === "Enter" && idx >= 0) {
			// preventDefault also stops the button's synthetic click.
			e.preventDefault();
			runNavigate(rows[idx]!, { summarize: e.shiftKey });
		}
	};

	const runNavigate = (node: GraphNode, opts: { summarize?: boolean } = {}): void => {
		if (busyId()) return;
		setBusyId(node.id);
		setFoldNote(null);
		const summary = opts.summarize ?? summarize();
		void navigateToEntry(
			node.id,
			{
				...(summary ? { summarize: true } : {}),
				...(instructions().trim() ? { customInstructions: instructions().trim() } : {}),
			},
			revision(),
		)
			.then((out) => {
				if (out.kind === "askReopen") {
					// busyId stays set until the re-answer settles.
					runAskReanswer(node.id);
					return;
				}
				setBusyId(null);
				if (out.kind === "cancelled") return;
				if (out.kind === "branched") return;
				pushNotice(
					"info",
					out.summaryId
						? "Navigated (same file) — abandoned branch summarized."
						: "Navigated (same file) — previous branch preserved.",
				);
				refresh();
			})
			.catch((err) => {
				setBusyId(null);
				const text = String(err instanceof Error ? err.message : err);
				setError(text);
				// A stale selection means the page revision moved on (a turn finished or the
				// transcript was replaced); reload so the next pick runs against the current tree.
				if (/stale/i.test(text)) refresh({ keepError: true });
			});
	};

	const runBranch = (node: GraphNode): void => {
		if (busyId()) return;
		setBusyId(node.id);
		void branchFromEntry(node.id)
			.then(() => {
				setBusyId(null);
				refresh();
			})
			.catch((err) => {
				setBusyId(null);
				setError(String(err instanceof Error ? err.message : err));
			});
	};

	/** Probe answered: the session now asks in the composer; wait for the answer, then resume. */
	const runAskReanswer = (targetId: string): void => {
		setAskPending(true);
		void reanswerAsk(targetId)
			.then((committed) => {
				if (committed) refresh();
				else pushNotice("info", "Re-answer cancelled.");
			})
			.catch((err) => {
				const text = String(err instanceof Error ? err.message : err);
				setError(text);
				if (/stale|changed/i.test(text)) refresh({ keepError: true });
			})
			.finally(() => {
				setAskPending(false);
				setBusyId(null);
			});
	};

	return (
		<>
			<div class="picker-group-name">
				Navigate stays in this file (previous branch preserved). Branch copies to a NEW file.
			</div>
			<Show when={askPending()}>
				<div class="tool-collapsed-note" role="status">
					Answer the question in the composer (the old answer is kept).
				</div>
			</Show>
			<div class="graph-filters" role="group" aria-label="Node kind filter">
				<For each={FILTERS}>
					{(f) => (
						<button
							type="button"
							class="graph-filter"
							aria-pressed={kind() === f.value}
							onClick={() => {
								setKind(f.value);
								refresh();
							}}
						>
							{f.label}
						</button>
					)}
				</For>
			</div>
			<input
				class="picker-filter"
				aria-label="Search nodes"
				placeholder="Search text or label…"
				value={filter()}
				onInput={(e) => onFilterInput(e.currentTarget.value)}
			/>
			<Show when={error()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<Show when={foldNote()}>{(n) => <div class="tool-collapsed-note">{n()}</div>}</Show>
			<div class="picker-list graph-list" ref={(el) => (listEl = el)} onKeyDown={onListKeyDown}>
				<For each={nodes()}>
					{(n) => {
						const selected = () => selectedId() === n.id;
						const kids = () => childCounts().get(n.id) ?? 0;
						const sibs = () => (n.parentId === null ? 0 : (childCounts().get(n.parentId) ?? 1) - 1);
						const isLeaf = () => n.id === page()?.leafId;
						return (
							<div
								class="graph-node"
								classList={{ active: selected(), "on-path": onPath().has(n.id) }}
								data-node-id={n.id}
							>
								<PickerRow
									class="picker-row graph-row"
									aria-selected={selected()}
									onClick={() => select(n.id)}
								>
									<span
										class="graph-indent"
										style={{ width: `${(depths().get(n.id) ?? 0) * 14}px` }}
										aria-hidden="true"
									/>
									<span class="graph-marker" aria-hidden="true">
										{isLeaf() ? "●" : onPath().has(n.id) ? "│" : " "}
									</span>
									<span class="picker-chip">{kindLabel(n)}</span>
									<span class="picker-label">{n.preview || "(no text)"}</span>
									<span class="picker-meta">
										{n.label ? `🏷 ${n.label} · ` : ""}
										{relTime(n.timestamp)}
										{n.hasImages ? " · 🖼" : ""}
										{isLeaf() ? " · leaf" : ""}
									</span>
								</PickerRow>
								<Show when={selected()}>
									<div class="graph-detail">
										<Show when={sibs() > 0}>
											<div class="tool-collapsed-note">
												{sibs()} sibling{sibs() === 1 ? "" : "s"} on this fork (same page)
											</div>
										</Show>
										<Show when={kids() > 0}>
											<div class="tool-collapsed-note">
												{kids()} child{kids() === 1 ? "" : "ren"} below
											</div>
										</Show>
										<label class="graph-opt">
											<input
												type="checkbox"
												checked={summarize()}
												onChange={(e) => setSummarize(e.currentTarget.checked)}
											/>
											summarize abandoned branch at target (Shift+Enter)
										</label>
										<Show when={summarize()}>
											<input
												class="picker-filter"
												aria-label="Summary instructions"
												placeholder="Summary focus (optional)…"
												value={instructions()}
												onInput={(e) => setInstructions(e.currentTarget.value)}
											/>
										</Show>
										<div class="graph-actions">
											<button
												type="button"
												title="Same-file navigation — previous branch preserved (Enter)"
												disabled={busyId() !== null}
												onClick={() => runNavigate(n)}
											>
												{busyId() === n.id ? "Navigating…" : "Navigate here"}
											</button>
											<button
												type="button"
												title="New-file branch — copies history to another session file"
												disabled={busyId() !== null}
												onClick={() => runBranch(n)}
											>
												{busyId() === n.id ? "Branching…" : "Branch to new file"}
											</button>
										</div>
									</div>
								</Show>
							</div>
						);
					}}
				</For>
				{nodes().length === 0 && !error() && (
					<div class="tool-collapsed-note">no matching nodes</div>
				)}
			</div>
			<Show when={page()?.hasMore}>
				<button
					type="button"
					class="picker-row"
					onClick={() => {
						const c = page()?.nextCursor;
						if (c) refresh({ cursor: c, append: true });
						else setFoldNote("Older history is available server-side; paging continues on next.");
					}}
				>
					Load older history…
				</button>
			</Show>
		</>
	);
};
