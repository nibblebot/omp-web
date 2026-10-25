/**
 * In-page measurement probe for the browser pass.
 *
 * `installProbe` is passed to Playwright's `addInitScript`, which serialises
 * the function source and runs it in every document before page scripts. It
 * therefore MUST stay self-contained: no imports, no references to module
 * scope (type annotations are erased and are fine).
 *
 * What it does, with the least work it can get away with in the page it measures:
 * - wraps `WebSocket` so a `message` listener registered in the constructor of the
 *   browser socket (`/ws`) runs BEFORE the app's own listener (the DOM is still
 *   pre-update at stamping time); only messages that carry a frame are counted;
 * - stamps `performance.timeOrigin + performance.now()` (wall-clock ms, sub-ms
 *   resolution) per frame and `JSON.parse`s only frames whose text contains a
 *   marker for something we record;
 * - records `click` events in the capture phase (t0 for TTFF and turn time);
 * - tracks how many non-whitespace characters of assistant markdown the DOM shows
 *   (`.msg-assistant .md` outside thinking blocks) via a MutationObserver dirty
 *   flag plus a requestAnimationFrame loop that only runs while deltas await
 *   rendering, and turns that into per-delta "visible by next frame" lag.
 */

/** One main-session `text_delta`: join key parts and the wall-clock arrival. */
export interface ProbeDelta {
	req: number;
	contentIndex: number;
	/** Cumulative `delta.length` for (req, contentIndex) including this delta. */
	offset: number;
	deltaLength: number;
	recvWallMs: number;
}

export interface ProbeClick {
	atWallMs: number;
	/** `aria-label` or class of the nearest button-like ancestor, for telling the clicks apart. */
	target: string;
}

export interface ProbeData {
	frames: number;
	deltaFrames: number;
	clicks: ProbeClick[];
	deltas: ProbeDelta[];
	attachedAtWallMs?: number;
	/** Final `history` chunk of the attach priming. */
	historyAtWallMs?: number;
	/** `available_commands` after the final history (priming group complete). */
	primedAtWallMs?: number;
	firstDeltaAtWallMs?: number;
	/** First animation frame at which the DOM showed the first delta's text. */
	firstRenderedAtWallMs?: number;
	agentEndAtWallMs?: number;
	/** Frame-arrival to DOM-visible-at-next-animation-frame, per rendered delta, ms. */
	renderLagMs: number[];
	/** Deltas whose text never appeared in the DOM (or not yet). */
	renderPending: number;
	/** Non-whitespace characters received in deltas vs shown in assistant DOM (both since the first delta). */
	deltaChars: number;
	shownChars: number;
	/** Median of `Date.now() - (timeOrigin + performance.now())` sampled per frame, ms. */
	wallSkewMs: number[];
}

export interface ProbeConfig {
	/** Workspace id of the session under test; frames carrying another workspaceId are ignored. */
	workspaceId: string;
	/** Name of the window property the probe state lives under. */
	key: string;
}

