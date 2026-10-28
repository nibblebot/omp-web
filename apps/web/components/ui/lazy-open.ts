import { createSignal, type Accessor } from "solid-js";

/**
 * For a `<details>` whose body should not exist until the first time it is open.
 * `opened()` is true from then on, also after a close, so the body keeps its
 * state; wire `onToggle` to the element. `startsOpen` is the state it is
 * created in (the `open` attribute's first value): a body that starts open
 * mounts at once.
 */
export function createLazyOpen(startsOpen: boolean): {
	opened: Accessor<boolean>;
	onToggle: (event: Event & { currentTarget: HTMLDetailsElement }) => void;
} {
	const [opened, setOpened] = createSignal(startsOpen);
	return {
		opened,
		onToggle: (event) => {
			if (event.currentTarget.open) setOpened(true);
		},
	};
}
