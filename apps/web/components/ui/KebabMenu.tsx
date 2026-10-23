import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { registerFocusReturn } from "./focus";
import { DotsIcon } from "./icons";
import { moveRovingFocus } from "./roving";

let kebabMenuSeq = 0;

/** "⋯" trigger + dropdown (the sidebar row-actions menu pattern shared by
 *  WorkspaceRow and ProjectGroup). Open state is internal by default; pass
 *  `open`/`onOpenChange` to share it module-level (FleetSidebar survives
 *  roster-broadcast remounts by keeping one open-menu id in a module
 *  signal). Dismisses on outside pointerdown or Escape.
 *
 *  Keyboard follows the WAI-ARIA APG menu button: Enter/Space (native click)
 *  and Down open with the first item focused, Up opens on the last. Arrow
 *  keys, Home and End move between items with wrap. Escape closes and returns
 *  focus to the trigger. Tab closes the menu and moves on from the trigger. */
export function KebabMenu(props: {
	/** Trigger aria-label, and its tooltip unless `title` is given. */
	label: string;
	/** Trigger tooltip when it should say more than the label. */
	title?: string;
	/** Dropdown content (`role="menuitem"` buttons). */
	children: JSX.Element;
	/** Controlled open state (module-level sharing); omit for internal. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	class?: string;
}): JSX.Element {
	let wrap!: HTMLDivElement;
	let trigger!: HTMLButtonElement;
	let menu: HTMLDivElement | undefined;
	let focusLast = false;
	const menuId = `kebab-menu-${++kebabMenuSeq}`;
	const [ownOpen, setOwnOpen] = createSignal(false);
	const open = () => (props.open !== undefined ? props.open : ownOpen());
	const setOpen = (v: boolean) => {
		if (props.open !== undefined) props.onOpenChange?.(v);
		else setOwnOpen(v);
	};
	const items = () =>
		menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')) : [];
	createEffect(() => {
		if (!open()) return;
		const close = () => setOpen(false);
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Element) || !wrap.contains(e.target)) close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const focusWasInMenu = menu?.contains(document.activeElement) ?? false;
			close();
			if (focusWasInMenu) trigger.focus();
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
				title={props.title ?? props.label}
				aria-label={props.label}
				aria-haspopup="menu"
				aria-expanded={open()}
				aria-controls={open() ? menuId : undefined}
				ref={trigger}
				onClick={(e) => {
					e.stopPropagation();
					setOpen(!open());
				}}
				onKeyDown={(e) => {
					if (open() || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
					e.preventDefault();
					focusLast = e.key === "ArrowUp";
					setOpen(true);
				}}
			>
				<DotsIcon />
			</button>
			<Show when={open()}>
				<div
					id={menuId}
					class="sidebar-menu"
					role="menu"
					ref={(el) => {
						menu = el;
						registerFocusReturn(el, () => trigger);
						queueMicrotask(() => {
							const list = items();
							(focusLast ? list.at(-1) : list[0])?.focus();
							focusLast = false;
						});
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						if (e.key === "Tab") {
							trigger.focus();
							setOpen(false);
							return;
						}
						const list = items();
						moveRovingFocus(e, list, list.indexOf(e.target as HTMLElement), "vertical", true);
					}}
				>
					{props.children}
				</div>
			</Show>
		</div>
	);
}
