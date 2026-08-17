import type { Component } from "solid-js";
import {
	CheckIcon,
	DiamondIcon,
	LoaderIcon,
	RefreshIcon,
	XIcon,
	type IconProps,
} from "../shared/icons";

/** Daemon state → status glyph (moved out of src/daemon-ui.ts so the root
 *  module no longer imports components/; roster + debug consumers only). */
export const DAEMON_ICON: Record<string, Component<IconProps>> = {
	starting: LoaderIcon,
	running: LoaderIcon,
	ready: CheckIcon,
	restarting: RefreshIcon,
	stopping: DiamondIcon,
	exited: XIcon,
	failed: XIcon,
};
