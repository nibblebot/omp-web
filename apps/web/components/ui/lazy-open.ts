import { createSignal, type Accessor } from "solid-js";

type DetailsEvent<E extends Event> = E & { currentTarget: HTMLDetailsElement };

/**
 * For a `<details>` whose body should not exist until the first time it is open.
 * `opened()` is true from then on, also after a close, so the body keeps its
 * state; wire `onToggle` and `onClick` to the element. `startsOpen` is the state
 * it is created in (the `open` attribute's first value): a body that starts open
 * mounts at once.
 *
 * `toggle` fires a task after the open attribute flips, so on its own the body
 * would paint one frame late; a click on the summary (which every pointer and
 * keyboard toggle produces) mounts it before the browser opens the element.
 */
export function createLazyOpen(startsOpen: boolean): {
	opened: Accessor<boolean>;
	onToggle: (event: DetailsEvent<Event>) => void;
	onClick: (event: DetailsEvent<MouseEvent>) => void;
} {
	const [opened, setOpened] = createSignal(startsOpen);
	return {
		opened,
		onToggle: (event) => {
			if (event.currentTarget.open) setOpened(true);
		},
		onClick: (event) => {
			const summary = (event.target as Element | null)?.closest("summary");
			if (summary?.parentElement === event.currentTarget) setOpened(true);
		},
	};
}
