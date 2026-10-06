import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { state, type SubagentInfo } from "../../state";
import type { WorkerKey } from "#lib/wire/protocol";
import { getSessionWorkerInfos, getWorkerInfo, listWorkers } from "../../store/subagents";
import { onMount } from "solid-js";
import { Modal } from "../shared/Modal";
import { useClickableRow } from "../shared/PickerRow";
import { SubagentControls } from "./SubagentControls";
import { SubagentRow } from "../shared/SubagentRow";
import { WorkerFocus } from "./WorkerFocus";
import { AdvisorPanel } from "./AdvisorPanel";
import { GoalLoopSection, VibeOnlySection } from "./GoalLoopPanel";
import {
	TOOL_AGENTS,
	getWorkerPin,
	isWorkerUnread,
	markWorkerSeen,
	matchSubagent,
	parseHubFilter,
	workerModel,
	workerParentId,
} from "./workerScope";

type HubTab = "workers" | "advisor" | "goals" | "vibe";

interface TreeNode {
	sub: SubagentInfo;
	children: SubagentInfo[];
}

/**
 * Searchable worker hub (G04/G10): filter input (scoped/fuzzy with
 * `agent:`/`status:` prefixes + `has:text`/`is:tool` tokens), flat/tree
 * toggle (tree groups by parentToolCallId, one level, `subagent-child` indent),
 * error-only + response/tool filters, agent/subtree scope selects, follow
 * toggle into the focused view. Selection is `{sessionId, agentId}` keyed off
 * the stable `state.sessionId` — no invented identity. focused-draft map stays
 * module-scope; the Main draft is preserved to localStorage on focus.
 *
 * Data: reads the `state.subagents` mirror only (initial list comes from the
 * attach-primed `getSubagents`; no call() on mount here). Tabs:
 * Workers | Advisor | Goals & Loops | Vibe (role=tablist, buttons suffice).
 */
