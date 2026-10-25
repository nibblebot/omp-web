import type { ClientCommand, ImageArg } from "#lib/wire/protocol";
import { setState, state } from "../state";
import { isConnected, sendCommand } from "./transport";

/**
 * Modals/login domain (Phase 3 store facade split): server-pushed login
 * prompts and ExtensionUIContext dialog answers. The modal registry mirror
 * (state.modal, ModalName, loginUrl/loginCodeRequest/uiRequest fields) stays
 * in state.ts alongside the mux that populates it.
 */

export function sendLoginCode(requestId: string, code: string): void {
	setState("loginCodeRequest", null);
	if (!isConnected()) return;
	void sendCommand({
		type: "login_code",
		id: crypto.randomUUID(),
		requestId,
		code,
	} satisfies ClientCommand).catch(() => {});
}

// Phase 3: answer the server's ui_request (ExtensionUIContext dialogs).
// Routing is by stream attachment; no sessionId on the command. The
// ui_request id doubles as the command dedup id.
export function sendUiResponse(id: string, result: unknown): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (!isConnected()) return;
	void sendCommand({ type: "ui_response", id, result } satisfies ClientCommand).catch(() => {});
}

// Cancellation resolves the request undefined, NOT the error variant. The
// AskToolCard rich-dialog path (tools/ask.ts) maps an undefined result to
// ToolAbortError("Ask tool was cancelled by the user"); a rejected promise
// (`error` field) would surface the raw error text instead.
export function cancelUiRequest(id: string): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (!isConnected()) return;
	void sendCommand({ type: "ui_response", id } satisfies ClientCommand).catch(() => {});
}

/** Full-size image overlay (ModalHost mounts ImageLightbox while the slot is set). */
export function openLightbox(image: ImageArg): void {
	setState("lightboxImage", image);
}

export function closeLightbox(): void {
	setState("lightboxImage", null);
}

/** Session details dialog (ModalHost mounts it while the id resolves to a roster entry). */
export function openSessionDetails(workspaceId: string): void {
	setState("sessionDetailsId", workspaceId);
}

export function closeSessionDetails(): void {
	setState("sessionDetailsId", null);
}

/** Worktree session list dialog for one roster session (ModalHost mounts it for `state.modal === "worktree-sessions"`). */
export function openWorktreeSessions(workspaceId: string): void {
	setState({ modal: "worktree-sessions", worktreeSessionsId: workspaceId });
}

export function closeWorktreeSessions(): void {
	setState({
		worktreeSessionsId: null,
		...(state.modal === "worktree-sessions" && { modal: null }),
	});
}
