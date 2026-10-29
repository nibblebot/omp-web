import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
	activityButtons,
	activityStatusText,
	currentSummaries,
	pressActivityButton,
} from "../../activities/bar";
import { shimmerMode } from "../../chat/display-prefs";
import { createPresence } from "../../motion/presence";
import { compactComposer } from "../../prompt/compact-composer";
import { isActivitiesOpen, type ActivitySectionId } from "../../store/activities";
import { ShimmerText } from "../ui/ShimmerText";
import { ACTIVITY_ICON, ACTIVITY_POPOVER, ACTIVITY_SECTIONS } from "./activity-sections";

/**
 * The status line above the composer. Left: the turn's progress text (the working intent while
 * the agent streams, "Compacting context…" while it compacts, blank when idle) with the
 * `display.shimmer` look. Right: one button per Activities section that has items (Subagents, Jobs,
 * Daemons, Todo) with the active count (Todo: done/total), muted once everything is settled. A
 * button opens that section's popover above it; while the Activities panel is open it scrolls the
 * panel to the section instead. The line collapses to zero height when it has no text and no buttons.
 * On phones (compact composer) the buttons live in the header's More actions menu (MainHeader)
 * instead, so the line shows only while there is progress text.
 * The popovers belong to their buttons (anchored popovers, never ModalHost overlays).
 */
export const ActivityBar: Component = () => {
	const current = createMemo(() => ({
		status: activityStatusText(),
		buttons: compactComposer() ? [] : activityButtons(currentSummaries()),
	}));
	const occupied = () => current().status.text !== "" || current().buttons.length > 0;
	// The last occupied content stays drawn through the collapse motion.
	let last = current();
	const shown = createMemo(() => (occupied() ? (last = current()) : last));
	const presence = createPresence(occupied);

	const [open, setOpen] = createSignal<ActivitySectionId | undefined>();
	const anchors = new Map<ActivitySectionId, HTMLButtonElement>();
	// A popover never outlives its button or the panel it points at.
	createEffect(() => {
		const section = open();
		if (section === undefined) return;
		if (isActivitiesOpen() || !current().buttons.some((b) => b.section === section))
			setOpen(undefined);
	});

	return (
		<Show when={presence.mounted()}>
			<div
				class="activity-bar"
				data-motion={presence.phase()}
				inert={presence.phase() === "exit"}
				ref={presence.ref}
			>
				<div class="activity-bar-clip">
					<div class="activity-bar-body">
						<span
							class="activity-bar-status"
							data-kind={shown().status.kind}
							data-shimmer={shimmerMode()}
							role={shown().status.kind === "compacting" ? "status" : undefined}
							aria-hidden={shown().status.kind === "working" ? "true" : undefined}
						>
							<ShimmerText text={shown().status.text} />
						</span>
						<div class="activity-bar-buttons">
							<For each={ACTIVITY_SECTIONS}>
								{(section) => (
									<Show when={shown().buttons.find((b) => b.section === section)}>
										{(model) => (
											<button
												type="button"
												class="activity-bar-button"
												ref={(el) => anchors.set(section, el)}
												data-muted={model().muted ? "" : undefined}
												data-open={open() === section ? "" : undefined}
												title={section === "subagents" ? `${model().label} (Alt+A)` : model().label}
												aria-label={model().ariaLabel}
												aria-keyshortcuts={section === "subagents" ? "Alt+A" : undefined}
												aria-haspopup="dialog"
												aria-expanded={open() === section}
												onClick={() => {
													if (pressActivityButton(section) === "focused") setOpen(undefined);
													else setOpen(open() === section ? undefined : section);
												}}
											>
												<Dynamic component={ACTIVITY_ICON[section]} class="activity-bar-icon" />
												<Show when={model().badge !== ""}>
													<span class="activity-bar-badge">{model().badge}</span>
												</Show>
											</button>
										)}
									</Show>
								)}
							</For>
						</div>
					</div>
				</div>
				<Show when={open()} keyed>
					{(section) => (
						<Dynamic
							component={ACTIVITY_POPOVER[section]}
							anchor={anchors.get(section)!}
							onClose={() => setOpen(undefined)}
						/>
					)}
				</Show>
			</div>
		</Show>
	);
};
