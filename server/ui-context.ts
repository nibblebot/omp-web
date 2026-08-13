import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import type { CollabUiRequestDraft, CollabUiSelectItem } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { CollabHostAdapter } from "./collab-host";
import type { SessionEntry } from "./session-entry";
import { broadcastTo, notifyEvent, streams, type SseConsumer } from "./sse-delivery";

// ---------------------------------------------------------------------------
// ExtensionUIContext (plan §1.7): the dialog subset round-trips over the
// socket as ui_request/ui_response frames; terminal-only surface is stubbed.
// Pending requests live on the owning SessionEntry, target only that
// session's attached streams, and are rejected when every targeted stream has
// closed and on session close / server shutdown.
// ---------------------------------------------------------------------------

let nextUiRequestId = 1;

/**
 * Sentinel for the collab ui preference: the collab channel went away
 * mid-request (no writable guest at send time, teardown, abort) — the caller
 * falls through to the web-socket path below.
 */
const COLLAB_UI_FALLTHROUGH = Symbol("collab-ui-fallthrough");

/**
 * The ExtensionUIContext dialog subset, answered by a writable collab guest
 * FIRST (mirroring the TUI's collab-host preference in #runGuestDialog); when
 * no writable guest is attached the request falls through to the /events streams.
 */
function uiRequest(entry: SessionEntry, method: string, params: unknown): Promise<unknown> {
	const adapter = entry.collab.adapter;
	if (adapter?.isLive && adapter.writableGuestCount > 0) {
		return uiRequestViaCollab(entry, method, params).then(value => {
			if (value === COLLAB_UI_FALLTHROUGH) return webUiRequest(entry, method, params);
			return value;
		});
	}
	return webUiRequest(entry, method, params);
}

/** The pre-existing web dialog path (one pending request per entry). */
export function webUiRequest(entry: SessionEntry, method: string, params: unknown): Promise<unknown> {
	const targets = new Set<SseConsumer>();
	for (const stream of streams) {
		if (stream.attached === entry.handle) targets.add(stream);
	}
	if (targets.size === 0) return Promise.reject(new Error("No connected client to answer the UI request"));
	const id = `ui${nextUiRequestId++}`;
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	entry.pendingUiRequests.set(id, { streams: targets, resolve, reject });
	broadcastTo(entry.handle, { type: "ui_request", id, method, params });
	return promise;
}

// Params shapes are fixed by buildUiContext's uiRequest call sites below
// (one object literal per method), so a single named cast at the mapper
// boundary is safe; the same objects ride the wire as the web ui_request.
interface SelectDialogParams {
	title: string;
	options: CollabUiSelectItem[];
}
interface ConfirmDialogParams {
	title: string;
	message?: string;
}
interface InputDialogParams {
	title: string;
	placeholder?: string;
}
interface EditorDialogParams {
	title: string;
	prefill?: string;
}
interface AskDialogParams {
	questions: ExtensionAskDialogQuestion[];
}

/** Map one dialog method to its collab wire request; null = not a collab surface. */
function mapUiMethodToCollab(method: string, params: unknown): CollabUiRequestDraft | null {
	switch (method) {
		case "select": {
			// Shape fixed by buildUiContext's select call site.
			const p = params as SelectDialogParams;
			return { kind: "select", title: p.title, options: p.options };
		}
		case "confirm": {
			// Shape fixed by buildUiContext's confirm call site.
			const p = params as ConfirmDialogParams;
			return { kind: "select", title: p.title, options: ["Yes", "No"] };
		}
		case "input": {
			// Shape fixed by buildUiContext's input call site.
			const p = params as InputDialogParams;
			return { kind: "editor", title: p.title, prefill: p.placeholder };
		}
		case "editor": {
			// Shape fixed by buildUiContext's editor call site.
			const p = params as EditorDialogParams;
			return { kind: "editor", title: p.title, prefill: p.prefill };
		}
		default:
			return null;
	}
}

/**
 * One collab dialog round-trip. Resolves with the guest's value (undefined =
 * genuine guest cancel) or COLLAB_UI_FALLTHROUGH when the collab channel is
 * unavailable.
 */
async function collabAsk(adapter: CollabHostAdapter, draft: CollabUiRequestDraft): Promise<unknown> {
	const request = adapter.requestGuestUi(draft);
	if (!request) return COLLAB_UI_FALLTHROUGH;
	const result = await request;
	if (result.kind === "unavailable") return COLLAB_UI_FALLTHROUGH;
	return result.value;
}

/**
 * Sequential per-question askDialog over the wire, mirroring the TUI's
 * #runGuestAskDialog minus the "Chat about this" escape. `undefined` is a
 * genuine guest cancel that aborts the whole dialog; COLLAB_UI_FALLTHROUGH
 * routes back to the /events streams.
 */
