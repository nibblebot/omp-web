import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent";
import type {
	CollabUiRequestDraft,
	CollabUiSelectItem,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { CollabHostAdapter } from "./collab-host";
import type { ServerFrame } from "#lib/wire/protocol";
import { BROWSER_UI_METHOD } from "#lib/wire/browser-ui-contract";
import type { SessionEntry } from "./session-entry";
import { broadcastTo, notifyEvent, streams, type ClientConsumer } from "./client-delivery";
import { wrapTerminalHooks } from "./browser-ui";

// ---------------------------------------------------------------------------
// ExtensionUIContext (plan §1.7): the dialog subset round-trips over the
// socket as ui_request/ui_response frames; declarative presentation hooks are adapted.
// Pending requests live on the owning SessionEntry, target only that
// session's attached streams (production browsers ride the callback pair, so
// the target set may be empty), and are rejected when every targeted stream
// has closed with no callback-pair browser attached, and on session close /
// server shutdown.
// ---------------------------------------------------------------------------

let nextUiRequestId = 1;

/**
 * Sentinel for the collab ui preference: the collab channel went away
 * mid-request (no writable guest at send time, teardown, abort); the caller
 * falls through to the web-socket path below.
 */
const COLLAB_UI_FALLTHROUGH = Symbol("collab-ui-fallthrough");

/** The web side of a dialog is unreachable (no client attached, or the last one closed). */
class WebClientGoneError extends Error {}

/** Dialogs in flight per session, so Stop can cancel them without the SDK's signal. */
const dialogControllers = new WeakMap<SessionEntry, Set<AbortController>>();

/**
 * Cancel every pending dialog of the session: each resolves `undefined` (the
 * SDK maps that to "cancelled by the user"), its web dialog is dismissed, and
 * a collab guest's copy is ended. Stop calls this before aborting the turn, so
 * a pending ask can never outlive the abort.
 */
export function cancelEntryUiRequests(entry: SessionEntry): void {
	for (const controller of dialogControllers.get(entry) ?? []) controller.abort();
}

/**
 * The ExtensionUIContext dialog subset. With a writable collab guest attached
 * the dialog goes to the web host AND every writable guest; the first answer
 * wins and the losers' dialogs close ("answered by <name>"). A dialog also
 * ends when the SDK's signal aborts or {@link cancelEntryUiRequests} runs.
 */
function uiRequest(
	entry: SessionEntry,
	method: string,
	params: unknown,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<unknown> {
	const controller = new AbortController();
	const controllers = dialogControllers.get(entry) ?? new Set<AbortController>();
	dialogControllers.set(entry, controllers);
	controllers.add(controller);
	const outer = dialogOptions?.signal;
	const onOuterAbort = (): void => controller.abort();
	if (outer?.aborted) controller.abort();
	else outer?.addEventListener("abort", onOuterAbort, { once: true });
	return runDialog(entry, method, params, controller.signal).finally(() => {
		controllers.delete(controller);
		outer?.removeEventListener("abort", onOuterAbort);
	});
}

interface DialogOutcome {
	value?: unknown;
	error?: Error;
	/** Participant whose answer settled the dialog (collab dialogs only). */
	by?: string;
	/** Collab peer id of that participant; absent for the web host. */
	peer?: number;
}

function runDialog(
	entry: SessionEntry,
	method: string,
	params: unknown,
	signal: AbortSignal,
): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	if (signal.aborted) {
		resolve(undefined);
		return promise;
	}
	const live = entry.collab.adapter;
	const adapter = live?.isLive && live.writableGuestCount > 0 ? live : null;
	const guestAbort = new AbortController();
	const route: GuestRoute = { signal: guestAbort.signal };
	let webId: string | undefined;
	let webActive = false;
	let guestActive = false;
	let settled = false;

	const settle = (outcome: DialogOutcome): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", onAbort);
		guestAbort.abort();
		const answeredBy =
			outcome.error === undefined && outcome.value !== undefined ? outcome.by : undefined;
		// The web host's own answer needs no "answered by" frame; a guest win does.
		if (webId !== undefined)
			endWebUiRequest(entry, webId, outcome.peer === undefined ? undefined : answeredBy);
		if (adapter && answeredBy) adapter.announceDialogAnswered(answeredBy, outcome.peer);
		if (outcome.error) reject(outcome.error);
		else resolve(outcome.value);
	};
	const onAbort = (): void => settle({ value: undefined });
	signal.addEventListener("abort", onAbort, { once: true });

	const startWeb = (): void => {
		if (settled) return;
		webActive = true;
		webUiRequest(entry, method, params, (id) => {
			webId = id;
		}).then(
			(value) => {
				webActive = false;
				settle({ value, by: adapter?.hostName });
			},
			(error: Error) => {
				webActive = false;
				// A guest may still answer when the web client merely went away.
				if (error instanceof WebClientGoneError && guestActive) return;
				settle({ error });
			},
		);
	};
	const startGuests = (collab: CollabHostAdapter): void => {
		guestActive = true;
		uiRequestViaCollab(collab, method, params, route).then(
			(value) => {
				guestActive = false;
				if (value !== COLLAB_UI_FALLTHROUGH) {
					settle({ value, by: route.answered?.by, peer: route.answered?.peer });
				} else if (!webActive) {
					// No writable guest left (or the dialog is not a collab surface):
					// re-route to the web dialog, which ends the dialog when there is none.
					startWeb();
				}
			},
			(error: Error) => {
				guestActive = false;
				settle({ error });
			},
		);
	};

	if (adapter) {
		if (hasBrowserUiClient(entry)) startWeb();
		startGuests(adapter);
	} else {
		startWeb();
	}
	return promise;
}