export const SubagentPanel: Component<{
	onClose: () => void;
	onFocus?: (key: WorkerKey) => void;
}> = (props) => {
	const [tab, setTab] = createSignal<HubTab>("workers");
	// Selection model: {sessionId, agentId} | null — sessionId is the stable
	// state.sessionId, never invented.
	const [selected, setSelected] = createSignal<{ sessionId: string; agentId: string } | null>(null);
	const [query, setQuery] = createSignal("");
	const [tree, setTree] = createSignal(false);
	const [errorOnly, setErrorOnly] = createSignal(false);
	const [hasTextOnly, setHasTextOnly] = createSignal(false);
	const [toolOnly, setToolOnly] = createSignal(false);
	const [agentScope, setAgentScope] = createSignal("");
	const [subtreeScope, setSubtreeScope] = createSignal("");
	const [follow, setFollow] = createSignal(false);
	const [showHidden, setShowHidden] = createSignal(false);
	const [rosterError, setRosterError] = createSignal<string | null>(null);

	const sessionId = () => state.sessionId;
	const subs = () => getSessionWorkerInfos(sessionId()).sort((a, b) => b.lastUpdate - a.lastUpdate);
	const selectedSub = (): SubagentInfo | null => {
		const key = selected();
		if (!key) return null;
		// Guard session switches: a stale selection from another session never resolves.
		if (key.sessionId !== sessionId()) return null;
		return getWorkerInfo(key.sessionId, key.agentId);
	};

	const agentNames = createMemo(() => [...new Set(subs().map((s) => s.agent))].sort());
	const subtreeRoots = createMemo(() => {
		const ids = new Set(subs().map((s) => s.id));
		return subs().filter((s) => !workerParentId(s) || !ids.has(workerParentId(s)!));
	});

	const filtered = createMemo(() => {
		const filter = parseHubFilter(query());
		return subs().filter((sub) => {
			if (!matchSubagent(sub, filter)) return false;
			if (errorOnly() && sub.status !== "failed") return false;
			if (hasTextOnly() && !(sub.description ?? sub.task ?? "").trim()) return false;
			if (toolOnly() && TOOL_AGENTS[(sub.agent ?? "").toLowerCase()] !== true) return false;
			if (agentScope() && sub.agent !== agentScope()) return false;
			if (subtreeScope()) {
				let current: SubagentInfo | undefined = sub;
				const visited = new Set<string>();
				while (current && current.id !== subtreeScope()) {
					if (visited.has(current.id)) return false;
					visited.add(current.id);
					const parent = workerParentId(current);
					current = parent ? subs().find((candidate) => candidate.id === parent) : undefined;
				}
				if (!current) return false;
			}
			return true;
		});
	});

	const visible = createMemo(() => {
		const list = filtered();
		if (showHidden()) return list;
		return list.filter((sub) => getWorkerPin(sub.id) !== "off");
	});
	const hiddenCount = createMemo(() => filtered().length - visible().length);

	const treeNodes = createMemo((): TreeNode[] => {
		const list = visible();
		const ids = new Set(list.map((s) => s.id));
		const childrenByParent = new Map<string, SubagentInfo[]>();
		for (const sub of list) {
			const parent = workerParentId(sub);
			if (parent && ids.has(parent)) {
				const bucket = childrenByParent.get(parent) ?? [];
				bucket.push(sub);
				childrenByParent.set(parent, bucket);
			}
		}
		const rendered = new Set<string>();
		const nodes: TreeNode[] = [];
		for (const root of list.filter(
			(sub) => !workerParentId(sub) || !ids.has(workerParentId(sub)!),
		)) {
			const children: SubagentInfo[] = [];
			const pending = [...(childrenByParent.get(root.id) ?? [])];
			rendered.add(root.id);
			while (pending.length) {
				const child = pending.shift()!;
				if (rendered.has(child.id)) continue;
				rendered.add(child.id);
				children.push(child);
				pending.push(...(childrenByParent.get(child.id) ?? []));
			}
			nodes.push({ sub: root, children });
		}
		// Corrupt cyclic lineage must not make a worker disappear.
		for (const sub of list) if (!rendered.has(sub.id)) nodes.push({ sub, children: [] });
		return nodes;
	});

	const focus = (sub: SubagentInfo): void => {
		markWorkerSeen(sub);
		const key = { sessionId: sessionId(), agentId: sub.id };
		if (props.onFocus) {
			props.onFocus(key);
			props.onClose();
		} else setSelected(key);
	};
	onMount(() => {
		void listWorkers().catch((err: unknown) =>
			setRosterError(err instanceof Error ? err.message : String(err)),
		);
	});

	const row = (sub: SubagentInfo, child: boolean) => (
		<div
			class={child ? "subagent-panel-row subagent-child" : "subagent-panel-row"}
			style={{ cursor: "pointer" }}
			{...useClickableRow(() => focus(sub))}
		>
			<SubagentRow sub={sub} showMeta unread={isWorkerUnread(sub)} model={workerModel(sub)} />
			<Show when={sub.status === "started" || sub.status === "running"}>
				<SubagentControls sub={sub} />
			</Show>
		</div>
	);

	return (
		<Modal title={`Subagents (${subs().length})`} onClose={props.onClose}>
			<div class="subagent-controls" role="tablist" aria-label="Subagent hub tabs">
				<button
					type="button"
					role="tab"
					aria-selected={tab() === "workers"}
					onClick={() => setTab("workers")}
				>
					Workers
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab() === "advisor"}
					onClick={() => setTab("advisor")}
				>
					Advisor
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab() === "goals"}
					onClick={() => setTab("goals")}
				>
					Goals &amp; Loops
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab() === "vibe"}
					onClick={() => setTab("vibe")}
				>
					Vibe
				</button>
			</div>

			<Show when={tab() === "workers"}>
				<Show
					when={selectedSub()}
					fallback={
						<div class="subagent-list">
							<input
								class="picker-filter"
								type="text"
								aria-label="Filter workers"
								placeholder="filter… (agent:<name> status:<s> has:text is:tool)"
								value={query()}
								onInput={(e) => setQuery(e.currentTarget.value)}
							/>
							<div class="subagent-controls">
								<label class="subagent-status">
									<input
										type="checkbox"
										checked={tree()}
										onChange={(e) => setTree(e.currentTarget.checked)}
									/>{" "}
									tree
								</label>
								<label class="subagent-status">
									<input
										type="checkbox"
										checked={errorOnly()}
										onChange={(e) => setErrorOnly(e.currentTarget.checked)}
									/>{" "}
									errors only
								</label>
								<label class="subagent-status">
									<input
										type="checkbox"
										checked={hasTextOnly()}
										onChange={(e) => setHasTextOnly(e.currentTarget.checked)}
									/>{" "}
									has text
								</label>
								<label class="subagent-status">
									<input
										type="checkbox"
										checked={toolOnly()}
										onChange={(e) => setToolOnly(e.currentTarget.checked)}
									/>{" "}
									tools
								</label>
								<label class="subagent-status">
									agent{" "}
									<select
										value={agentScope()}
										onChange={(e) => setAgentScope(e.currentTarget.value)}
									>
										<option value="">all</option>
										<For each={agentNames()}>{(name) => <option value={name}>{name}</option>}</For>
									</select>
								</label>
								<label class="subagent-status">
									subtree{" "}
									<select
										value={subtreeScope()}
										onChange={(e) => setSubtreeScope(e.currentTarget.value)}
									>
										<option value="">all</option>
										<For each={subtreeRoots()}>
											{(root) => (
												<option value={root.id}>
													{root.agent} · {root.id}
												</option>
											)}
										</For>
									</select>
								</label>
							</div>
							<Show when={rosterError()}>
								{(error) => <div class="msg-notice">worker roster unavailable: {error()}</div>}
							</Show>
							<Show when={tree()} fallback={<For each={visible()}>{(sub) => row(sub, false)}</For>}>
								<For each={treeNodes()}>
									{(node) => (
										<>
											{row(node.sub, false)}
											<For each={node.children}>{(child) => row(child, true)}</For>
										</>
									)}
								</For>
							</Show>
							{visible().length === 0 && <div class="tool-collapsed-note">no subagents yet</div>}
							<Show when={showHidden() || hiddenCount() > 0}>
								<button type="button" onClick={() => setShowHidden((v) => !v)}>
									{showHidden() ? "hide hidden" : `show hidden (${hiddenCount()})`}
								</button>
							</Show>
						</div>
					}
				>
					{(sub) => (
						<WorkerFocus
							sub={sub()}
							sessionId={sessionId()}
							follow={follow()}
							onFollowChange={setFollow}
							onBack={() => setSelected(null)}
						/>
					)}
				</Show>
			</Show>
			<Show when={tab() === "advisor"}>
				<AdvisorPanel />
			</Show>
			<Show when={tab() === "goals"}>
				<GoalLoopSection />
			</Show>
			<Show when={tab() === "vibe"}>
				<VibeOnlySection />
			</Show>
		</Modal>
	);
};
