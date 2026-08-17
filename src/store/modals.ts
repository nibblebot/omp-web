import type { ClientCommand } from "../../shared/protocol";
import { setState, state } from "../state";
import { isConnected, postCommand } from "./transport";

/**
 * Modals/login domain (Phase 3 store facade split): server-pushed login
 * prompts and ExtensionUIContext dialog answers. The modal registry mirror
 * (state.modal, ModalName, loginUrl/loginCodeRequest/uiRequest fields) stays
 * in state.ts alongside the mux that populates it.
 */

export function sendLoginCode(requestId: string, code: string): void {
	setState("loginCodeRequest", null);
	if (!isConnected()) return;
	void postCommand({
		type: "login_code",
		id: crypto.randomUUID(),
		requestId,
		code,
	} satisfies ClientCommand).catch(() => {});
}

// Phase 3: answer the server's ui_request (ExtensionUIContext dialogs).
// Routing is by stream attachment — no sessionId on the command. The
// ui_request id doubles as the POST dedup id.
export function sendUiResponse(id: string, result: unknown): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (!isConnected()) return;
	void postCommand({ type: "ui_response", id, result } satisfies ClientCommand).catch(() => {});
}

// Cancellation resolves the request undefined — NOT the error variant. The
// AskTool rich-dialog path (tools/ask.ts) maps an undefined result to
// ToolAbortError("Ask tool was cancelled by the user"); a rejected promise
// (`error` field) would surface the raw error text instead.
export function cancelUiRequest(id: string): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (!isConnected()) return;
	void postCommand({ type: "ui_response", id } satisfies ClientCommand).catch(() => {});
}