let callbackBrowserStreamCount: (() => number) | null = null;

/**
 * Wire (or clear) the callback-pair browser-stream count provider (index.ts
 * owns the callback pair). Production browsers ride the pair as virtual
 * streams, invisible to this process's /ws consumers, so the local
 * `streams` set stays empty and browser presence must be asked of the pair.
 */
export function setCallbackBrowserStreamCount(fn: (() => number) | null): void {
	callbackBrowserStreamCount = fn;
}

/**
 * True when a browser can answer a dialog for this session: a local /ws
 * consumer attached to the entry, or a live callback-pair browser stream.
 * The pre-existing web dialog path; one pending request per entry.
 */
export function hasBrowserUiClient(entry: SessionEntry): boolean {
	for (const stream of streams) {
		if (stream.attached === entry.handle) return true;
	}
	return (callbackBrowserStreamCount?.() ?? 0) > 0;
}

export function webUiRequest(
	entry: SessionEntry,
	method: string,
	params: unknown,
	onRegistered?: (id: string) => void,
): Promise<unknown> {
	const targets = new Set<ClientConsumer>();
	for (const stream of streams) {
		if (stream.attached === entry.handle) targets.add(stream);
	}
	// A callback-only request registers with an empty target set on purpose:
	// the frame still rides the broadcast mirror to the pair's browsers.
	if (!hasBrowserUiClient(entry))
		return Promise.reject(new WebClientGoneError("No connected client to answer the UI request"));
	const id = `ui${nextUiRequestId++}`;
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	entry.pendingUiRequests.set(id, { streams: targets, method, params, resolve, reject });
	onRegistered?.(id);
	broadcastTo(entry.handle, { type: "ui_request", id, method, params });
	return promise;
}

/** End one pending web dialog as cancelled and dismiss it on every client. No-op once settled. */
function endWebUiRequest(entry: SessionEntry, id: string, answeredBy?: string): void {
	const pending = entry.pendingUiRequests.get(id);
	if (!pending) return;
	entry.pendingUiRequests.delete(id);
	pending.resolve(undefined);
	broadcastTo(entry.handle, {
		type: "ui_request_end",
		id,
		...(answeredBy ? { answeredBy } : {}),
	});
}

/**
 * The open dialogs as `ui_request` frames, for priming a client that attaches
 * (or reloads) while one is pending: live broadcasts are never replayed to a
 * fresh stream, so without this a reload mid-ask leaves a turn blocked on a
 * dialog nobody can see.
 */
