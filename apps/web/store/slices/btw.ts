// Core-owned pure slice for the /btw side panel (feature `btw`). Holds only
// the state shape, its initial value, and the reducers core event handlers
// call, so state.ts and chat.ts never import the btw feature's UI or actions.

/**
 * /btw side-panel session. streamId routes ephemeral_delta frames to this
 * panel; the panel never appears in the transcript.
 */
export interface BtwState {
	question: string;
	reply: string;
	streaming: boolean;
	streamId: number;
	error?: string;
}

export function createBtwState(): BtwState | null {
	return null;
}

/**
 * ephemeral_delta frame: route by streamId, ignore stale frames from a
 * superseded question. Coalesced into the rAF flush by streamId (frames
 * append); `flushBtwEphemeral` re-checks that this stream is still the panel's
 * live one.
 */
export function applyBtwEphemeralDelta(
	btw: BtwState | null,
	frame: { id: number; text: string },
	pending: Map<number, string>,
	scheduleFlush: () => void,
): void {
	if (btw?.streaming && frame.id === btw.streamId) {
		const prev = pending.get(frame.id);
		pending.set(frame.id, prev === undefined ? frame.text : prev + frame.text);
		scheduleFlush();
	}
}

/**
 * rAF flush of buffered ephemeral deltas: appends the live stream's text to
 * the panel reply through `appendReply`, then drops everything buffered for a
 * superseded or closed stream.
 */
export function flushBtwEphemeral(
	btw: BtwState | null,
	pending: Map<number, string>,
	appendReply: (text: string) => void,
): void {
	const streamId = btw?.streaming ? btw.streamId : undefined;
	const text = streamId === undefined ? undefined : pending.get(streamId);
	if (text !== undefined && streamId !== undefined) {
		pending.delete(streamId);
		appendReply(text);
	}
	// Frames buffered for a superseded/closed stream never apply.
	pending.clear();
}
