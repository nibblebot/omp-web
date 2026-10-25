/**
 * The Activities panel's scroll behavior: the one-shot focus request (scroll a section or item into
 * view) and the list's scroll position across a detail-mode visit. DOM lookups only; what is
 * expanded or open is decided by the store actions that raised the request.
 */
import { createEffect, on } from "solid-js";
import { state } from "../state";
import { consumeFocusRequest } from "../store/activities";
import type { ActivityDetailRef, ActivityItemRef } from "../store/slices/activities";

/** Selector for the element a list item marks with `data-activity-item="<section>:<id>"`. */
export function activityItemSelector(ref: ActivityItemRef): string {
	return `[data-activity-item="${CSS.escape(`${ref.section}:${ref.id}`)}"]`;
}

/** Scroll `el` to the top of the `list` scroller. */
function scrollToTop(list: HTMLElement, el: HTMLElement): void {
	list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top;
}

/**
 * Honor `state.activities.focusRequest` as a one-shot: scroll the requested section, or item
 * (its section when a row carries no marker), to the top of the list, then consume the request.
 * A request that arrives while the list is not showing (detail mode) is consumed unscrolled.
 */
export function createFocusRequest(list: () => HTMLElement | undefined): void {
	createEffect(
		on(
			() => state.activities.focusRequest,
			(request) => {
				if (request === undefined) return;
				const root = list();
				if (root) {
					const { target } = request;
					const section = (id: string) =>
						root.querySelector<HTMLElement>(`[data-activity-section="${id}"]`);
					const el =
						typeof target === "string"
							? section(target)
							: (root.querySelector<HTMLElement>(activityItemSelector(target)) ??
								section(target.section));
					if (el) scrollToTop(root, el);
				}
				consumeFocusRequest(request.seq);
			},
		),
	);
}

/**
 * Remember the list's scroll offset while it shows, and put it back when it returns from
 * detail mode (`shown` goes defined -> undefined), focusing the row that was open. Focus moves
 * only when it was lost with the detail's Back button, never off a control the user chose.
 * Returns the list's `onScroll` handler.
 */
export function createListScrollMemory(
	list: () => HTMLElement | undefined,
	shown: () => ActivityDetailRef | undefined,
): (event: Event & { currentTarget: HTMLElement }) => void {
	let savedTop = 0;
	createEffect(
		on(shown, (current, prior) => {
			if (current !== undefined || prior === undefined) return;
			const root = list();
			if (!root) return;
			root.scrollTop = savedTop;
			const active = document.activeElement;
			if (active !== null && active !== document.body) return;
			const item = root.querySelector<HTMLElement>(activityItemSelector(prior));
			(
				item?.querySelector<HTMLElement>('[role="treeitem"]') ?? item?.querySelector("button")
			)?.focus({ preventScroll: true });
		}),
	);
	return (event) => {
		if (shown() === undefined) savedTop = event.currentTarget.scrollTop;
	};
}
