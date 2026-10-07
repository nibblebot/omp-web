import { createMemo, createSignal, For, onMount, Show, type Component } from "solid-js";
import { pushNotice, setState } from "../../state";
import { Modal } from "../shared/Modal";
import { PickerRow } from "../shared/PickerRow";
import {
	branchFromEntry,
	consumeBranchModalPrefilter,
	isLegacyGraph,
	loadGraph,
	navigateToEntry,
	completeAskReanswer,
	type GraphFilter,
	type GraphNode,
	type GraphPage,
} from "../../store/graph";
import { stashUnsent } from "../../store/drafts";
import type { AskQuestion } from "./ask-dialog/types";

/**
 * P2 session-graph picker (G01). Searchable/filterable graph + sibling
 * branches; every row binds by stable entry ID with stale-revision refusal.
 * Navigate stays in this file; Branch copies to a new file.
 */

const FILTERS: Array<{ value: GraphFilter; label: string }> = [
	{ value: "all", label: "all" },
	{ value: "user", label: "user" },
	{ value: "conversation", label: "conversation" },
	{ value: "tool", label: "tool" },
	{ value: "label", label: "label" },
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

export const BranchModal: Component<{ onClose: () => void }> = (props) => {
	const [page, setPage] = createSignal<GraphPage | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [filter, setFilter] = createSignal("");
	const [kind, setKind] = createSignal<GraphFilter>("all");
	const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
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

	const revision = createMemo(() => page()?.revision);

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

	const toggleExpand = (id: string): void => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const visible = createMemo(() => {
		const nodes = page()?.nodes ?? [];
		const q = filter().trim().toLowerCase();
		// Server filters when available; legacy pages filter client-side.
		if (!isLegacyGraph() || !q) return nodes;
		return nodes.filter((n) => n.preview.toLowerCase().includes(q));
	});

	const onFilterInput = (value: string): void => {
		setFilter(value);
		if (!isLegacyGraph()) {
			// Debounced server-side search would ride here; one refresh per
			// pause keeps the 100-node page contract (input latency first).
			refresh();
		}
	};

	const runNavigate = (node: GraphNode): void => {
		if (busyId()) return;
		setBusyId(node.id);
		setFoldNote(null);
		void navigateToEntry(
			node.id,
			{
				...(summarize() ? { summarize: true } : {}),
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
						? `Navigated (same file) — abandoned branch summarized.`
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
		<Modal
			title={isLegacyGraph() ? "Branch from message" : "Session graph"}
			onClose={props.onClose}
		>
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
								Back to graph
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
					{isLegacyGraph()
						? "Pick a message — Branch copies it to a NEW file"
						: "Pick a node — Navigate stays in this file, Branch copies to a new file"}
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
				<div class="picker-list graph-list">
					<For each={visible()}>
						{(n) => {
							const selected = () => selectedId() === n.id;
							const kids = createMemo(() =>
								(page()?.nodes ?? []).filter((x) => x.parentId === n.id),
							);
							const sibs = createMemo(() =>
								n.parentId === null
									? []
									: (page()?.nodes ?? []).filter((x) => x.parentId === n.parentId && x.id !== n.id),
							);
							return (
								<div class="graph-node" classList={{ active: selected() }}>
									<PickerRow
										class="picker-row graph-row"
										aria-selected={selected()}
										onClick={() => {
											setSelectedId(n.id);
											toggleExpand(n.id);
										}}
									>
										<span class="picker-chip">{kindLabel(n)}</span>
										<span class="picker-label">{n.preview || "(no text)"}</span>
										<span class="picker-meta">
											{n.label ? `🏷 ${n.label} · ` : ""}
											{n.id.slice(0, 8)}
											{relTime(n.timestamp) ? ` · ${relTime(n.timestamp)}` : ""}
											{n.hasImages ? " · 🖼" : ""}
											{n.id === page()?.leafId ? " · ● leaf" : ""}
										</span>
									</PickerRow>
									<Show when={expanded().has(n.id)}>
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
											<Show when={!isLegacyGraph()}>
												<label class="graph-opt">
													<input
														type="checkbox"
														checked={summarize()}
														onChange={(e) => setSummarize(e.currentTarget.checked)}
													/>
													summarize abandoned branch at target
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
											</Show>
											<div class="graph-actions">
												<Show when={!isLegacyGraph()}>
													<button
														type="button"
														title="Same-file navigation — previous branch preserved"
														disabled={busyId() !== null}
														onClick={() => runNavigate(n)}
													>
														{busyId() === n.id ? "Navigating…" : "Navigate here"}
													</button>
												</Show>
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
					{visible().length === 0 && !error() && (
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
				<Show when={isLegacyGraph()}>
					<div class="picker-note">
						Legacy server: flat message list — navigate/summarize need the graph.
					</div>
				</Show>
			</Show>
		</Modal>
	);
};
