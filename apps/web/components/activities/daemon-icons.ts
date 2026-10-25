import type { Component } from "solid-js";
import {
	CheckIcon,
	DiamondIcon,
	LoaderIcon,
	RefreshIcon,
	XIcon,
	type IconProps,
} from "../ui/icons";

/** Daemon state → status glyph. */
export const DAEMON_ICON: Record<string, Component<IconProps>> = {
	starting: LoaderIcon,
	running: LoaderIcon,
	ready: CheckIcon,
	restarting: RefreshIcon,
	stopping: DiamondIcon,
	exited: XIcon,
	failed: XIcon,
};
