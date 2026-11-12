import { createSignal } from "solid-js";
import type { SessionScope } from "#lib/wire/protocol";
import {
	BROWSER_UI_PLUGIN_OWNER_PREFIX,
	BROWSER_UI_STATUS_PREFIX,
	BROWSER_UI_WIDGET_PREFIX,
	BROWSER_UI_WORKING_ID,
	buildBrowserUiParams,
	type BrowserUiContribution,
} from "#lib/wire/browser-ui-contract";
import { setState, state } from "../state";
import { isConnected, sendCommand } from "./transport";

export interface BrowserUiRequest {
	requestId: string;
	contribution: BrowserUiContribution;
	scope: SessionScope | undefined;
	busy: boolean;
	error: string | null;
}
export interface BrowserUiState {
	requests: BrowserUiRequest[];
	error: string | null;
}
export function createBrowserUiState(): BrowserUiState {
	return { requests: [], error: null };
}

// ---------------------------------------------------------------------------
// Hidden status bars: the statuses, line widgets and working message extensions
// set around the composer (`ctx.ui.setStatus`, `setWidget`, `setWorkingMessage`).
// The choice is per contribution id (`status:<key>`, `widget:<key>`, `working`),
// kept in this browser with the plugin the session traced the bar to, so the
// Plugins tab can still name it while no session shows it. The session keeps
// sending a hidden bar; it is only not drawn.
// ---------------------------------------------------------------------------

const HIDDEN_STATUS_BARS_KEY = "omp.hiddenStatusBars";

export interface HiddenStatusBar {
	id: string;
	/** The installed plugin that set it, when the session could tell. */
	plugin?: string;
}

function storedHiddenStatusBars(): HiddenStatusBar[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(HIDDEN_STATUS_BARS_KEY) ?? "[]");
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((item: unknown): HiddenStatusBar[] => {
			if (typeof item !== "object" || item === null) return [];
			const { id, plugin } = item as Record<string, unknown>;
			if (typeof id !== "string") return [];
			return [typeof plugin === "string" ? { id, plugin } : { id }];
		});
	} catch {
		return [];
	}
}

const [hidden, setHidden] = createSignal<HiddenStatusBar[]>(storedHiddenStatusBars());

/** The status bars the user hid in this browser. */
export const hiddenStatusBars = hidden;

/** The contribution's id when it is a bar an extension set around the composer; else undefined. */
export function statusBarId(contribution: BrowserUiContribution): string | undefined {
	const id = contribution.id;
	return id === BROWSER_UI_WORKING_ID ||
		id.startsWith(BROWSER_UI_STATUS_PREFIX) ||
		id.startsWith(BROWSER_UI_WIDGET_PREFIX)
		? id
		: undefined;
}

/** The installed plugin the session traced the contribution to, if any. */
export function statusBarPlugin(contribution: BrowserUiContribution): string | undefined {
	return contribution.owner.startsWith(BROWSER_UI_PLUGIN_OWNER_PREFIX)
		? contribution.owner.slice(BROWSER_UI_PLUGIN_OWNER_PREFIX.length)
		: undefined;
}

export function isStatusBarHidden(contribution: BrowserUiContribution): boolean {
	const id = statusBarId(contribution);
	return id !== undefined && hidden().some((bar) => bar.id === id);
}

export function setStatusBarHidden(id: string, hide: boolean, plugin?: string): void {
	const next = hidden().filter((bar) => bar.id !== id);
	if (hide) next.push(plugin === undefined ? { id } : { id, plugin });
	setHidden(next);
	if (typeof localStorage === "undefined") return;
	try {
		if (next.length === 0) localStorage.removeItem(HIDDEN_STATUS_BARS_KEY);
		else localStorage.setItem(HIDDEN_STATUS_BARS_KEY, JSON.stringify(next));
	} catch {
		// Storage full or blocked: the choice holds for this page load.
	}
}

const [pluginBars, setPluginBars] = createSignal<ReadonlyMap<string, string>>(new Map());

/**
 * The plugin of each plugin-set bar this page has been shown, by contribution id. Kept after
 * the bar goes, so the Plugins tab can still list the bar of a plugin that was just disabled.
 */
export const seenPluginStatusBars = pluginBars;

function sameScope(scope: SessionScope | undefined): boolean {
	const current = state.sessionScope;
	return (
		scope?.sessionId === current?.sessionId &&
		scope?.generation === current?.generation &&
		scope?.workspaceId === current?.workspaceId
	);
}

/** Boundary validation is identical to the host's; arbitrary HTML/code never renders. */
export function receiveBrowserUiRequest(frame: { id: string; params: unknown }): void {
	try {
		const contribution = buildBrowserUiParams(frame.params);
		if (state.browserUi.requests.length >= 32)
			throw new Error("Too many live browser UI contributions (maximum 32)");
		const requests = state.browserUi.requests.filter(
			(request) =>
				request.requestId !== frame.id &&
				(request.contribution.owner !== contribution.owner ||
					request.contribution.id !== contribution.id),
		);
		const barId = statusBarId(contribution);
		const plugin = statusBarPlugin(contribution);
		if (barId !== undefined && plugin !== undefined && pluginBars().get(barId) !== plugin)
			setPluginBars(new Map(pluginBars()).set(barId, plugin));
		setState("browserUi", "requests", [
			...requests,
			{
				requestId: frame.id,
				contribution,
				scope: state.sessionScope ? { ...state.sessionScope } : undefined,
				busy: false,
				error: null,
			},
		]);
		setState("browserUi", "error", null);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setState("browserUi", "error", message);
		void sendCommand({ type: "ui_response", id: frame.id, error: message }).catch(() => {});
	}
}

export function endBrowserUiRequest(requestId: string): void {
	setState(
		"browserUi",
		"requests",
		state.browserUi.requests.filter((request) => request.requestId !== requestId),
	);
}

/** Resolve exactly this live request. An action completes it; repeat taps cannot execute twice. */
export async function answerBrowserUiRequest(requestId: string, actionId?: string): Promise<void> {
	const request = state.browserUi.requests.find((item) => item.requestId === requestId);
	if (!request || !sameScope(request.scope))
		throw new Error("Browser UI request belongs to an ended or replaced session");
	if (request.busy) return;
	if (
		actionId !== undefined &&
		!request.contribution.payload.blocks.some(
			(block) => block.type === "actions" && block.actions.some((action) => action.id === actionId),
		)
	) {
		throw new Error("Browser UI action is not declared by this contribution");
	}
	if (!isConnected()) throw new Error("Cannot answer browser UI while disconnected");
	setState("browserUi", "requests", (item) => item.requestId === requestId, {
		busy: true,
		error: null,
	});
	try {
		await sendCommand({
			type: "ui_response",
			id: requestId,
			...(actionId === undefined ? {} : { result: { actionId } }),
		});
		if (sameScope(request.scope)) endBrowserUiRequest(requestId);
	} catch (error) {
		if (sameScope(request.scope)) {
			setState("browserUi", "requests", (item) => item.requestId === requestId, {
				busy: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		throw error;
	}
}

/** Call before changing attachment/generation; cancel never means approval. */
export function resetBrowserUiRequests(): void {
	for (const request of state.browserUi.requests) {
		if (sameScope(request.scope) && isConnected()) {
			void sendCommand({ type: "ui_response", id: request.requestId }).catch(() => {});
		}
	}
	setState("browserUi", createBrowserUiState());
}
