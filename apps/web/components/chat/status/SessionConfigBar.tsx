import { createSignal, Show, type Component } from "solid-js";
import { featureCommand } from "../../../features/registry";
import { openModelDialog } from "../../../store/models";
import { formatTokens, getContextUsageLevel } from "../../../usage/context";
import { presetSegmentLabel } from "../../../usage/model-roles";
import { currentThinkingSelector } from "../../../usage/model-search";
import { isReady, isSessionChanging, setState, state } from "../../../state";
import { ArrowDownIcon, ArrowUpIcon } from "../../ui/icons";
import { ModelPresetPopover } from "./ModelPresetPopover";
import { RetryBadge } from "./RetryBadge";
import { StatusSegment } from "./StatusSegment";
import { ThinkingLevelPopover } from "./ThinkingLevelPopover";

/** The preset chip: opens the preset dropdown above it; the chip owns the dropdown's open state. */
const PresetSegment: Component = () => {
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(false);
	return (
		<>
			<StatusSegment
				class="preset-segment"
				ref={setAnchor}
				popover={{ expanded: open() }}
				onClick={() => setOpen(!open())}
				title="Model presets"
			>
				{presetSegmentLabel(state.modelPresets)}
			</StatusSegment>
			<Show when={open() ? anchor() : undefined}>
				{(el) => <ModelPresetPopover anchor={el()} onClose={() => setOpen(false)} />}
			</Show>
		</>
	);
};

/** The thinking chip: opens the level dropdown above it; the chip owns the dropdown's open state. */
const ThinkingSegment: Component = () => {
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(false);
	return (
		<>
			<StatusSegment
				class="thinking-segment"
				ref={setAnchor}
				popover={{ expanded: open() }}
				onClick={() => setOpen(!open())}
				title="Thinking level"
			>
				{currentThinkingSelector(state.autoThinking, state.thinkingLevel)}
			</StatusSegment>
			<Show when={open() ? anchor() : undefined}>
				{(el) => <ThinkingLevelPopover anchor={el()} onClose={() => setOpen(false)} />}
			</Show>
		</>
	);
};

const ContextSegment: Component = () => {
	const usage = () => state.contextUsage;
	const level = () =>
		usage() ? getContextUsageLevel(usage()!.percent, usage()!.contextWindow) : "normal";
	return (
		<Show when={usage()}>
			{(u) => (
				<StatusSegment
					class="context-segment"
					dataLevel={level()}
					title={`${formatTokens(u().tokens)} of ${formatTokens(u().contextWindow)} tokens used · session stats`}
					onClick={() => setState("modal", "stats")}
				>
					<span class="context-prefix">ctx </span>
					{formatTokens(u().tokens)} / {formatTokens(u().contextWindow)}
				</StatusSegment>
			)}
		</Show>
	);
};

/** Roster-derived status for the attached session while the composer is gated. */
const rosterHint = (): string => {
	const entry = state.sessionRoster.find((x) => x.workspaceId === state.currentWorkspaceId);
	if (!entry) return "no workspace attached, pick one in the sidebar";
	if (entry.status === "ready") return "attaching to session process…";
	return `session process ${entry.status}…`;
};

/** Session-send configuration (model, preset, thinking) plus the session resource
 *  meters (ctx fill, cumulative stats), attached directly below the composer
 *  as its bottom row. Per-turn badges (starting, retry, plan) lead the row and
 *  show only while active; compaction shows in the activity bar above the composer. */
export const SessionConfigBar: Component = () => (
	<div class="session-bar">
		{/* Boot readiness gate pill (the connection strip covers disconnects):
		    show the attached session's status instead of a generic phrase. */}
		<Show when={state.connected && !isReady()}>
			<span
				class="segment badge ready-pill"
				title="The attached session is still starting (or reconnecting)…"
			>
				{rosterHint()}
			</span>
		</Show>
		<Show when={state.connected && isReady() && isSessionChanging()}>
			<span
				class="segment badge ready-pill"
				title="The session process is replacing the session; sending resumes once the new session is shown."
			>
				starting new session…
			</span>
		</Show>
		{/* Plan mode can be on from the terminal while the Plan Mode feature is off: the badge then
		    only reports it. The toggle comes from the feature registry, never from core. */}
		<Show when={state.planModeEnabled}>
			<Show
				when={featureCommand("plan")?.command}
				fallback={
					<StatusSegment
						class="badge plan-badge"
						readOnly
						title="Plan mode is on. It is controlled from the terminal while Plan Mode is in development in the browser."
					>
						Plan mode
					</StatusSegment>
				}
			>
				{(plan) => (
					<StatusSegment
						class="badge plan-badge"
						title="Plan mode on · click to exit"
						onClick={() => plan().run("")}
					>
						Plan mode
					</StatusSegment>
				)}
			</Show>
		</Show>
		<RetryBadge />
		<StatusSegment
			class="model-segment"
			onClick={() => openModelDialog("roles")}
			title="Models: roles, presets and all models (Alt+M)"
		>
			{state.model ? `${state.model.provider}/${state.model.id}` : "no model"}
		</StatusSegment>
		<PresetSegment />
		<ThinkingSegment />
		<span class="status-spacer" />
		<ContextSegment />
		<Show when={state.stats}>
			{(s) => (
				<StatusSegment
					class="stats-segment"
					onClick={() => setState("modal", "stats")}
					title="Session stats"
				>
					${s().cost.toFixed(2)}
					<span class="stats-tokens">
						· <ArrowUpIcon />
						{formatTokens(s().tokens.input)} <ArrowDownIcon />
						{formatTokens(s().tokens.output)}
					</span>
				</StatusSegment>
			)}
		</Show>
	</div>
);
