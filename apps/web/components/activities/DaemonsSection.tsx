import { createMemo, For, Show, type Component } from "solid-js";
import { daemonsKey } from "#lib/wire/protocol";
import { activityDaemons, daemonsSummary } from "../../activities/summary";
import { state } from "../../state";
import { toggleItemExpanded } from "../../store/activities";
import { ActivitySection } from "./ActivitySection";
import { DaemonLog } from "./DaemonLog";
import { DaemonRow } from "./DaemonRow";

const sameKeys = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((key, i) => key === b[i]);

/**
 * The Daemons section: this workspace's live supervised processes, one row each with its
 * state, endpoint, uptime and restart / kill. A row expands to its log in both panel modes
 * (daemons have no detail view). An item is identified by its `daemonsKey`; rows are keyed by
 * it too, because every roster frame brings fresh objects and an open log must survive them.
 */
export const DaemonsSection: Component = () => {
	const summary = createMemo(daemonsSummary);
	const keys = createMemo(() => activityDaemons().map(daemonsKey), [], { equals: sameKeys });
	return (
		<ActivitySection
			id="daemons"
			title="Daemons"
			count={{ active: summary().active, total: summary().total }}
		>
			<ul class="daemon-list" aria-label="Daemons">
				<For each={keys()}>
					{(key) => {
						const daemon = () => state.daemons.get(key);
						const open = () => state.activities.expanded.daemons.has(key);
						const bodyId = `daemon-log-${key.replace(/\W/g, "_")}`;
						return (
							<Show when={daemon()}>
								{(info) => (
									<li class="daemon-item" data-activity-item={`daemons:${key}`}>
										<DaemonRow
											daemon={info()}
											expanded={open()}
											bodyId={bodyId}
											onToggle={() => toggleItemExpanded({ section: "daemons", id: key })}
										/>
										<Show when={open()}>
											<DaemonLog daemon={info()} id={bodyId} />
										</Show>
									</li>
								)}
							</Show>
						);
					}}
				</For>
			</ul>
		</ActivitySection>
	);
};