export function installProbe(cfg: ProbeConfig): void {
	interface WireFrame {
		type?: string;
		workspaceId?: string;
		final?: boolean;
		messages?: Array<{ role?: string }>;
		event?: {
			type?: string;
			message?: { role?: string };
			assistantMessageEvent?: { type?: string; contentIndex?: number; delta?: string };
		};
	}
	const NativeWebSocket = window.WebSocket;
	const wall = (): number => performance.timeOrigin + performance.now();
	const state: ProbeData = {
		frames: 0,
		deltaFrames: 0,
		clicks: [],
		deltas: [],
		renderLagMs: [],
		renderPending: 0,
		deltaChars: 0,
		shownChars: 0,
		wallSkewMs: [],
	};
	Reflect.set(window, cfg.key, state);

	let historyAssistant = 0;
	let liveAssistant = 0;
	let primed = false;
	const offsets: Record<string, number> = {};
	// Render tracking.
	const pending: Array<{ need: number; recvWallMs: number }> = [];
	let cumulative = 0;
	let baseline = -1;
	let dirty = true;
	let scheduled = false;

	const assistantChars = (): number => {
		let total = 0;
		for (const el of document.querySelectorAll(".msg-assistant .md")) {
			if (el.closest(".thinking-block") !== null) continue;
			const text = el.textContent ?? "";
			for (let i = 0; i < text.length; i++) {
				const c = text.charCodeAt(i);
				if (c !== 32 && c !== 10 && c !== 9 && c !== 13 && c !== 160) total++;
			}
		}
		return total;
	};

	const tick = (): void => {
		scheduled = false;
		const at = wall();
		if (dirty) {
			dirty = false;
			const shown = assistantChars() - baseline;
			state.shownChars = shown;
			let done = 0;
			while (done < pending.length && pending[done]!.need <= shown) {
				const item = pending[done]!;
				state.renderLagMs.push(at - item.recvWallMs);
				if (state.firstRenderedAtWallMs === undefined) state.firstRenderedAtWallMs = at;
				done++;
			}
			if (done > 0) pending.splice(0, done);
		}
		state.renderPending = pending.length;
		if (pending.length > 0) schedule();
	};
	const schedule = (): void => {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(tick);
	};
	new MutationObserver(() => {
		dirty = true;
	}).observe(document, { subtree: true, childList: true, characterData: true });

	document.addEventListener(
		"click",
		(ev) => {
			const target = ev.target instanceof Element ? ev.target : null;
			const holder = target?.closest("button, [role=button]") ?? target;
			state.clicks.push({
				atWallMs: wall(),
				target: holder?.getAttribute("aria-label") ?? holder?.className?.toString() ?? "",
			});
		},
		true,
	);

	const onFrame = (ev: MessageEvent): void => {
		const at = wall();
		const data = String(ev.data);
		// Browser socket messages: {"seq":N,"frame":F} / {"frame":F}; pings and acks carry no frame.
		if (!data.startsWith('{"seq":') && !data.startsWith('{"frame":')) return;
		state.frames++;
		if (state.wallSkewMs.length < 64) state.wallSkewMs.push(Date.now() - at);
		const interesting =
			data.includes("text_delta") ||
			data.includes("message_start") ||
			data.includes("agent_end") ||
			data.includes('"attached"') ||
			data.includes('"history"') ||
			data.includes("available_commands");
		if (!interesting) return;
		const envelope: { frame?: WireFrame } = JSON.parse(data);
		const frame = envelope.frame;
		if (frame === undefined) return;
		if (frame.workspaceId !== undefined && frame.workspaceId !== cfg.workspaceId) return;
		switch (frame.type) {
			case "attached":
				if (state.attachedAtWallMs === undefined) state.attachedAtWallMs = at;
				historyAssistant = 0;
				liveAssistant = 0;
				for (const k of Object.keys(offsets)) delete offsets[k];
				return;
			case "history":
				for (const m of frame.messages ?? []) if (m.role === "assistant") historyAssistant++;
				if (frame.final !== false) state.historyAtWallMs = at;
				return;
			case "available_commands":
				if (state.historyAtWallMs !== undefined && !primed) {
					primed = true;
					state.primedAtWallMs = at;
				}
				return;
		}
		const inner = frame.event;
		if (inner === undefined) return;
		if (inner.type === "message_start" && inner.message?.role === "assistant") {
			liveAssistant++;
			// The app renders the message_start payload's text (the first chunk) itself,
			// so the pre-turn DOM size must be taken here, before the app's listener runs.
			if (primed && baseline < 0) baseline = assistantChars();
			return;
		}
		if (inner.type === "agent_end") {
			state.agentEndAtWallMs = at;
			return;
		}
		if (inner.type !== "message_update") return;
		const update = inner.assistantMessageEvent;
		if (
			update?.type !== "text_delta" ||
			typeof update.delta !== "string" ||
			typeof update.contentIndex !== "number"
		) {
			return;
		}
		state.deltaFrames++;
		const req = historyAssistant + liveAssistant - 1;
		const key = `${req}:${update.contentIndex}`;
		const offset = (offsets[key] ?? 0) + update.delta.length;
		offsets[key] = offset;
		state.deltas.push({
			req,
			contentIndex: update.contentIndex,
			offset,
			deltaLength: update.delta.length,
			recvWallMs: at,
		});
		if (state.firstDeltaAtWallMs === undefined) {
			state.firstDeltaAtWallMs = at;
			if (baseline < 0) baseline = assistantChars();
		}
		let visible = 0;
		for (let i = 0; i < update.delta.length; i++) {
			const c = update.delta.charCodeAt(i);
			if (c !== 32 && c !== 10 && c !== 9 && c !== 13 && c !== 160) visible++;
		}
		cumulative += visible;
		state.deltaChars = cumulative;
		pending.push({ need: cumulative, recvWallMs: at });
		dirty = true;
		state.renderPending = pending.length;
		schedule();
	};

	class ProbedWebSocket extends NativeWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			if (new URL(String(url), location.href).pathname === "/ws") {
				this.addEventListener("message", onFrame);
			}
		}
	}
	window.WebSocket = ProbedWebSocket;
}
