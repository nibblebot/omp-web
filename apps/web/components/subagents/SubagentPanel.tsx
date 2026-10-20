import { createEffect, createSignal, Match, Show, Switch, type Component } from "solid-js";
import { pushNotice } from "../../store/chat";
import { reportError } from "../../store/toasts";
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
import { SubagentStatusBar } from "./SubagentStatusBar";
import { SubagentStatusChip } from "./SubagentStatusChip";
import { SubagentSteerComposer } from "./SubagentSteerComposer";
import { SubagentTranscript } from "./SubagentTranscript";

/** Agent pane: header with lifecycle menu, live transcript, status bar, and a state-specific composer area. */
export const SubagentPanel: Component<{ id?: string }> = (props) => {
	const id = () => props.id ?? "";
	const node = () => (props.id ? subagentById(props.id) : undefined);
	const offers = (action: AgentPaneAction): boolean =>
		agentPaneActions(subagentCapabilities(id())).includes(action);
	const [pending, setPending] = createSignal(false);
	const [menuOpen, setMenuOpen] = createSignal(false);

	/** ANA-08 (brnh, km9k): "Open in Analysis" shows only when Analysis is enabled and the transcript is known. */
	createEffect(() => {
		if (isFeatureEnabled("analysis")) ensureAnalysisSessionsDir();
	});

	/** Runs one lifecycle action with the pending gate; failures surface as a toast. Resolves true on success. */
	const run = async (action: () => Promise<unknown>): Promise<boolean> => {
		setPending(true);
		try {
			await action();
			return true;
		} catch (e) {
			reportError(e);
			return false;
		} finally {
			setPending(false);
		}
	};

	const steer = (text: string): Promise<boolean> => {
		const agentId = id();
		return run(async () => {
			await steerSubagent(agentId, text);
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
						<div class="subagent-panel-id">
							<h3 class="subagent-panel-name">{agent().name}</h3>
							<Show when={agent().agentType}>
								{(type) => <span class="subagent-tree-type">{type()}</span>}
							</Show>
							<SubagentStatusChip status={agent().status} />
							{/* ANA-08 (brnh, km9k): hidden, never disabled, when an action does not apply or no Analysis link exists. */}
							<Show
								when={
									offers("park") ||
									offers("revive") ||
									subagentAnalysisHref(id(), isFeatureEnabled("analysis"))
								}
							>
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
									<Show when={subagentAnalysisHref(id(), isFeatureEnabled("analysis"))}>
										{(href) => (
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setMenuOpen(false);
													openAnalysisHash(href());
												}}
											>
												Open in Analysis
											</button>
										)}
									</Show>
								</KebabMenu>
							</Show>
						</div>
						<p class="subagent-panel-title">{agent().title}</p>
					</header>
					<SubagentTranscript id={id()} />
					<SubagentStatusBar node={agent()} />
					<Switch>
						<Match when={offers("steer")}>
							<SubagentSteerComposer
								id={id()}
								canAbort={offers("abort")}
								pending={pending()}
								onSend={steer}
								onAbort={() => {
									const agentId = id();
									void run(() => abortSubagent(agentId));
								}}
							/>
						</Match>
						<Match when={offers("revive") && agent().status === "parked"}>
							<div class="subagent-composer-strip">
								<span class="subagent-composer-state">Parked</span>
								<button
									type="button"
									class="send subagent-composer-action"
									disabled={pending()}
									onClick={() => {
										const agentId = id();
										void run(() => reviveSubagent(agentId));
									}}
								>
									Revive
								</button>
							</div>
						</Match>
						<Match when={offers("abort")}>
							<div class="subagent-composer-strip">
								<span class="subagent-composer-state">Starting</span>
								<ConfirmButton
									class="stop subagent-composer-action"
									label="Abort agent"
									confirmLabel="Confirm abort"
									disabled={pending()}
									onConfirm={() => {
										const agentId = id();
										void run(() => abortSubagent(agentId));
									}}
								/>
							</div>
						</Match>
						<Match when={true}>
							<div class="subagent-composer-strip">
								<span class="subagent-composer-state">Finished</span>
							</div>
						</Match>
					</Switch>
				</div>
			)}
		</Show>
	);
};
