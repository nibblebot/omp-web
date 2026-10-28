import type { ChatItem } from "../state";

/**
 * Whether the main transcript hides this item while the Activities panel is
 * open (the transcript index answers it per item): the panel shows these as live sections, so their cards would only
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
