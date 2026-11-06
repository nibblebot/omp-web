import type {
	PromptCacheDetailRowDto,
	PromptCacheStatusDto,
	PromptCacheStatusReply,
} from "#lib/wire/protocol";
import { type Accessor, createEffect, createMemo, createSignal, on } from "solid-js";
import { createNow } from "../activities/clock";
import { isReady, state } from "../state";
import { type PromptCacheIndicator, promptCacheIndicator } from "../usage/prompt-cache";
import { call, isSessionSwitchSupersession } from "./transport";

/**
 * The attached session's prompt-cache status for the composer's cache indicator (`getPromptCacheStatus`, a
 * read-only call). The status is not pushed: it is read on attach and session switch, after each turn end and
 * compaction, when the indicator's popover opens, and when the entry lapses by the clock. Text (the hover
 * brief and the detail rows) is the session's own wording, kept as answered. A session that predates the
 * method nacks it (`Unknown method`) and the indicator hides, like one with nothing to report.
 */

export interface PromptCacheView {
	status: PromptCacheStatusDto;
	/** The hover card's two lines, as the SDK words them. */
	brief: readonly [string, string];
	details: readonly PromptCacheDetailRowDto[];
	/** The attachment the read belongs to. */
	workspaceId: string;
	sessionId: string;
}

const [view, setView] = createSignal<PromptCacheView | null>(null);
let flight: { workspaceId: string; sessionId: string } | undefined;
/** A refresh asked for while one was in flight: the answer on the way may predate the reason it was asked. */
let again = false;

/** What the indicator shows; null (hidden) while there is no status, the read failed, or it is for another attachment. */
export function promptCacheView(): PromptCacheView | null {
	const shown = view();
	if (shown === null) return null;
	return shown.workspaceId === state.currentWorkspaceId && shown.sessionId === state.sessionId
		? shown
		: null;
}

/** Drop the read (an attach or session switch: it describes the session left behind). */
export function clearPromptCache(): void {
	setView(null);
}

function viewOf(
	reply: PromptCacheStatusReply | null | undefined,
	workspaceId: string,
	sessionId: string,
): PromptCacheView | null {
	if (!reply?.status || !reply.brief) return null;
	return {
		status: reply.status,
		brief: reply.brief,
		details: reply.details ?? [],
		workspaceId,
		sessionId,
	};
}

/**
 * Read the status now. Single-flight per attachment: a second ask during a read runs once more when it lands.
 * An answer for an attachment the tab has left is dropped. A failed read hides the indicator, except a
 * superseded or offline one, which keeps what was shown.
 */
export async function refreshPromptCache(): Promise<void> {
	const workspaceId = state.currentWorkspaceId;
	const sessionId = state.sessionId;
	if (workspaceId === "" || !state.connected) return;
	if (flight?.workspaceId === workspaceId && flight.sessionId === sessionId) {
		again = true;
		return;
	}
	const mine = { workspaceId, sessionId };
	flight = mine;
	try {
		const reply = (await call("getPromptCacheStatus", [])) as PromptCacheStatusReply | null;
		if (workspaceId === state.currentWorkspaceId && sessionId === state.sessionId)
			setView(viewOf(reply, workspaceId, sessionId));
	} catch (err) {
		if (!isSessionSwitchSupersession(err) && state.connected) {
			if (workspaceId === state.currentWorkspaceId && sessionId === state.sessionId) setView(null);
		}
	} finally {
		if (flight === mine) flight = undefined;
	}
	if (again) {
		again = false;
		await refreshPromptCache();
	}
}

/**
 * Keep the read current for the calling owner (the composer's status bar): clear it when the attachment
 * changes and read once the session is ready, read again when a turn ends (`state.streaming` falls) and when
 * a compaction ends (`state.compacting` falls).
 */
export function watchPromptCache(): void {
	createEffect(
		on(
			() => [state.currentWorkspaceId, state.sessionId, isReady()] as const,
			([workspaceId, sessionId, ready], previous) => {
				if (previous?.[0] !== workspaceId || previous?.[1] !== sessionId) clearPromptCache();
				if (ready && sessionId !== "") void refreshPromptCache();
			},
		),
	);
	createEffect(
		on(
			() => state.streaming,
			(streaming, was) => {
				if (was === true && !streaming) void refreshPromptCache();
			},
			{ defer: true },
		),
	);
	createEffect(
		on(
			() => state.compacting,
			(compacting, was) => {
				if (was === true && !compacting) void refreshPromptCache();
			},
			{ defer: true },
		),
	);
}

/**
 * The indicator for the shown read, recomputed as the clock moves (page-visibility aware, `createNow`), or
 * undefined while hidden. When a warm entry lapses by the clock the indicator flips to cold at once and the
 * session is asked again: omp's warm refresh can keep an entry alive without any frame saying so.
 */
export function createPromptCacheIndicator(
	periodMs = 1000,
): Accessor<PromptCacheIndicator | undefined> {
	const now = createNow(periodMs);
	const indicator = createMemo(
		() => {
			const shown = promptCacheView();
			return shown ? promptCacheIndicator(shown.status, now()) : undefined;
		},
		undefined,
		{ equals: (a, b) => a?.tone === b?.tone && a?.label === b?.label && a?.expired === b?.expired },
	);
	createEffect(
		on(
			() => indicator()?.expired === true,
			(expired, was) => {
				if (expired && was !== true) void refreshPromptCache();
			},
		),
	);
	return indicator;
}
