import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { App } from "../web/App";
import { setInspecting } from "./inspect-runtime";
import { Inspector, clampInspectorWidth } from "./inspector";
import { Labels } from "./labels";
import { screenItems, screenSessionSeed } from "./fixtures/screen";
import { applySeeds } from "./seed";
/**
 * The App view (`/`): the real `<App />` in Chat Mode, seeded with the screen
 * fixtures and answered by the fake daemon. Holding Shift labels the component
 * under the pointer and its ancestors, Ctrl+Shift every mounted component; a
 * label opens its component in the inspector sidebar.
 */
export const AppView: Component = () => {
	// Track components created from here on, then seed before `<App />` renders.
	setInspecting(true);
	applySeeds({ ...screenSessionSeed, items: screenItems, streaming: false, view: "chat" });

	const [selected, setSelected] = createSignal<string | null>(null);
	const [width, setWidth] = createSignal(clampInspectorWidth(window.innerWidth * 0.4));
	const [stageEl, setStageEl] = createSignal<HTMLElement>();

	createEffect(() => {
		document.body.style.setProperty(
			"--ds-inspector-w",
			selected() === null ? "0px" : `${width()}px`,
		);
	});

	onCleanup(() => {
		setInspecting(false);
		setSelected(null);
		document.body.style.removeProperty("--ds-inspector-w");
	});

	return (
		<div class="ds-app-view">
			<div class="ds-app-row">
				<div class="ds-app-stage" ref={(el) => setStageEl(el)}>
					<App />
				</div>
				<Show when={selected()} keyed>
					{(id) => (
						<Inspector
							id={id}
							width={width()}
							onWidth={(px) => setWidth(px)}
							onSelect={(id) => setSelected(id)}
							onClose={() => setSelected(null)}
						/>
					)}
				</Show>
			</div>
			<Labels stage={stageEl} onOpen={(id) => setSelected(id)} />
		</div>
	);
};
