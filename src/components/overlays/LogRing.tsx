import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { fmtTime } from "../../fleet-ui/fleet-debug";

/** Shared ring renderer for both logs: level-colored tag + source + message,
 *  newest entry last, stick-to-bottom while the reader is already at the tail. */
export const LogRing: Component<{
	entries: () => Array<{
		ts: number;
		level: string;
		source: string;
		message: string;
		daemonId?: string;
	}>;
	empty: string;
}> = (props) => {
	const [stick, setStick] = createSignal(true);
	let box!: HTMLDivElement;
	const onScroll = () => {
		const el = box;
		setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
	};
	createEffect(() => {
		void props.entries().length; // re-run when the ring grows
		if (stick()) box?.scrollTo({ top: box.scrollHeight });
	});
	return (
		<div class="debug-log" ref={box} onScroll={onScroll}>
			<Show when={props.entries().length === 0}>
				<div class="debug-log-empty">{props.empty}</div>
			</Show>
			<For each={props.entries()}>
				{(e) => (
					<div class="debug-log-line" data-level={e.level}>
						<span class="debug-log-time">{fmtTime(e.ts)}</span>
						<span class="debug-log-level">{e.level}</span>
						<span class="debug-log-source">
							{e.source}
							{e.daemonId !== undefined ? `/${e.daemonId.slice(0, 8)}` : ""}
						</span>
						<span class="debug-log-msg" title={e.message}>
							{e.message}
						</span>
					</div>
				)}
			</For>
		</div>
	);
};
