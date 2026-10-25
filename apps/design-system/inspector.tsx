import { type Component, createSignal, onCleanup, Show } from "solid-js";
import { entryByNodeId, nodeById, nodeLabel, tierLabel } from "./catalog";
import { NodeList } from "./meta";

/** Narrowest the inspector gets, in px. */
export const INSPECTOR_MIN = 280;
/** Room kept for the App beside the inspector, in px. */
const APP_MIN = 360;

/** Clamp a requested inspector width to what fits the window. */
export function clampInspectorWidth(px: number): number {
	const max = Math.max(INSPECTOR_MIN, window.innerWidth - APP_MIN);
	return Math.round(Math.min(Math.max(px, INSPECTOR_MIN), max));
}

/**
 * Right-hand sidebar for one component. Shows its graph facts, links to its
 * neighbours (picking one retargets the inspector), and renders its story in an
 * isolated `/?embed=<storyId>` iframe with its own store and fake session.
 */
export const Inspector: Component<{
	id: string;
	width: number;
	onWidth: (px: number) => void;
	onSelect: (id: string) => void;
	onClose: () => void;
}> = (props) => {
	const [resizing, setResizing] = createSignal(false);
	let stopResize: (() => void) | undefined;
	onCleanup(() => stopResize?.());

	// Drag the left edge; the iframe swallows pointer events, so it is disabled while dragging.
	const startResize = (e: PointerEvent) => {
		e.preventDefault();
		stopResize?.();
		setResizing(true);
		const move = (ev: PointerEvent) =>
			props.onWidth(clampInspectorWidth(window.innerWidth - ev.clientX));
		const stop = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			setResizing(false);
			stopResize = undefined;
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", stop);
		stopResize = stop;
	};

	const entry = () => entryByNodeId.get(props.id);

	return (
		<Show when={nodeById.get(props.id)} keyed>
			{(node) => (
				<aside
					class="ds-inspector"
					classList={{ "ds-resizing": resizing() }}
					style={{ width: `${props.width}px` }}
					aria-label={`Inspector: ${nodeLabel(node)}`}
				>
					<div
						class="ds-inspector-handle"
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize inspector"
						onPointerDown={startResize}
					/>
					<header class="ds-inspector-head">
						<div class="ds-inspector-title-row">
							<h2 class="ds-inspector-title" title={nodeLabel(node)}>
								{nodeLabel(node)}
							</h2>
							<button
								type="button"
								class="ds-chip ds-chip-button ds-inspector-close"
								onClick={() => props.onClose()}
							>
								Close
							</button>
						</div>
						<span class="ds-chip-note">
							{node.file}:{node.line}
						</span>
						<span class="ds-chip-note">
							{node.exportNames.length > 0
								? `exported as ${node.exportNames.join(", ")}`
								: "file-local, not exported"}
							{` · ${tierLabel(node.tier)} · group ${node.group}`}
						</span>
						<dl class="ds-inspector-links">
							<NodeList
								label="Renders"
								ids={node.children}
								empty="Nothing: a leaf component."
								onPick={props.onSelect}
							/>
							<NodeList
								label="Used by"
								ids={node.parents}
								empty="Nothing: a root, rendered by no project component."
								onPick={props.onSelect}
							/>
						</dl>
					</header>
					<div class="ds-inspector-body">
						<Show
							when={entry()}
							keyed
							fallback={
								<p class="ds-inspector-note">
									{node.exportNames.length > 0
										? "No story for this component yet."
										: "File-local component: it has no story of its own; its parent's story shows it."}
								</p>
							}
						>
							{(e) => (
								<iframe
									class="ds-inspector-frame"
									title={`${nodeLabel(node)} story`}
									src={`/?embed=${encodeURIComponent(e.story.id)}`}
								/>
							)}
						</Show>
					</div>
				</aside>
			)}
		</Show>
	);
};
