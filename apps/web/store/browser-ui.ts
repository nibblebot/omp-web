import type { SessionScope } from "#lib/wire/protocol";
import { buildBrowserUiParams, type BrowserUiContribution } from "#lib/wire/browser-ui-contract";
import { setState, state } from "../state";
import { isConnected, postCommand } from "./transport";

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
		void postCommand({ type: "ui_response", id: frame.id, error: message }).catch(() => {});
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
		await postCommand({
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
			void postCommand({ type: "ui_response", id: request.requestId }).catch(() => {});
		}
	}
	setState("browserUi", createBrowserUiState());
}
