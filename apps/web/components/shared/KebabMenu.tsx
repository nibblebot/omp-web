import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { DotsIcon } from "./icons";

/** "⋯" trigger + dropdown (the sidebar row-actions menu pattern shared by
 *  DaemonRow and ProjectGroup). Open state is internal by default; pass
 *  `open`/`onOpenChange` to share it module-level (DaemonSidebar survives
 *  roster-broadcast remounts by keeping one open-menu id in a module
 *  signal). Dismisses on outside pointerdown or Escape. */
export function KebabMenu(props: {
	/** Trigger title/aria-label. */
	label: string;
	/** Dropdown content (`role="menu"` items). */
	children: JSX.Element;
	/** Controlled open state (module-level sharing); omit for internal. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	class?: string;
}): JSX.Element {
	let wrap!: HTMLDivElement;
	const [ownOpen, setOwnOpen] = createSignal(false);
	const open = () => (props.open !== undefined ? props.open : ownOpen());
	const setOpen = (v: boolean) => {
		if (props.open !== undefined) props.onOpenChange?.(v);
		else setOwnOpen(v);
	};
	createEffect(() => {
		if (!open()) return;
		const close = () => setOpen(false);
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Element) || !wrap.contains(e.target)) close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		onCleanup(() => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		});
	});
	return (
		<div class="sidebar-menu-wrap" ref={wrap}>
			<button
				type="button"
				class="daemon-icon-btn sidebar-menu-btn"
				title={props.label}
				aria-label={props.label}
				aria-haspopup="menu"
				aria-expanded={open()}
				onClick={(e) => {
					e.stopPropagation();
					setOpen(!open());
				}}
			>
				<DotsIcon />
			</button>
			<Show when={open()}>
				<div class="sidebar-menu" role="menu" onClick={(e) => e.stopPropagation()}>
					{props.children}
				</div>
			</Show>
		</div>
	);
}
