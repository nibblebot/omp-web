/**
 * Trailing debounce for pickers that search on the server (Ctrl+K palette,
 * `/resume`, the session tree pane). Each search costs the attached session
 * process a transcript scan or a graph walk, so a query typed at speed becomes
 * one call after the pause instead of one per keystroke.
 */

/** Pause after the last keystroke before a server search goes out. */
export const SEARCH_DEBOUNCE_MS = 200;

export interface Debouncer {
	/** Run `fn` after the pause; a newer `schedule` or `cancel` drops the pending one. */
	schedule(fn: () => void): void;
	cancel(): void;
}

export function createDebouncer(ms: number = SEARCH_DEBOUNCE_MS): Debouncer {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = (): void => {
		clearTimeout(timer);
		timer = undefined;
	};
	return {
		schedule(fn) {
			cancel();
			timer = setTimeout(() => {
				timer = undefined;
				fn();
			}, ms);
		},
		cancel,
	};
}
