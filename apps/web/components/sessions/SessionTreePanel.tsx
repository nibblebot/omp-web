import { createMemo, createSignal, For, onMount, Show, type Component } from "solid-js";
import { pushNotice, setState } from "../../state";
import { PickerRow } from "../ui/PickerRow";
import {
	branchFromEntry,
	completeAskReanswer,
	consumeBranchModalPrefilter,
	loadGraph,
	navigateToEntry,
	type GraphFilter,
	type GraphNode,
	type GraphPage,
} from "../../store/graph";
import { stashUnsent } from "../../store/drafts";
import type { AskQuestion } from "../../prompt/ask-types";

/**
 * Session tree body, shell-less so a docked pane can re-host it. Mirrors the
 * TUI tree selector: nodes indented by depth, the active path marked, server
 * filters, Up/Down to move, Enter to navigate, Shift+Enter to navigate with an
 * abandoned-branch summary. Navigate stays in this file; Branch copies to a
 * new file. Esc is owned by the Modal shell that hosts this body.
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
	for (const n of nodes) {
		let d = 0;
		let cur = n.parentId ? byId.get(n.parentId) : undefined;
		while (cur && d < nodes.length) {
			d++;
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
		depth.set(n.id, d);
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

export const SessionTreePanel: Component<{ onClose: () => void }> = (props) => {
	const [page, setPage] = createSignal<GraphPage | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [filter, setFilter] = createSignal("");
	const [kind, setKind] = createSignal<GraphFilter>("all");
	const [selectedId, setSelectedId] = createSignal<string | null>(null);
	const [summarize, setSummarize] = createSignal(false);
	const [instructions, setInstructions] = createSignal("");
	const [busyId, setBusyId] = createSignal<string | null>(null);
	const [askReopen, setAskReopen] = createSignal<{
		targetId: string;
		toolCallId: string;
		questions: AskQuestion[];
	} | null>(null);
	const [askDraft, setAskDraft] = createSignal<Array<{ selected: string[]; custom: string }>>([]);
	const [foldNote, setFoldNote] = createSignal<string | null>(null);
	let listEl: HTMLDivElement | undefined;

	const revision = createMemo(() => page()?.revision);
	const nodes = createMemo(() => page()?.nodes ?? []);
	const depths = createMemo(() => depthIndex(nodes()));
	const onPath = createMemo(() => activePath(nodes(), page()?.leafId ?? null));

	const refresh = (opts: { cursor?: string; append?: boolean } = {}): void => {
		void loadGraph({
			filter: kind(),
			text: filter().trim(),
			...(opts.cursor ? { cursor: opts.cursor } : {}),
			limit: 100,
		})
			.then((p) => {
				if (opts.append && page()) {
					const prev = page()!;
					setPage({ ...p, nodes: [...prev.nodes, ...p.nodes] });
				} else {
					setPage(p);
				}
				setError(null);
			})
			.catch((err) => setError(String(err instanceof Error ? err.message : err)));
	};

	onMount(() => {
		// Stash the leaving composer's unsent text (Main preserved on focus
		// changes); navigation restores returned editorText explicitly.
		stashUnsent();
		const pre = consumeBranchModalPrefilter();
		if (pre) setFilter(pre);
		refresh();
	});

	const onFilterInput = (value: string): void => {
		setFilter(value);
		// One server refresh per input pause would ride here; the 100-node page
		// contract keeps each refresh bounded.
		refresh();
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
				setBusyId(null);
				if (out.kind === "askReopen") {
					setAskReopen({
						targetId: node.id,
						toolCallId: out.reopen.toolCallId,
						questions: out.reopen.questions,
					});
					setAskDraft(out.reopen.questions.map(() => ({ selected: [], custom: "" })));
					return;
				}
				if (out.kind === "cancelled") return;
				if (out.kind === "branched") return;
				pushNotice(
					"info",
					out.summaryId
						? "Navigated (same file) — abandoned branch summarized."
						: "Navigated (same file) — previous branch preserved.",
				);
				setState("modal", null);
				props.onClose();
			})
			.catch((err) => {
				setBusyId(null);
				setError(String(err instanceof Error ? err.message : err));
			});
	};

	const runBranch = (node: GraphNode): void => {
		if (busyId()) return;
		setBusyId(node.id);
		void branchFromEntry(node.id)
			.then(() => setBusyId(null))
			.catch((err) => {
				setBusyId(null);
				setError(String(err instanceof Error ? err.message : err));
			});
	};

	const submitAskReanswer = (): void => {
		const ar = askReopen();
		if (!ar) return;
		setBusyId(ar.targetId);
		void completeAskReanswer(ar.targetId, ar.questions, askDraft())
			.then(() => {
				setBusyId(null);
				setAskReopen(null);
				setState("modal", null);
				props.onClose();
			})
			.catch((err) => {
				setBusyId(null);
				setError(String(err instanceof Error ? err.message : err));
			});
	};

	const toggleAskOption = (qi: number, label: string, multi: boolean): void => {
		setAskDraft((prev) => {
			const next = [...prev];
			const cur = next[qi] ?? { selected: [], custom: "" };
			const has = cur.selected.includes(label);
			const selected = multi
				? has
					? cur.selected.filter((l) => l !== label)
					: [...cur.selected, label]
				: has
					? []
					: [label];
			next[qi] = { ...cur, selected };
			return next;
		});
	};

	return (
		<>
			<Show when={askReopen()} keyed>
				{(ar) => (
					<div class="graph-ask">
						<div class="picker-group-name">
							Re-answer ask (new sibling answer — old answer kept)
						</div>
						<For each={ar.questions}>
							{(q, qi) => (
								<div class="ask-question">
									{q.header && <div class="ask-header">{q.header}</div>}
									<div class="ask-label">{q.question}</div>
									<div class="picker-list ask-options">
										<For each={q.options}>
											{(opt) => {
												const sel = () => (askDraft()[qi()]?.selected ?? []).includes(opt.label);
												return (
													<PickerRow
														class="picker-row ask-option"
														classList={{ active: sel() }}
														aria-pressed={sel()}
														onClick={() => toggleAskOption(qi(), opt.label, q.multi ?? false)}
													>
														<span class="picker-label">{opt.label}</span>
														{opt.description && (
															<span class="picker-detail">{opt.description}</span>
														)}
													</PickerRow>
												);
											}}
										</For>
									</div>
									<input
										class="picker-filter ask-custom"
										aria-label="Custom answer"
										placeholder="Other…"
										value={askDraft()[qi()]?.custom ?? ""}
										onInput={(e) => {
											const v = e.currentTarget.value;
											setAskDraft((prev) => {
												const next = [...prev];
												next[qi()] = { ...(next[qi()] ?? { selected: [] }), custom: v };
												return next;
											});
										}}
									/>
								</div>
							)}
						</For>
						<div class="graph-ask-actions">
							<button type="button" onClick={() => setAskReopen(null)}>
								Back to tree
							</button>
							<button
								type="button"
								class="send"
								disabled={busyId() !== null}
								onClick={submitAskReanswer}
							>
								Re-answer + resume
							</button>
						</div>
					</div>
				)}
			</Show>
			<Show when={!askReopen()}>
				<div class="picker-group-name">
					Navigate stays in this file (previous branch preserved). Branch copies to a NEW file.
				</div>
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
							const kids = createMemo(() => nodes().filter((x) => x.parentId === n.id));
							const sibs = createMemo(() =>
								n.parentId === null
									? []
									: nodes().filter((x) => x.parentId === n.parentId && x.id !== n.id),
							);
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
											<Show when={sibs().length > 0}>
												<div class="tool-collapsed-note">
													{sibs().length} sibling{sibs().length === 1 ? "" : "s"} on this fork (same
													page)
												</div>
											</Show>
											<Show when={kids().length > 0}>
												<div class="tool-collapsed-note">
													{kids().length} child{kids().length === 1 ? "" : "ren"} below
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
			</Show>
		</>
	);
};
