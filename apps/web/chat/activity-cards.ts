import type { ChatItem } from "../state";

/**
 * Whether the main transcript hides this item while the Activities panel is
 * open: the panel shows these as live sections, so their cards would only
 * duplicate them. Subagent (`task`) cards, todo cards, every `wait` card (a
 * folded run draws once at its first call, and the whole run hides with it),
 * and tool cards a backgrounded job parked on (`item.background`).
 */
export function hiddenWhileActivitiesOpen(item: ChatItem): boolean {
	if (item.kind !== "tool") return false;
	return (
		item.name === "task" ||
		item.name === "todo" ||
		item.name === "wait" ||
		item.background !== undefined
	);
}

/**
 * The items the stream draws. Closed panel: the list itself (same reference,
 * nothing copied). Open: the list without the activity cards. Wait-run
 * membership and turn metadata stay computed on the full list by the caller,
 * so a run hidden here is still the same run when the panel closes.
 */
export function transcriptItemsFor(
	items: readonly ChatItem[],
	activitiesOpen: boolean,
): readonly ChatItem[] {
	return activitiesOpen ? items.filter((item) => !hiddenWhileActivitiesOpen(item)) : items;
}
