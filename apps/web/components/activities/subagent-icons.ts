import type { Component } from "solid-js";
import type { SubagentStatus } from "../../store/subagents";
import {
	BanIcon,
	CheckIcon,
	CircleDotIcon,
	CircleIcon,
	LoaderIcon,
	XIcon,
	type IconProps,
} from "../ui/icons";

/** Subagent status → row glyph (a running agent spins; color comes from `data-status`). */
export const SUBAGENT_STATUS_ICON: Record<SubagentStatus, Component<IconProps>> = {
	pending: CircleIcon,
	running: LoaderIcon,
	done: CheckIcon,
	failed: XIcon,
	aborted: BanIcon,
	parked: CircleDotIcon,
};
