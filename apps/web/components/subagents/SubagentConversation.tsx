import { Match, Show, Switch, type Component } from "solid-js";
import { subagentById } from "../../store/subagents";
import { createSubagentLifecycle } from "../../subagents/lifecycle";
import { ConfirmButton } from "../ui/ConfirmButton";
import { SubagentActionsMenu } from "./SubagentActionsMenu";
import { SubagentStatusBar } from "./SubagentStatusBar";
import { SubagentSteerComposer } from "./SubagentSteerComposer";
import { SubagentTranscript } from "./SubagentTranscript";

/**
 * One agent's live transcript, status bar, and state-specific composer area
 * (steer box, Revive or Abort strip, Finished strip). It fills its parent
 * column and holds no header: the agent pane puts a header above it and the
 * accordion puts the agent's row above it. `menu` ends the status bar with the
 * agent's actions menu (the accordion, whose rows carry none).
 */
export const SubagentConversation: Component<{ id: string; menu?: boolean }> = (props) => {
	const lifecycle = createSubagentLifecycle(() => props.id);
	const node = () => subagentById(props.id);
	return (
		<div class="subagent-conversation">
			<SubagentTranscript id={props.id} />
			<Show when={node()}>
				{(agent) => (
					<>
						<SubagentStatusBar
							node={agent()}
							actions={
								props.menu === true ? (
									<SubagentActionsMenu id={props.id} label="More agent actions" lifecycle />
								) : undefined
							}
						/>
						<Switch>
							<Match when={lifecycle.offers("steer")}>
								<SubagentSteerComposer
									id={props.id}
									canAbort={lifecycle.offers("abort")}
									pending={lifecycle.pending()}
									onSend={lifecycle.steer}
									onAbort={() => void lifecycle.abort()}
								/>
							</Match>
							<Match when={lifecycle.offers("revive") && agent().status === "parked"}>
								<div class="subagent-composer-strip">
									<span class="subagent-composer-state">Parked</span>
									<button
										type="button"
										class="send subagent-composer-action"
										disabled={lifecycle.pending()}
										onClick={() => void lifecycle.revive()}
									>
										Revive
									</button>
								</div>
							</Match>
							<Match when={lifecycle.offers("abort")}>
								<div class="subagent-composer-strip">
									<span class="subagent-composer-state">Starting</span>
									<ConfirmButton
										class="stop subagent-composer-action"
										label="Abort agent"
										confirmLabel="Confirm abort"
										disabled={lifecycle.pending()}
										onConfirm={() => void lifecycle.abort()}
									/>
								</div>
							</Match>
							<Match when={true}>
								<div class="subagent-composer-strip">
									<span class="subagent-composer-state">Finished</span>
								</div>
							</Match>
						</Switch>
					</>
				)}
			</Show>
		</div>
	);
};
