import { children, Show, type Component, type JSX } from "solid-js";
import { state } from "../../state";
import { toggleSectionCollapsed, type ActivitySectionId } from "../../store/activities";
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons";

/** `active / total` for the item sections, `done / total` for Todo. */
export type ActivitySectionCount =
	| { active: number; total: number }
	| { done: number; total: number };

/**
 * One collapsible section of the Activities panel: a header (chevron, name, count, the
 * section's own actions) over its body. The body unmounts while folded. The root carries
 * `data-activity-section` for scroll targeting; a list item inside it marks its own element
 * `data-activity-item="<section>:<id>"` to be scrollable the same way.
 */
export const ActivitySection: Component<{
	id: ActivitySectionId;
	title: string;
	count: ActivitySectionCount;
	actions?: JSX.Element;
	children: JSX.Element;
}> = (props) => {
	// Resolved once: reading the JSX prop in both the Show condition and the slot could build the element twice.
	const actions = children(() => props.actions);
	const collapsed = () => state.activities.collapsedSections.has(props.id);
	const bodyId = () => `activity-section-body-${props.id}`;
	const countText = () => {
		const count = props.count;
		return `${"active" in count ? count.active : count.done}/${count.total}`;
	};
	const countLabel = () => {
		const count = props.count;
		return "active" in count
			? `${count.active} active of ${count.total}`
			: `${count.done} done of ${count.total}`;
	};
	return (
		<section class="activity-section" data-activity-section={props.id}>
			<div class="activity-section-header">
				<h3 class="activity-section-heading">
					<button
						type="button"
						class="activity-section-toggle"
						aria-expanded={!collapsed()}
						aria-controls={collapsed() ? undefined : bodyId()}
						onClick={() => toggleSectionCollapsed(props.id)}
					>
						<span class="activity-section-chevron" aria-hidden="true">
							{collapsed() ? <ChevronRightIcon /> : <ChevronDownIcon />}
						</span>
						<span class="activity-section-name">{props.title}</span>
						<span class="activity-section-count" title={countLabel()}>
							{countText()}
						</span>
					</button>
				</h3>
				<Show when={actions()}>
					<div class="activity-section-actions">{actions()}</div>
				</Show>
			</div>
			<Show when={!collapsed()}>
				<div class="activity-section-body" id={bodyId()}>
					{props.children}
				</div>
			</Show>
		</section>
	);
};
