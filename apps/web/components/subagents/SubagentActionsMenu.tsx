import { createEffect, createSignal, Show, type Component } from "solid-js";
import { isFeatureEnabled } from "../../features/registry";
import {
	ensureAnalysisSessionsDir,
	openAnalysisHash,
	subagentAnalysisHref,
} from "../../store/subagents";
import { createSubagentLifecycle } from "../../subagents/lifecycle";
import { KebabMenu } from "../ui/KebabMenu";

/**
 * Kebab menu for one agent: Park or Revive (only with `lifecycle`, and only
 * while the agent's status offers them) and Open in Analysis (only when
 * Analysis is on and the transcript is known). Renders nothing when no item
 * applies: ANA-08 (brnh, km9k) hides inapplicable actions, never disables them.
 */
export const SubagentActionsMenu: Component<{
	id: string;
	label: string;
	lifecycle?: boolean;
}> = (props) => {
	const lifecycle = createSubagentLifecycle(() => props.id);
	const [open, setOpen] = createSignal(false);
	const analysisHref = () => subagentAnalysisHref(props.id, isFeatureEnabled("analysis"));
	const offersPark = () => props.lifecycle === true && lifecycle.offers("park");
	const offersRevive = () => props.lifecycle === true && lifecycle.offers("revive");
	createEffect(() => {
		if (isFeatureEnabled("analysis")) ensureAnalysisSessionsDir();
	});
	return (
		<Show when={offersPark() || offersRevive() || analysisHref()}>
			<KebabMenu label={props.label} open={open()} onOpenChange={setOpen}>
				<Show when={offersPark()}>
					<button
						type="button"
						role="menuitem"
						disabled={lifecycle.pending()}
						onClick={() => {
							setOpen(false);
							void lifecycle.park();
						}}
					>
						Park
					</button>
				</Show>
				<Show when={offersRevive()}>
					<button
						type="button"
						role="menuitem"
						disabled={lifecycle.pending()}
						onClick={() => {
							setOpen(false);
							void lifecycle.revive();
						}}
					>
						Revive
					</button>
				</Show>
				<Show when={analysisHref()}>
					{(href) => (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setOpen(false);
								openAnalysisHash(href());
							}}
						>
							Open in Analysis
						</button>
					)}
				</Show>
			</KebabMenu>
		</Show>
	);
};
