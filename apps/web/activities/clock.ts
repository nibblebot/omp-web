import { createSignal, type Accessor } from "solid-js";
import { createVisibleInterval } from "../page-visibility";

/** Epoch ms, refreshed every `periodMs` while the page is visible, for the lifetime of the calling component or effect. */
export function createNow(periodMs = 1000): Accessor<number> {
	const [now, setNow] = createSignal(Date.now());
	createVisibleInterval(() => setNow(Date.now()), periodMs);
	return now;
}
