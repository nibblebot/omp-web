import { createSignal, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Component } from "solid-js";
import { state, type SubagentInfo } from "../../state";
import { getWorkerInfo } from "../../store/subagents";
import {
	elapsedLabel,
	pickProgress,
	toolPreview,
	type ModelBadge,
	type SubagentProgressView,
} from "../../subagents/progress";
import { BanIcon, CheckIcon, CircleIcon, LoaderIcon, XIcon, type IconProps } from "../ui/icons";

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
	/** Unread activity dot (derived by the hub from lastUpdate vs lastSeen; see apps/web/subagents/worker-scope.ts). */
	unread?: boolean;
	/** Model chip text (WorkerRecord model when present; defensive — SubagentInfo has no model field). */
	model?: string;
	/** Resolved model badge (task.showResolvedModelBadge): model, thinking level, advisor. */
	badge?: ModelBadge;
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
		<Show when={props.badge}>
			{(badge) => (
				<span class="subagent-model" data-advisor={badge().advisor ? "true" : undefined}>
					{[badge().model, badge().thinking, badge().advisor ? "advisor" : undefined]
						.filter(Boolean)
						.join(" · ")}
				</span>
			)}
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

/** Live progress for subagent `id` from the worker store; reactive in tracking scopes. */
export function subagentProgress(id: string): SubagentProgressView | undefined {
	const info = getWorkerInfo(state.currentSessionId, id);
	return pickProgress(info && "progress" in info ? info.progress : undefined);
}

/**
 * Live tool preview under a running subagent (display.subagentLivePreview): its
 * current call, else the latest finished one. Ticks each second so the elapsed
 * marker advances.
 */
export const SubagentToolPreview: Component<{ progress: SubagentProgressView | undefined }> = (
	props,
) => {
	const [now, setNow] = createSignal(Date.now());
	const timer = setInterval(() => setNow(Date.now()), 1000);
	onCleanup(() => clearInterval(timer));
	const preview = () => toolPreview(props.progress);
	return (
		<Show when={preview()}>
			{(p) => (
				<span
					class="subagent-preview"
					data-running={String(p().running)}
					data-error={String(p().isError)}
				>
					<Show when={!p().running}>
						<span class="subagent-preview-last">last</span>
					</Show>
					<span class="subagent-preview-tool">{p().tool}</span>
					<Show when={p().detail}>
						{(detail) => <span class="subagent-preview-detail">{detail()}</span>}
					</Show>
					<Show when={elapsedLabel(p().startedAt, now())}>
						{(label) => <span class="subagent-preview-elapsed">{label()}</span>}
					</Show>
				</span>
			)}
		</Show>
	);
};
