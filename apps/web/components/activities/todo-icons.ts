import type { Component } from "solid-js";
import {
	BanIcon,
	LoaderIcon,
	SquareCheckIcon,
	SquareIcon,
	XIcon,
	type IconProps,
} from "../ui/icons";

/** Todo task status → checkbox glyph, shared by the Todo tool card and the Activities checklist. */
export const TODO_ICON: Record<string, Component<IconProps>> = {
	done: SquareCheckIcon,
	completed: SquareCheckIcon,
	in_progress: LoaderIcon,
	pending: SquareIcon,
	abandoned: BanIcon,
	blocked: XIcon,
};

/** The glyph for a status; an unknown one reads as pending. */
export function todoIcon(status: string): Component<IconProps> {
	return TODO_ICON[status] ?? SquareIcon;
}
