import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { nodeById, nodeLabel } from "./catalog";
import { type ComponentInstance, isMounted, mountedInstances, portalOf } from "./inspect-runtime";

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** One mounted component instance, drawn as a name in its group's row. */
interface Member {
	/** `${id}~${n}`: the n-th listed instance of this component this frame. */
	key: string;
	id: string;
	name: string;
	/** Null for an ancestor with nothing on screen of its own, folded into a descendant's row. */
	box: Box | null;
}

/** Instances whose top-left corner rounds to the same pixel, outermost first. */
interface Group {
	key: string;
	x: number;
	y: number;
	members: Member[];
}

/** Off; Shift: the component under the pointer and its ancestors; Ctrl+Shift: every component. */
type Mode = "off" | "hover" | "all";

/** Bounding box of an instance's element nodes that are on screen inside the stage. */
function unionBox(nodes: Node[], stage: DOMRect): Box | null {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const node of nodes) {
		if (!(node instanceof Element) || !node.isConnected) continue;
		const r = node.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		left = Math.min(left, r.left);
		top = Math.min(top, r.top);
		right = Math.max(right, r.right);
		bottom = Math.max(bottom, r.bottom);
	}
	if (left === Infinity) return null;
	if (right < stage.left || left > stage.right || bottom < stage.top || top > stage.bottom) {
		return null;
	}
	return { left, top, width: right - left, height: bottom - top };
}

function nameOf(id: string): string {
	const node = nodeById.get(id);
	return node ? nodeLabel(node) : id.slice(id.lastIndexOf("#") + 1);
}

/**
 * Where a component that renders through a `<Portal>` shows: inside its
 * portal, the first element on screen that does not cover the viewport (the
 * sheet, not its backdrop), else the covering one.
 */
function portalBox(inst: ComponentInstance, stage: DOMRect): Box | null {
	const onScreen = (el: Element) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	};
	for (const container of inst.portals()) {
		let fallback: Element | null = null;
		for (
			let el: Element | null = container;
			el !== null;
			el = [...el.children].find(onScreen) ?? null
		) {
			if (!onScreen(el)) continue;
			const r = el.getBoundingClientRect();
			if (r.width < window.innerWidth - 1 || r.height < window.innerHeight - 1) {
				return unionBox([el], stage);
			}
			fallback ??= el;
		}
		if (fallback !== null) return unionBox([fallback], stage);
	}
	return null;
}

/**
 * Label groups for `list` (outermost first). With `carry`, an instance without
 * a box joins the next listed instance that has one, so a hover chain through
 * a portal (ModalHost > SettingsSheet > Modal) keeps every ancestor's name.
 */
function computeGroups(list: Iterable<ComponentInstance>, stage: DOMRect, carry: boolean): Group[] {
	const groups = new Map<string, Group>();
	const occurrence = new Map<string, number>();
	let pending: Member[] = [];
	for (const inst of list) {
		const box = unionBox(inst.nodes(), stage) ?? portalBox(inst, stage);
		if (box === null && !carry) continue;
		const n = occurrence.get(inst.id) ?? 0;
		occurrence.set(inst.id, n + 1);
		const member: Member = { key: `${inst.id}~${n}`, id: inst.id, name: nameOf(inst.id), box };
		if (box === null) {
			pending.push(member);
			continue;
		}
		const members = [...pending, member];
		pending = [];
		const corner = `${Math.round(box.left)},${Math.round(box.top)}`;
		const group = groups.get(corner);
		if (group) {
			group.members.push(...members);
		} else {
			groups.set(corner, {
				key: corner,
				x: Math.min(Math.max(box.left, 4), window.innerWidth - 80),
				y: Math.max(box.top - 2, 22),
				members,
			});
		}
	}
	return [...groups.values()];
}

function depthOf(inst: ComponentInstance): number {
	let depth = 0;
	for (let p = inst.parent; p !== null; p = p.parent) depth++;
	return depth;
}

/** Whether `ancestor` is `inst` or one of its parents. */
function isAncestor(ancestor: ComponentInstance, inst: ComponentInstance): boolean {
	for (let at: ComponentInstance | null = inst; at !== null; at = at.parent) {
		if (at === ancestor) return true;
	}
	return false;
}

/** The deepest mounted instance whose elements, or portals, contain `target`. */
function innermostAt(target: Element): ComponentInstance | null {
	const portalOwner = portalOf(target);
	let best = portalOwner !== null && isMounted(portalOwner) ? portalOwner : null;
	let bestDepth = best === null ? -1 : depthOf(best);
	for (const inst of mountedInstances()) {
		if (!inst.nodes().some((n) => n instanceof Element && n.contains(target))) continue;
		const depth = depthOf(inst);
		if (depth >= bestDepth) {
			best = inst;
			bestDepth = depth;
		}
	}
	return best;
}

/** `inst` and its ancestors, outermost first. */
function chainOf(inst: ComponentInstance): ComponentInstance[] {
	const chain: ComponentInstance[] = [];
	for (let at: ComponentInstance | null = inst; at !== null; at = at.parent) chain.unshift(at);
	return chain;
}

/**
 * Component labels. Holding Shift draws the name of the component under the
 * pointer and of every component above it, each just above its top-left
 * corner; Ctrl+Shift draws every mounted apps/web component. Clicking a name
 * calls `onOpen` with its graph node id. Any other key, releasing Shift, or
 * leaving the window hides them.
 */
