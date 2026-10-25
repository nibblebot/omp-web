import { createSignal, onCleanup, type Accessor } from "solid-js";

/** Epoch ms, refreshed every `periodMs` for the lifetime of the calling component or effect. */
export function createNow(periodMs = 1000): Accessor<number> {
	const [now, setNow] = createSignal(Date.now());
	const timer = setInterval(() => setNow(Date.now()), periodMs);
	onCleanup(() => clearInterval(timer));
	return now;
}
