import { createEffect, createSignal, Show, type Component } from "solid-js";
import { pushNotice } from "../../store/chat";
import { reportError } from "../../store/toasts";
import { formatCost, formatDuration, formatTokens } from "../../subagents/format";
import { getFocusDraft, setFocusDraft } from "../../subagents/worker-scope";
import { isFeatureEnabled } from "../../features/registry";
import {
	abortSubagent,
	parkSubagent,
	reviveSubagent,
	steerSubagent,
	ensureAnalysisSessionsDir,
	openAnalysisHash,
	subagentAnalysisHref,
	subagentById,
	agentPaneActions,
	type AgentPaneAction,
	subagentCapabilities,
} from "../../store/subagents";
import { ConfirmButton } from "../ui/ConfirmButton";
import { KebabMenu } from "../ui/KebabMenu";
import { SubagentStatusChip } from "./SubagentStatusChip";
import { SubagentTranscript } from "./SubagentTranscript";

/** Agent pane: status and metrics, lifecycle actions, live transcript, and a steer box. */
export const SubagentPanel: Component<{ id?: string }> = (props) => {
	const id = () => props.id ?? "";
	const node = () => (props.id ? subagentById(props.id) : undefined);
	const offers = (action: AgentPaneAction): boolean =>
		agentPaneActions(subagentCapabilities(id())).includes(action);
	const [pending, setPending] = createSignal(false);
	const [menuOpen, setMenuOpen] = createSignal(false);
	const draftKey = () => `agent:${id()}`;
	const [draft, setDraft] = createSignal("");

	createEffect(() => setDraft(getFocusDraft(draftKey())));
	/** ANA-08 (brnh, km9k): "Open in Analysis" shows only when Analysis is enabled and the transcript is known. */
	createEffect(() => {
		if (isFeatureEnabled("analysis")) ensureAnalysisSessionsDir();
	});

	const run = async (action: () => Promise<unknown>): Promise<void> => {
		setPending(true);
		try {
			await action();
		} catch (e) {
			reportError(e);
		} finally {
			setPending(false);
		}
	};

	const submitSteer = async (e: SubmitEvent) => {
		e.preventDefault();
		const text = draft().trim();
		if (text === "") return;
		const agentId = id();
		const scope = draftKey();
		await run(async () => {
			await steerSubagent(agentId, text);
			setFocusDraft(scope, "");
			setDraft("");
			pushNotice("info", "Steer sent");
		});
	};

	return (
		<Show
			when={node()}
			fallback={<p class="subagent-panel-missing">This agent is no longer in the session.</p>}
		>
			{(agent) => (
				<div class="subagent-panel">
					<header class="subagent-panel-head">
						<h3 class="subagent-panel-name">{agent().label}</h3>
						<SubagentStatusChip status={agent().status} />
						<Show when={agent().agentType}>
							{(type) => <span class="subagent-tree-type">{type()}</span>}
						</Show>
						<Show when={subagentAnalysisHref(id(), isFeatureEnabled("analysis"))}>
							{(href) => (
								<button type="button" class="btn" onClick={() => openAnalysisHash(href())}>
									Open in Analysis
								</button>
							)}
						</Show>
					</header>
					<dl class="subagent-panel-metrics">
						<div>
							<dt>Elapsed</dt>
							<dd>{formatDuration(agent().metrics.elapsedMs)}</dd>
						</div>
						<div>
							<dt>Tokens</dt>
							<dd>{formatTokens(agent().metrics.tokens)}</dd>
						</div>
						<div>
							<dt>Cost</dt>
							<dd>{formatCost(agent().metrics.cost)}</dd>
						</div>
						<Show when={agent().metrics.contextPercent !== undefined}>
							<div>
								<dt>Context</dt>
								<dd>{Math.round(agent().metrics.contextPercent ?? 0)}%</dd>
							</div>
						</Show>
						<Show when={agent().children.length > 0}>
							<div>
								<dt>Subtree</dt>
								<dd>
									{formatTokens(agent().subtree.tokens)} tokens, {formatCost(agent().subtree.cost)}
								</dd>
							</div>
						</Show>
						<Show when={agent().lastTool}>
							{(tool) => (
								<div>
									<dt>Last tool</dt>
									<dd>{tool()}</dd>
								</div>
							)}
						</Show>
					</dl>
					<div class="subagent-panel-actions">
						<Show when={offers("abort")}>
							<ConfirmButton
								class="subagent-panel-abort"
								label="Abort agent"
								confirmLabel="Confirm abort"
								disabled={pending()}
								onConfirm={() => {
									const agentId = id();
									void run(() => abortSubagent(agentId));
								}}
							/>
						</Show>
						<Show when={offers("park") || offers("revive")}>
							<KebabMenu label="More agent actions" open={menuOpen()} onOpenChange={setMenuOpen}>
								<Show when={offers("park")}>
									<button
										type="button"
										role="menuitem"
										disabled={pending()}
										onClick={() => {
											setMenuOpen(false);
											const agentId = id();
											void run(() => parkSubagent(agentId));
										}}
									>
										Park
									</button>
								</Show>
								<Show when={offers("revive")}>
									<button
										type="button"
										role="menuitem"
										disabled={pending()}
										onClick={() => {
											setMenuOpen(false);
											const agentId = id();
											void run(() => reviveSubagent(agentId));
										}}
									>
										Revive
									</button>
								</Show>
							</KebabMenu>
						</Show>
					</div>
					<SubagentTranscript id={id()} />
					<Show when={offers("steer")}>
						<form class="subagent-steer" onSubmit={(e) => void submitSteer(e)}>
							<label class="subagent-steer-label">
								Steer this agent
								<textarea
									rows={2}
									value={draft()}
									disabled={pending()}
									onInput={(e) => {
										setDraft(e.currentTarget.value);
										setFocusDraft(draftKey(), e.currentTarget.value);
									}}
								/>
							</label>
							<button type="submit" disabled={pending() || draft().trim() === ""}>
								Send steer
							</button>
						</form>
					</Show>
				</div>
			)}
		</Show>
	);
};