export function pendingUiRequestFrames(entry: SessionEntry): ServerFrame[] {
	const frames: ServerFrame[] = [];
	for (const [id, p] of entry.pendingUiRequests) {
		if (p.method === undefined || p.method === BROWSER_UI_METHOD) continue;
		frames.push({ type: "ui_request", id, method: p.method, params: p.params });
	}
	return frames;
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

/** Per-dialog collab routing: the abort that closes the guests' copy, and who answered last. */
interface GuestRoute {
	signal: AbortSignal;
	answered?: { by: string; peer: number };
}

/**
 * One collab dialog round-trip. Resolves with the guest's value (undefined =
 * genuine guest cancel) or COLLAB_UI_FALLTHROUGH when the collab channel is
 * unavailable (no writable guest, teardown, or the route's signal aborted).
 */
async function collabAsk(
	adapter: CollabHostAdapter,
	draft: CollabUiRequestDraft,
	route: GuestRoute,
): Promise<unknown> {
	const request = adapter.requestGuestUi(draft, route.signal);
	if (!request) return COLLAB_UI_FALLTHROUGH;
	const result = await request;
	if (result.kind === "unavailable") return COLLAB_UI_FALLTHROUGH;
	route.answered = { by: result.by, peer: result.peer };
	return result.value;
}

/**
 * Sequential per-question askDialog over the wire, mirroring the TUI's
 * #runGuestAskDialog minus the "Chat about this" escape. `undefined` is a
 * genuine guest cancel that aborts the whole dialog; COLLAB_UI_FALLTHROUGH
 * routes back to the /ws sockets.
 */
async function askDialogViaCollab(
	adapter: CollabHostAdapter,
	questions: ExtensionAskDialogQuestion[],
	route: GuestRoute,
): Promise<unknown> {
	const results: ExtensionAskDialogResultItem[] = [];
	for (let index = 0; index < questions.length; index++) {
		const q = questions[index];
		const selected = new Set<string>();
		let customInput: string | undefined;
		const baseOptions: CollabUiSelectItem[] = q.options.map((o) =>
			o.description?.trim() ? { label: o.label, description: o.description.trim() } : o.label,
		);
		if (q.multi) {
			while (true) {
				const checkedIndices = q.options
					.map((option, i) => (selected.has(option.label) ? i : -1))
					.filter((i) => i >= 0);
				const choice = await collabAsk(
					adapter,
					{
						kind: "select",
						title: q.question,
						options: [...baseOptions, "Other (type your own)", "Next →"],
						selectionMarker: "checkbox",
						checkedIndices,
						markableCount: q.options.length,
					},
					route,
				);
				if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
				if (choice === "Next →") break;
				if (choice === "Other (type your own)") {
					const input = await collabAsk(
						adapter,
						{
							kind: "editor",
							title: q.question,
							prefill: "",
						},
						route,
					);
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
				const choice = await collabAsk(
					adapter,
					{
						kind: "select",
						title: q.question,
						options: [...baseOptions, "Other (type your own)"],
					},
					route,
				);
				if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
				if (choice === "Other (type your own)") {
					const input = await collabAsk(
						adapter,
						{
							kind: "editor",
							title: q.question,
							prefill: "",
						},
						route,
					);
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
			options: q.options.map((o) => o.label),
			multi: !!q.multi,
			selectedOptions: q.options.map((o) => o.label).filter((label) => selected.has(label)),
			customInput,
		});
	}
	return { kind: "submit", results };
}

/** Dialog dispatch to the writable guests; COLLAB_UI_FALLTHROUGH when they cannot answer it. */
async function uiRequestViaCollab(
	adapter: CollabHostAdapter,
	method: string,
	params: unknown,
	route: GuestRoute,
): Promise<unknown> {
	if (method === "askDialog") {
		// Shape fixed by buildUiContext's askDialog call site.
		const p = params as AskDialogParams;
		return askDialogViaCollab(adapter, p.questions, route);
	}
	const draft = mapUiMethodToCollab(method, params);
	if (!draft) return COLLAB_UI_FALLTHROUGH;
	const value = await collabAsk(adapter, draft, route);
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
 * closed), but a resume with `after` must replay end-after-request, not a
 * stale dialog (finding #16).
 */
export function rejectStreamUiRequests(
	entry: SessionEntry,
	stream: ClientConsumer,
	reason: string,
): void {
	for (const [id, p] of entry.pendingUiRequests) {
		p.streams.delete(stream);
		// A pending request survives while a callback-pair browser is attached.
		if (p.streams.size === 0 && !hasBrowserUiClient(entry)) {
			p.reject(new WebClientGoneError(reason));
			entry.pendingUiRequests.delete(id);
			broadcastTo(entry.handle, { type: "ui_request_end", id });
		}
	}
}

/** One context per session: dialog requests and notices route to that session's streams. */
export function buildUiContext(entry: SessionEntry): ExtensionUIContext {
	return wrapTerminalHooks(entry, {
		select: (title, options, dialogOptions) =>
			uiRequest(entry, "select", { title, options }, dialogOptions) as Promise<string | undefined>,
		confirm: async (title, message, dialogOptions) =>
			Boolean(await uiRequest(entry, "confirm", { title, message }, dialogOptions)),
		input: (title, placeholder, dialogOptions) =>
			uiRequest(entry, "input", { title, placeholder }, dialogOptions) as Promise<
				string | undefined
			>,
		editor: (title, prefill, dialogOptions) =>
			uiRequest(entry, "editor", { title, prefill }, dialogOptions) as Promise<string | undefined>,
		askDialog: (questions, dialogOptions) =>
			uiRequest(entry, "askDialog", { questions }, dialogOptions) as Promise<
				ExtensionAskDialogResult | undefined
			>,
		notify: (message, type) => notifyEvent(entry, message, type ?? "info"),
	});
}