async function askDialogViaCollab(adapter: CollabHostAdapter, questions: ExtensionAskDialogQuestion[]): Promise<unknown> {
	const results: ExtensionAskDialogResultItem[] = [];
	for (let index = 0; index < questions.length; index++) {
		const q = questions[index];
		const selected = new Set<string>();
		let customInput: string | undefined;
		const baseOptions: CollabUiSelectItem[] = q.options.map(o =>
			o.description?.trim() ? { label: o.label, description: o.description.trim() } : o.label,
		);
		if (q.multi) {
			while (true) {
				const checkedIndices = q.options
					.map((option, i) => (selected.has(option.label) ? i : -1))
					.filter(i => i >= 0);
				const choice = await collabAsk(adapter, {
					kind: "select",
					title: q.question,
					options: [...baseOptions, "Other (type your own)", "Next →"],
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: q.options.length,
				});
				if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
				if (choice === "Next →") break;
				if (choice === "Other (type your own)") {
					const input = await collabAsk(adapter, { kind: "editor", title: q.question, prefill: "" });
					if (input === COLLAB_UI_FALLTHROUGH) return input;
					// Guest cancelled the Other editor: back to the option list.
					if (input === undefined) continue;
					customInput = input as string;
					break;
				}
				if (selected.has(choice as string)) selected.delete(choice as string);
				else selected.add(choice as string);
			}
		} else {
			while (true) {
				const choice = await collabAsk(adapter, {
					kind: "select",
					title: q.question,
					options: [...baseOptions, "Other (type your own)"],
				});
				if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
				if (choice === "Other (type your own)") {
					const input = await collabAsk(adapter, { kind: "editor", title: q.question, prefill: "" });
					if (input === COLLAB_UI_FALLTHROUGH) return input;
					// Guest cancelled the Other editor: re-show the option list.
					if (input === undefined) continue;
					customInput = input as string;
				} else {
					selected.add(choice as string);
				}
				break;
			}
		}
		results.push({
			id: q.id ?? String(index),
			question: q.question,
			options: q.options.map(o => o.label),
			multi: !!q.multi,
			selectedOptions: q.options.map(o => o.label).filter(label => selected.has(label)),
			customInput,
		});
	}
	return { kind: "submit", results };
}

/** Dialog dispatch through a live collab adapter; COLLAB_UI_FALLTHROUGH when unanswerable there. */
async function uiRequestViaCollab(entry: SessionEntry, method: string, params: unknown): Promise<unknown> {
	const adapter = entry.collab.adapter;
	if (!adapter?.isLive) return COLLAB_UI_FALLTHROUGH;
	if (method === "askDialog") {
		// Shape fixed by buildUiContext's askDialog call site.
		const p = params as AskDialogParams;
		return askDialogViaCollab(adapter, p.questions);
	}
	const draft = mapUiMethodToCollab(method, params);
	if (!draft) return COLLAB_UI_FALLTHROUGH;
	const value = await collabAsk(adapter, draft);
	if (value === COLLAB_UI_FALLTHROUGH) return value;
	// confirm answers with Yes/No over the wire; the web contract wants a boolean.
	if (method === "confirm") return value === "Yes";
	return value;
}

export function rejectEntryUiRequests(entry: SessionEntry, reason: string): void {
	for (const [id, p] of entry.pendingUiRequests) {
		p.reject(new Error(reason));
		entry.pendingUiRequests.delete(id);
		// Finding #16: ring the end so a resuming stream never replays the
		// stale (now-rejected) request as a live dialog.
		broadcastTo(entry.handle, { type: "ui_request_end", id });
	}
}

/**
 * A UI request dies only when every stream it was shown to is gone: reject it
 * and ring the end. No live stream gets the frame (the last target just
 * closed), but a Last-Event-ID resume must replay end-after-request, not a
 * stale dialog (finding #16).
 */
export function rejectStreamUiRequests(entry: SessionEntry, stream: SseConsumer, reason: string): void {
	for (const [id, p] of entry.pendingUiRequests) {
		p.streams.delete(stream);
		if (p.streams.size === 0) {
			p.reject(new Error(reason));
			entry.pendingUiRequests.delete(id);
			broadcastTo(entry.handle, { type: "ui_request_end", id });
		}
	}
}

/** One context per session: dialog requests and notices route to that session's streams. */
export function buildUiContext(entry: SessionEntry): ExtensionUIContext {
	return {
		select: (title, options) => uiRequest(entry, "select", { title, options }) as Promise<string | undefined>,
		confirm: async (title, message) => Boolean(await uiRequest(entry, "confirm", { title, message })),
		input: (title, placeholder) => uiRequest(entry, "input", { title, placeholder }) as Promise<string | undefined>,
		editor: (title, prefill) => uiRequest(entry, "editor", { title, prefill }) as Promise<string | undefined>,
		askDialog: questions => uiRequest(entry, "askDialog", { questions }) as Promise<ExtensionAskDialogResult | undefined>,
		notify: (message, type) => notifyEvent(entry, message, type ?? "info"),
		// --- Terminal-only surface: no-ops in the headless web host. ---
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.reject(new Error("Custom UI components are not supported in the web host")),
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		theme: {} as ExtensionUIContext["theme"],
		getAllThemes: () => Promise.resolve([]),
		getTheme: () => Promise.resolve(undefined),
		setTheme: () => Promise.resolve({ success: false, error: "Themes are not supported in the web host" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
