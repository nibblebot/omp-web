/**
 * Unsent composer text for the agent pane, keyed per agent. Drafts live in
 * module scope, never in the shared store, so switching panes keeps them.
 */
const focusDrafts = new Map<string, string>();

export function getFocusDraft(key: string): string {
	return focusDrafts.get(key) ?? "";
}

export function setFocusDraft(key: string, text: string): void {
	if (text) focusDrafts.set(key, text);
	else focusDrafts.delete(key);
}
