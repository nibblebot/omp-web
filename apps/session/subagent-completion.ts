// Subagent completion estimates (`9xmx`), the omp TUI's `task.completionProbe`
// without the SDK's interactive-host flag. The SDK starts its probe only when
// `isInteractiveHost()` is set, and that process-global flag also raises the
// SQLite busy timeout from 1 s to 5 s (a synchronous wait that stalls this
// process's event loop) and turns on subagent replan title refreshes the web
// never shows. So the host runs the SDK's own probe (schedule, prompt, reply
// parsing, usage logging) and owns only the gate and where the estimate goes:
// it rides the wire projection of the agent's progress (`withSubagentCompletion`)
// the way the SDK's executor writes `completionPercent`/`stage` onto
// `AgentProgress` for the TUI. Differences from the TUI: the probe's cost is
// logged on the subagent's session usage but not added to its progress `cost`
// (a finished row's retained usage would drop it again).
import {
	AgentRegistry,
	MAIN_AGENT_ID,
	type AgentRef,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";
import { startCompletionProbe } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import { cfgTaskCompletionProbe } from "@oh-my-pi/pi-coding-agent/task/settings";
import { isInteractiveHost } from "@oh-my-pi/pi-utils/env";
import type { SubagentProgressFields } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

/** Seams of the probe: the SDK's runner, the agent registry, and whether the SDK already probes on its own. */
export interface SubagentCompletionDeps {
	startProbe: typeof startCompletionProbe;
	refOf: (id: string) => Pick<AgentRef, "kind" | "parentId" | "session"> | undefined;
	sdkProbes: () => boolean;
}

const DEFAULT_DEPS: SubagentCompletionDeps = {
	startProbe: startCompletionProbe,
	refOf: (id) => AgentRegistry.global().get(id),
	// An interactive host (the TUI) runs the probe inside the SDK's executor; never probe twice.
	sdkProbes: isInteractiveHost,
};

interface Track {
	controller: AbortController;
	percent?: number;
	stage?: string;
	/** The agent submitted its final yield; the estimate stays pinned at 99%. */
	yielded: boolean;
}

interface CompletionState {
	deps: SubagentCompletionDeps;
	tracks: Map<string, Track>;
}

const states = new WeakMap<SessionEntry, CompletionState>();

function stateOf(entry: SessionEntry): CompletionState {
	let state = states.get(entry);
	if (state === undefined) {
		state = { deps: DEFAULT_DEPS, tracks: new Map() };
		states.set(entry, state);
	}
	return state;
}

/** Replace the probe's seams for one entry (tests). */
export function setSubagentCompletionDeps(
	entry: SessionEntry,
	deps: Partial<SubagentCompletionDeps>,
): void {
	stateOf(entry).deps = { ...DEFAULT_DEPS, ...deps };
}

/**
 * The live session to probe, under the SDK's gate (`isCompletionProbeEnabled`):
 * only agents the main agent spawned (task depth 1), and only while
 * `task.completionProbe` is on. Read on every tick, so the setting applies live.
 */
function probedSession(deps: SubagentCompletionDeps, id: string): AgentSession | null {
	const ref = deps.refOf(id);
	if (ref?.kind !== "sub" || ref.session === null) return null;
	if (ref.parentId !== undefined && ref.parentId !== MAIN_AGENT_ID) return null;
	return cfgTaskCompletionProbe.get(ref.session.settings) ? ref.session : null;
}

/**
 * Start probing a subagent that just started (or was revived). `changed` runs
 * after each estimate lands so the caller re-sends the agent's progress.
 */
export function startSubagentCompletion(
	entry: SessionEntry,
	id: string,
	changed: () => void,
): void {
	stopSubagentCompletion(entry, id);
	const { deps, tracks } = stateOf(entry);
	if (deps.sdkProbes()) return;
	const track: Track = { controller: new AbortController(), yielded: false };
	tracks.set(id, track);
	const { signal } = track.controller;
	deps.startProbe({
		session: () => probedSession(deps, id),
		signal,
		onEstimate: (estimate) => {
			// A probe in flight when the yield landed must not pull the estimate back from 99%.
			if (signal.aborted || track.yielded) return;
			track.percent = estimate.percent;
			if (estimate.stage !== undefined) track.stage = estimate.stage;
			changed();
		},
	});
}

/** Stop probing a subagent that left the running state. */
export function stopSubagentCompletion(entry: SessionEntry, id: string): void {
	const tracks = states.get(entry)?.tracks;
	tracks?.get(id)?.controller.abort();
	tracks?.delete(id);
}

/** Stop every probe of the entry (session change). */
export function stopAllSubagentCompletion(entry: SessionEntry): void {
	const tracks = states.get(entry)?.tracks;
	if (tracks === undefined) return;
	for (const track of tracks.values()) track.controller.abort();
	tracks.clear();
}

/**
 * Whether the agent submitted its final report: a terminal `yield` (a string
 * label or none), a complete one, or an aborted one; an incremental section
 * (non-empty label array) is not. Mirrors the SDK executor's `yieldCalled`.
 */
function finalYielded(progress: AgentProgress): boolean {
	const items = progress.extractedToolData?.yield ?? [];
	return items.some((item) => {
		if (typeof item !== "object" || item === null) return true;
		const record = item as { type?: unknown; complete?: unknown; status?: unknown };
		const incremental = Array.isArray(record.type) && record.type.length > 0;
		return !incremental || record.complete === true || record.status === "aborted";
	});
}

/**
 * The agent's wire progress with its completion estimate: the latest percent
 * and stage, or 99% once it has yielded its final report (the SDK pins the same).
 * Fields the SDK set itself are left alone.
 */
export function withSubagentCompletion(
	entry: SessionEntry,
	progress: AgentProgress,
	fields: SubagentProgressFields,
): SubagentProgressFields {
	const state = states.get(entry);
	const track = state?.tracks.get(progress.id);
	if (state === undefined || track === undefined || fields.completionPercent !== undefined)
		return fields;
	if (!track.yielded && finalYielded(progress) && probedSession(state.deps, progress.id) !== null)
		track.yielded = true;
	const percent = track.yielded ? 99 : track.percent;
	if (percent === undefined) return fields;
	return {
		...fields,
		completionPercent: percent,
		...(track.stage !== undefined ? { stage: track.stage } : {}),
	};
}
