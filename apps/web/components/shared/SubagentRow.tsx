import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Component } from "solid-js";
import type { SubagentInfo } from "../../state";
import { BanIcon, CheckIcon, CircleIcon, LoaderIcon, XIcon, type IconProps } from "./icons";

export const STATUS_ICON: Record<string, Component<IconProps>> = {
	started: LoaderIcon,
	running: LoaderIcon,
	pending: LoaderIcon,
	completed: CheckIcon,
	done: CheckIcon,
	failed: XIcon,
	error: XIcon,
	aborted: BanIcon,
	// Lifecycle extension (G10): parked behaves like aborted (deliberately
	// stopped); idle/unavailable are dormant, not in-flight, so they use the
	// empty-circle glyph. All icons verified to exist in ../shared/icons.
	parked: BanIcon,
	idle: CircleIcon,
	unavailable: CircleIcon,
};

export interface SubagentRowProps {
	sub: SubagentInfo;
	/** When true, render model chip + last-activity time + unread dot. Default false (byte-compatible row). */
	showMeta?: boolean;
	/** Unread activity dot (derived by the hub from lastUpdate vs lastSeen; see subagents/workerScope). */
	unread?: boolean;
	/** Model chip text (WorkerRecord model when present; defensive — SubagentInfo has no model field). */
	model?: string;
}

/** Display name: the SDK id is the spawned name ("Anna"; "." nests, "Anna.Bob");
 *  `progress-N` placeholders (id-less progress frames) have no name yet. */
export function subagentName(sub: SubagentInfo): string {
	if (sub.id.startsWith("progress-")) return sub.agent;
	return sub.id.split(".").join(">");
}

/**
 * Latest object for subagent `id`. Subagent lists MUST render `<For>` over ids,
 * never objects: the mirror and worker store hand out a fresh object per frame
 * and `<For>` keys by reference, so object-keyed rows remount every frame
 * (restarting the spinner, dropping clicks mid-press). The last seen object is
 * kept so a row being disposed never reads undefined.
 */
export function latestSubagent<T extends SubagentInfo>(
	lookup: (id: string) => T | null | undefined,
	id: string,
): () => T {
	let last = lookup(id)!;
	return () => (last = lookup(id) ?? last);
}

/** One roster row for a subagent: status glyph, name, agent type, description, status text. */
export const SubagentRow: Component<SubagentRowProps> = (props) => (
	<div class="subagent-row">
		<span class="subagent-glyph" data-status={props.sub.status}>
			<Dynamic component={STATUS_ICON[props.sub.status] ?? LoaderIcon} />
		</span>
		<span class="subagent-agent">{subagentName(props.sub)}</span>
		<Show when={subagentName(props.sub) !== props.sub.agent}>
			<span class="subagent-type">{props.sub.agent}</span>
		</Show>
		<span class="subagent-desc">{props.sub.description ?? props.sub.task ?? ""}</span>
		<span class="subagent-status">{props.sub.status}</span>
		<Show when={props.showMeta}>
			<Show when={props.model}>
				<span class="subagent-model" title={props.model}>
					{props.model}
				</span>
			</Show>
			<span class="subagent-time">{new Date(props.sub.lastUpdate).toLocaleTimeString()}</span>
			<Show when={props.unread}>
				<span class="subagent-status" aria-label="unread activity" title="unread">
					●
				</span>
			</Show>
		</Show>
	</div>
);