export const Labels: Component<{
	stage: () => HTMLElement | undefined;
	onOpen: (id: string) => void;
}> = (props) => {
	const [mode, setMode] = createSignal<Mode>("off");
	const [snapshot, setSnapshot] = createSignal<Group[]>([]);
	const [hovered, setHovered] = createSignal<string | null>(null);
	const pointer = { x: -1, y: -1 };

	const keys = createMemo(() => snapshot().map((g) => g.key));
	const groupMap = createMemo(() => new Map(snapshot().map((g) => [g.key, g])));
	const memberMap = createMemo(
		() =>
			new Map(
				snapshot()
					.flatMap((g) => g.members)
					.map((m) => [m.key, m]),
			),
	);
	const memberKeys = (groupKey: string): string[] =>
		groupMap()
			.get(groupKey)
			?.members.map((m) => m.key) ?? [];

	onMount(() => {
		// After a modifier keydown or keyup the event's flags hold the remaining
		// modifiers, so releasing Ctrl drops back to hover mode and releasing Shift ends.
		const modeOf = (e: KeyboardEvent): Mode =>
			!e.shiftKey || e.altKey || e.metaKey ? "off" : e.ctrlKey ? "all" : "hover";
		const down = (e: KeyboardEvent) =>
			setMode(e.key === "Shift" || e.key === "Control" ? modeOf(e) : "off");
		const up = (e: KeyboardEvent) => {
			if (e.key === "Shift" || e.key === "Control") setMode(modeOf(e));
		};
		const blur = () => setMode("off");
		const move = (e: PointerEvent) => {
			pointer.x = e.clientX;
			pointer.y = e.clientY;
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", blur);
		window.addEventListener("pointermove", move, { capture: true, passive: true });
		onCleanup(() => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", blur);
			window.removeEventListener("pointermove", move, { capture: true });
		});
	});

	/**
	 * The instance whose chain is labelled in hover mode. It only changes when
	 * the pointer enters a component outside the current chain: moving onto an
	 * ancestor (the space above a component where its label sits), a label, or
	 * an area with no component keeps it, so every name stays reachable.
	 */
	const hoverTarget = (current: ComponentInstance | null): ComponentInstance | null => {
		const live = current !== null && isMounted(current) ? current : null;
		if (pointer.x < 0) return live;
		const target = document.elementFromPoint(pointer.x, pointer.y);
		if (target === null || target.closest(".ds-labels")) return live;
		const next = innermostAt(target);
		if (next === null || (live !== null && isAncestor(next, live))) return live;
		return next;
	};

	// While on, re-measure every frame. The snapshot is only replaced when the
	// geometry changes, so the rendered buttons persist and hover state survives.
	createEffect(() => {
		const current = mode();
		if (current === "off") {
			setSnapshot([]);
			setHovered(null);
			return;
		}
		let frame = 0;
		let last = "";
		let target: ComponentInstance | null = null;
		const tick = () => {
			const stage = props.stage()?.getBoundingClientRect();
			if (stage) {
				let groups: Group[];
				if (current === "all") {
					groups = computeGroups(mountedInstances(), stage, false);
				} else {
					target = hoverTarget(target);
					groups = target === null ? [] : computeGroups(chainOf(target), stage, true);
				}
				const sig = JSON.stringify(groups);
				if (sig !== last) {
					last = sig;
					setSnapshot(groups);
				}
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		onCleanup(() => cancelAnimationFrame(frame));
	});

	const outline = () => {
		const key = hovered();
		return key === null ? undefined : (memberMap().get(key)?.box ?? undefined);
	};

	return (
		<Show when={mode() !== "off"}>
			<Portal mount={document.body}>
				<div class="ds-labels">
					<For each={keys()}>
						{(groupKey) => (
							<div
								class="ds-label-group"
								style={{
									left: `${groupMap().get(groupKey)?.x ?? 0}px`,
									top: `${groupMap().get(groupKey)?.y ?? 0}px`,
								}}
							>
								<For each={memberKeys(groupKey)}>
									{(memberKey, index) => (
										<>
											<Show when={index() > 0}>
												<span class="ds-label-sep">·</span>
											</Show>
											<button
												type="button"
												class="ds-label-name"
												classList={{
													"ds-label-folded": memberMap().get(memberKey)?.box === null,
												}}
												title={
													memberMap().get(memberKey)?.box === null
														? "Nothing on screen of its own; shown with the component it renders"
														: undefined
												}
												onMouseDown={(e) => e.preventDefault()}
												onMouseEnter={() => setHovered(memberKey)}
												onMouseLeave={() => setHovered(null)}
												onClick={() => {
													const id = memberMap().get(memberKey)?.id;
													if (id !== undefined) props.onOpen(id);
												}}
											>
												{memberMap().get(memberKey)?.name}
											</button>
										</>
									)}
								</For>
							</div>
						)}
					</For>
					<Show when={outline()}>
						{(box) => (
							<div
								class="ds-label-outline"
								style={{
									left: `${box().left}px`,
									top: `${box().top}px`,
									width: `${box().width}px`,
									height: `${box().height}px`,
								}}
							/>
						)}
					</Show>
				</div>
			</Portal>
		</Show>
	);
};
