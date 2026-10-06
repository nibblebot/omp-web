import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { isActiveSubagent, state, type SubagentInfo } from "../../state";
import type { WorkerKey } from "#lib/wire/protocol";
import { getSessionWorkerInfos, getWorkerInfo, listWorkers } from "../../store/subagents";
import { onMount } from "solid-js";
import { Modal } from "../shared/Modal";
import { useClickableRow } from "../shared/PickerRow";
import { SubagentControls } from "./SubagentControls";
import { latestSubagent, SubagentRow, subagentName } from "../shared/SubagentRow";
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
	id: string;
	children: string[];
}

/**
 * Searchable worker hub (G04/G10): filter input (scoped/fuzzy with
 * `agent:`/`status:` prefixes + `has:text`/`is:tool` tokens), flat/tree
 * toggle (tree groups by parentToolCallId, one level, `subagent-child` indent),
 * error-only + response/tool filters, agent/subtree scope selects, follow
 * toggle into the focused view. Selection is `{sessionId, agentId}` keyed off
 * `state.currentSessionId` (the attached handle the worker store and the live
 * mirror are keyed by) — no invented identity. focused-draft map stays
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
	// Selection model: {sessionId, agentId} | null — sessionId is the attached
	// handle (state.currentSessionId), never invented. state.sessionId is the SDK
	// session uuid, which no worker record is keyed by.
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

	const sessionId = () => state.currentSessionId;
	// Stable order: in-flight first, otherwise discovery order. Sorting by
	// lastUpdate reshuffled busy rows on every progress frame.
	const subs = () =>
		getSessionWorkerInfos(sessionId()).sort(
			(a, b) => Number(isActiveSubagent(b)) - Number(isActiveSubagent(a)),
		);
	const byId = createMemo(() => new Map(subs().map((sub) => [sub.id, sub])));
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
	const visibleIds = createMemo(() => visible().map((sub) => sub.id));
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
			const children: string[] = [];
			const pending = [...(childrenByParent.get(root.id) ?? [])];
			rendered.add(root.id);
			while (pending.length) {
				const child = pending.shift()!;
				if (rendered.has(child.id)) continue;
				rendered.add(child.id);
				children.push(child.id);
				pending.push(...(childrenByParent.get(child.id) ?? []));
			}
			nodes.push({ id: root.id, children });
		}
		// Corrupt cyclic lineage must not make a worker disappear.
		for (const sub of list) if (!rendered.has(sub.id)) nodes.push({ id: sub.id, children: [] });
		return nodes;
	});
	// <For> keys by reference: iterate stable id strings, never per-frame objects.
	const treeRootIds = createMemo(() => treeNodes().map((node) => node.id));
	const treeChildIds = (id: string): string[] =>
		treeNodes().find((node) => node.id === id)?.children ?? [];

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

	const row = (id: string, child: boolean) => {
		const sub = latestSubagent((key) => byId().get(key), id);
		return (
			<div
				class={child ? "subagent-panel-row subagent-child" : "subagent-panel-row"}
				style={{ cursor: "pointer" }}
				{...useClickableRow(() => focus(sub()))}
			>
				<SubagentRow
					sub={sub()}
					showMeta
					unread={isWorkerUnread(sub())}
					model={workerModel(sub())}
				/>
				<Show when={sub().status === "started" || sub().status === "running"}>
					<SubagentControls sub={sub()} />
				</Show>
			</div>
		);
	};

	return (
		<Modal title={`Subagents (${subs().length})`} class="subagent-hub" onClose={props.onClose}>
			<div class="subagent-hub-tabs" role="tablist" aria-label="Subagent hub tabs">
				<For
					each={
						[
							["workers", "Workers"],
							["advisor", "Advisor"],
							["goals", "Goals & Loops"],
							["vibe", "Vibe"],
						] as const
					}
				>
					{([id, label]) => (
						<button
							type="button"
							role="tab"
							class="subagent-hub-tab"
							aria-selected={tab() === id}
							onClick={() => setTab(id)}
						>
							{label}
						</button>
					)}
				</For>
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
							<div class="subagent-hub-toolbar">
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
													{subagentName(root)} · {root.agent}
												</option>
											)}
										</For>
									</select>
								</label>
							</div>
							<Show when={rosterError()}>
								{(error) => <div class="msg-notice">worker roster unavailable: {error()}</div>}
							</Show>
							<Show
								when={tree()}
								fallback={<For each={visibleIds()}>{(id) => row(id, false)}</For>}
							>
								<For each={treeRootIds()}>
									{(id) => (
										<>
											{row(id, false)}
											<For each={treeChildIds(id)}>{(child) => row(child, true)}</For>
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
