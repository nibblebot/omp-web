import type { Component } from "solid-js";
import {
	CheckIcon,
	DiamondIcon,
	LoaderIcon,
	RefreshIcon,
	XIcon,
	type IconProps,
} from "./components/shared/icons";

export const DAEMON_ICON: Record<string, Component<IconProps>> = {
	starting: LoaderIcon,
	running: LoaderIcon,
	ready: CheckIcon,
	restarting: RefreshIcon,
	stopping: DiamondIcon,
	exited: XIcon,
	failed: XIcon,
};

/** Compact uptime: "Ns", "Nm Ns", or "Nh Nm" (floor). */
export function formatDaemonUptime(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${sec}s`;
	return `${sec}s`;
}
