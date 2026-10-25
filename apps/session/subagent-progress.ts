// Wire projection and cadence of `subagent_progress` frames. The SDK's
// AgentProgress carries bulk history (`recentTools`, `recentOutput`) and changes
// on every streamed delta; the wire gets the newest tool only, at most one frame
// per agent per interval, as deltas over the last frame sent.
import type { AgentProgress, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task";
import type {
	SubagentProgressDelta,
	SubagentProgressFields,
	SubagentProgressFrame,
} from "#lib/wire/protocol";

/** Per-agent cadence of `subagent_progress` frames: at most one per interval, with a trailing flush. */
export const SUBAGENT_PROGRESS_INTERVAL_MS = 1000;

function compact<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/**
 * Wire projection of the SDK's AgentProgress. The bulk arrays (`recentTools`,
 * `recentOutput`) stay on the session; the wire carries only the newest tool.
 */
export function projectProgress(progress: AgentProgress): SubagentProgressFields {
	const latest = progress.recentTools[0];
	return compact({
		id: progress.id,
		status: progress.status,
		description: progress.description,
		lastIntent: progress.lastIntent,
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		currentToolIntent: progress.currentToolIntent,
		currentToolStartMs: progress.currentToolStartMs,
		lastTool:
			latest === undefined
				? undefined
				: compact({
						tool: latest.tool,
						args: latest.args,
						intent: latest.intent,
						isError: latest.isError,
					}),
		durationMs: progress.durationMs,
		toolCount: progress.toolCount,
		requests: progress.requests,
		tokens: progress.tokens,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		cost: progress.cost,
		completionPercent: progress.completionPercent,
		stage: progress.stage,
		resolvedModel: progress.resolvedModel,
		resolvedModelIdentity: progress.resolvedModelIdentity,
		resolvedThinkingLevel: progress.resolvedThinkingLevel,
		resolvedModelIsFallback: progress.resolvedModelIsFallback,
		advisor: progress.advisor,
	});
}

/**
 * Fields whose value differs from `prev`. A key present in `prev` but gone
 * from `next` is a cleared field: sent as null when `clear` is set, else left out.
 */
function changedFields(
	prev: Record<string, unknown>,
	next: Record<string, unknown>,
	clear: boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
		const before = prev[key];
		const after = next[key];
		if (after === undefined) {
			if (clear && before !== undefined) out[key] = null;
		} else if (JSON.stringify(before) !== JSON.stringify(after)) {
			out[key] = after;
		}
	}
	return out;
}

export interface ProgressCoalescerOptions {
	/** Receives each frame that goes out, in order. */
	emit: (frame: SubagentProgressFrame) => void;
	/** Clock in ms; injected by tests. */
	now?: () => number;
	/** Timer scheduling; injected by tests. */
	schedule?: (run: () => void, ms: number) => Timer;
	/** Timer cancellation; injected by tests. */
	cancel?: (timer: Timer | undefined) => void;
}

export interface ProgressCoalescer {
	/** Record the latest progress for an agent; a frame goes out now or on the trailing flush. */
	offer(payload: SubagentProgressPayload): void;
	/** Send the pending progress for an agent immediately, if any. */
	flush(id: string): void;
	/** Flush nothing further for an agent: cancels its trailing timer and forgets its last frame. */
	drop(id: string): void;
	/** Drop every agent (session change). */
	dropAll(): void;
}

interface ProgressChannel {
	/** Projected fields last sent; null until the first frame goes out. */
	sent: Record<string, unknown> | null;
	/** Task metadata last sent (task, assignment, parentToolCallId, sessionFile). */
	meta: Record<string, unknown>;
	sentAt: number;
	pending: SubagentProgressPayload | undefined;
	timer: Timer | undefined;
}

/**
 * Coalesces progress per agent. The first frame is full; later frames are deltas
 * carrying absolute values, so re-applying one is idempotent. A field left out is
 * unchanged, and an explicit null clears it. Frames are sent only when something changed.
 */
export function createProgressCoalescer(options: ProgressCoalescerOptions): ProgressCoalescer {
	const now = options.now ?? Date.now;
	const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
	const cancel = options.cancel ?? clearTimeout;
	const channels = new Map<string, ProgressChannel>();

	function flush(id: string): void {
		const channel = channels.get(id);
		const payload = channel?.pending;
		if (channel === undefined || payload === undefined) return;
		channel.pending = undefined;
		const fields = projectProgress(payload.progress) as unknown as Record<string, unknown>;
		const meta = compact({
			task: payload.task,
			assignment: payload.assignment,
			parentToolCallId: payload.parentToolCallId,
			sessionFile: payload.sessionFile,
		}) as Record<string, unknown>;
		const first = channel.sent === null;
		const changed = changedFields(channel.sent ?? {}, fields, true);
		const metaChanged = changedFields(channel.meta, meta, false);
		if (!first && Object.keys(changed).length === 0 && Object.keys(metaChanged).length === 0)
			return;
		channel.sent = fields;
		channel.meta = meta;
		channel.sentAt = now();
		options.emit({
			index: payload.index,
			agent: payload.agent,
			...(first ? {} : { delta: true as const }),
			...(metaChanged as Pick<
				SubagentProgressFrame,
				"task" | "assignment" | "parentToolCallId" | "sessionFile"
			>),
			progress: { ...changed, id: payload.progress.id } as SubagentProgressDelta,
		});
	}

	function drop(id: string): void {
		const channel = channels.get(id);
		if (channel === undefined) return;
		cancel(channel.timer);
		channels.delete(id);
	}

	return {
		offer(payload) {
			const id = payload.progress.id;
			const channel: ProgressChannel = channels.get(id) ?? {
				sent: null,
				meta: {},
				sentAt: 0,
				pending: undefined,
				timer: undefined,
			};
			channels.set(id, channel);
			channel.pending = payload;
			if (channel.timer !== undefined) return;
			const wait =
				channel.sent === null ? 0 : channel.sentAt + SUBAGENT_PROGRESS_INTERVAL_MS - now();
			if (wait <= 0) {
				flush(id);
				return;
			}
			channel.timer = schedule(() => {
				channel.timer = undefined;
				flush(id);
			}, wait);
		},
		flush,
		drop,
		dropAll() {
			for (const id of channels.keys()) drop(id);
		},
	};
}
