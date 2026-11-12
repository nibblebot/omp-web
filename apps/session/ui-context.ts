import type {
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionFormDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent";
import {
	approvalAnswerForChoice,
	approvalChoiceLabels,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import type {
	CollabUiRequestDraft,
	CollabUiSelectItem,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { CollabHostAdapter } from "./collab-host";
import { buildFormParams, formResultFromSubmit } from "./ui-form";
import { formFields } from "#lib/wire/ask-form";
import { defaultFormData, fieldError, textValue } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import {
	disambiguateDisplayLabels,
	sanitizeCarriageReturns,
} from "@oh-my-pi/pi-tui/render/render-utils";
import type {
	UiFormChoiceAnswer,
	UiFormChoiceField,
	UiFormField,
	UiFormFieldAnswer,
	UiFormParams,
	UiFormSubmit,
	UiFormTextAnswer,
	UiFormTextField,
} from "#lib/wire/ask-form";
import type { ServerFrame, UiApprovalAnswer, UiApprovalParams } from "#lib/wire/protocol";
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
 * Run `run` as one cancellable dialog of the session: its signal aborts when the SDK's
 * `outer` signal does or {@link cancelEntryUiRequests} runs, so Stop reaches work done
 * before the dialog opens (a form's pictures loading) as well as the dialog itself.
 */
function withDialogSignal<T>(
	entry: SessionEntry,
	outer: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const controllers = dialogControllers.get(entry) ?? new Set<AbortController>();
	dialogControllers.set(entry, controllers);
	controllers.add(controller);
	const onOuterAbort = (): void => controller.abort();
	if (outer?.aborted) controller.abort();
	else outer?.addEventListener("abort", onOuterAbort, { once: true });
	return run(controller.signal).finally(() => {
		controllers.delete(controller);
		outer?.removeEventListener("abort", onOuterAbort);
	});
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
	return withDialogSignal(entry, dialogOptions?.signal, (signal) =>
		runDialog(entry, method, params, signal),
	);
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
	/** The SDK's `secret` dialog option: the typed value is masked and never shown to guests. */
	secret?: true;
}
interface EditorDialogParams {
	title: string;
	prefill?: string;
}
interface AskDialogParams {
	questions: ExtensionAskDialogQuestion[];
}

/**
 * An approve answer from a browser or guest as the SDK's answer union. Anything but an
 * explicit approval the prompt offers (a cancel included) is `deny`: `session` only when the
 * prompt has a session choice, a grant only when the prompt lists that scope.
 */
function toApprovalAnswer(
	prompt: Pick<ExtensionApprovalPrompt, "session" | "grants">,
	value: unknown,
): ExtensionApprovalAnswer {
	if (value === "once") return "once";
	if (value === "session") return prompt.session ? "session" : "deny";
	if (typeof value === "object" && value !== null) {
		const { grant, always } = value as Partial<Extract<UiApprovalAnswer, object>>;
		if (prompt.grants?.some((offered) => offered.scope === grant) && grant) {
			return { grant, always: always === true };
		}
	}
	return "deny";
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
			// Guests answer through a plaintext editor; a secret input is the host's alone.
			if (p.secret) return null;
			return { kind: "editor", title: p.title, prefill: p.placeholder };
		}
		case "editor": {
			// Shape fixed by buildUiContext's editor call site.
			const p = params as EditorDialogParams;
			return { kind: "editor", title: p.title, prefill: p.prefill };
		}
		case "approve": {
			// Shape fixed by buildUiContext's approve call site. Guests have no approval dialog:
			// they get the SDK's select fallback, mapped back by approvalAnswerForChoice.
			const p = params as UiApprovalParams;
			return { kind: "select", title: p.full, options: approvalChoiceLabels(p) };
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

const FORM_OTHER_OPTION = "Other (type your own)";
const FORM_NEXT_OPTION = "Next →";

/** A guest's free-text Other answer to a choice group, on one line; undefined = cancelled. */
async function formOtherViaCollab(
	adapter: CollabHostAdapter,
	question: string,
	route: GuestRoute,
): Promise<string | undefined | typeof COLLAB_UI_FALLTHROUGH> {
	const input = await collabAsk(adapter, { kind: "editor", title: question, prefill: "" }, route);
	if (input === COLLAB_UI_FALLTHROUGH || input === undefined) return input;
	return (input as string).replace(/[\r\n]+/g, " ");
}

/**
 * One choice group as the TUI's #runGuestFormChoice walks it: a select with the defaults
 * preselected (a radio group or single select picks once; a checkbox group or multi select
 * toggles rows until Next) and a free-text Other row where the field offers one.
 */
async function formChoiceViaCollab(
	adapter: CollabHostAdapter,
	field: UiFormChoiceField,
	route: GuestRoute,
): Promise<UiFormChoiceAnswer | undefined | typeof COLLAB_UI_FALLTHROUGH> {
	const enabled = field.options.flatMap((option, i) => (option.disabled ? [] : [i]));
	// Nothing a guest could pick: the group contributes nothing, as in the local form.
	if (enabled.length === 0 && !field.other)
		return { kind: "choice", index: field.index, checked: [] };
	const question = sanitizeCarriageReturns(field.question);
	const checked = new Set(enabled.filter((i) => field.options[i]!.checked));
	const labels = disambiguateDisplayLabels(
		enabled.map((i) => {
			const option = field.options[i]!;
			return sanitizeCarriageReturns(spansText(option.label).trim() || option.value);
		}),
		[FORM_OTHER_OPTION, FORM_NEXT_OPTION],
	);
	const rows = field.other ? [...labels, FORM_OTHER_OPTION] : labels;
	if (!field.multi) {
		// Several checked radios: the last wins, as in the local form.
		const preselected = enabled.findLastIndex((i) => checked.has(i));
		while (true) {
			const choice = await collabAsk(
				adapter,
				{
					kind: "select",
					title: question,
					options: rows,
					initialIndex: Math.max(0, preselected),
					selectionMarker: "radio",
				},
				route,
			);
			if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
			if (field.other && choice === FORM_OTHER_OPTION) {
				const typed = await formOtherViaCollab(adapter, question, route);
				if (typed === COLLAB_UI_FALLTHROUGH) return typed;
				// A cancelled or blank Other answer re-shows the options.
				if (typed === undefined || !typed.trim()) continue;
				return { kind: "choice", index: field.index, checked: [], other: typed };
			}
			const picked = enabled[labels.indexOf(choice as string)];
			return {
				kind: "choice",
				index: field.index,
				checked: picked === undefined ? [] : [picked],
			};
		}
	}
	let other: string | undefined;
	while (true) {
		// Mirror the local form's required check: Next appears once something is checked.
		const canSubmit = !field.required || checked.size > 0 || other !== undefined;
		const checkedIndices = enabled.flatMap((i, row) => (checked.has(i) ? [row] : []));
		if (other !== undefined) checkedIndices.push(labels.length);
		const choice = await collabAsk(
			adapter,
			{
				kind: "select",
				title: question,
				options: canSubmit ? [...rows, FORM_NEXT_OPTION] : rows,
				selectionMarker: "checkbox",
				checkedIndices,
				markableCount: rows.length,
			},
			route,
		);
		if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
		if (choice === FORM_NEXT_OPTION) {
			return {
				kind: "choice",
				index: field.index,
				checked: [...checked].sort((a, b) => a - b),
				...(other === undefined ? {} : { other }),
			};
		}
		if (field.other && choice === FORM_OTHER_OPTION) {
			if (other !== undefined) {
				other = undefined;
				continue;
			}
			const typed = await formOtherViaCollab(adapter, question, route);
			if (typed === COLLAB_UI_FALLTHROUGH) return typed;
			// A cancelled or blank Other answer leaves Other unchecked.
			if (typed?.trim()) other = typed;
			continue;
		}
		const toggled = enabled[labels.indexOf(choice as string)];
		if (toggled === undefined) continue;
		if (!checked.delete(toggled)) checked.add(toggled);
	}
}

/** One text field as the TUI's #runGuestFormText walks it: an editor prefilled with the value, re-asked until it passes the field's rules. */
async function formTextViaCollab(
	adapter: CollabHostAdapter,
	field: UiFormTextField,
	route: GuestRoute,
): Promise<UiFormTextAnswer | undefined | typeof COLLAB_UI_FALLTHROUGH> {
	const question = sanitizeCarriageReturns(field.question);
	let text = field.value;
	let error: string | undefined;
	while (true) {
		const input = await collabAsk(
			adapter,
			{ kind: "editor", title: error ? `${question} (${error})` : question, prefill: text },
			route,
		);
		if (input === COLLAB_UI_FALLTHROUGH || input === undefined) return input;
		// A single-line input cannot hold line breaks.
		text = field.multiline ? (input as string) : (input as string).replace(/[\r\n]+/g, " ");
		error = fieldError(field, textValue(field, text));
		if (!error) return { kind: "text", index: field.index, text };
	}
}

/**
 * A guest's run through the form, answering as the browser would: every named field in
 * order, a select per choice group and an editor per text field. `undefined` is a guest
 * cancel; COLLAB_UI_FALLTHROUGH routes back to the web dialog.
 */
async function formDialogViaCollab(
	adapter: CollabHostAdapter,
	form: UiFormParams,
	route: GuestRoute,
): Promise<UiFormSubmit | undefined | typeof COLLAB_UI_FALLTHROUGH> {
	const answers: UiFormFieldAnswer[] = [];
	for (const field of formFields(form)) {
		if (!field.name) continue;
		const answer =
			field.kind === "choice"
				? await formChoiceViaCollab(adapter, field, route)
				: await formTextViaCollab(adapter, field, route);
		if (answer === COLLAB_UI_FALLTHROUGH || answer === undefined) return answer;
		answers.push(answer);
	}
	return { kind: "submit", answers };
}

/** Dialog dispatch to the writable guests; COLLAB_UI_FALLTHROUGH when they cannot answer it. */
async function uiRequestViaCollab(
	adapter: CollabHostAdapter,
	method: string,
	params: unknown,
	route: GuestRoute,
): Promise<unknown> {
	if (method === "formDialog") {
		// Shape fixed by buildUiContext's formDialog call site.
		return formDialogViaCollab(adapter, params as UiFormParams, route);
	}
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
	// approve answers with a select label over the wire; the web contract wants the answer union.
	if (method === "approve") {
		return approvalAnswerForChoice(params as UiApprovalParams, value as string | undefined);
	}
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

/**
 * The ask tool's HTML form, whole. The session parses it (the SDK's `parseHtmlForm`) and
 * sends the structured form with its pictures resolved to `data:` URIs; the browser (or a
 * collab guest walking it field by field) answers with {@link UiFormSubmit}, which becomes
 * the SDK's form data plus the browser's notes on chosen options (a guest's walk has none,
 * like the SDK's field-by-field hosts). Cancel is `undefined`. An invalid answer rejects
 * (see {@link formResultFromSubmit}). `dialogOptions.timeout` is a fixed deadline from the
 * moment the form is shown: at it the form's defaults submit with `timedOut`, `onTimeout`
 * fires and the web dialog ends (typing does not postpone it, unlike the TUI's inactivity
 * reset). That submission has no notes: the TUI's timeout sends its working values and
 * notes, but the browser's never reach the session before Submit.
 */
function formDialog(
	entry: SessionEntry,
	html: string,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<ExtensionFormDialogResult | undefined> {
	const form = parseHtmlForm(html);
	return withDialogSignal(entry, dialogOptions?.signal, async (signal) => {
		const params = await buildFormParams(form, { cwd: entry.cwd, signal });
		if (signal.aborted) return undefined;
		const timeout = dialogOptions?.timeout;
		const timer = new AbortController();
		let timedOut = false;
		let timeoutId: NodeJS.Timeout | undefined;
		if (timeout !== undefined && timeout > 0) {
			params.deadline = Date.now() + timeout;
			timeoutId = setTimeout(() => {
				if (signal.aborted) return;
				timedOut = true;
				dialogOptions?.onTimeout?.();
				timer.abort();
			}, timeout);
		}
		try {
			const answer = await runDialog(
				entry,
				"formDialog",
				params,
				AbortSignal.any([signal, timer.signal]),
			);
			if (answer !== undefined) return formResultFromSubmit(form, answer);
			return timedOut ? { data: defaultFormData(form), timedOut: true } : undefined;
		} finally {
			clearTimeout(timeoutId);
		}
	});
}

/** One context per session: dialog requests and notices route to that session's streams. */
export function buildUiContext(entry: SessionEntry): ExtensionUIContext {
	return wrapTerminalHooks(entry, {
		select: (title, options, dialogOptions) =>
			uiRequest(entry, "select", { title, options }, dialogOptions) as Promise<string | undefined>,
		confirm: async (title, message, dialogOptions) =>
			Boolean(await uiRequest(entry, "confirm", { title, message }, dialogOptions)),
		input: (title, placeholder, dialogOptions) =>
			uiRequest(
				entry,
				"input",
				{ title, placeholder, ...(dialogOptions?.secret ? { secret: true } : {}) },
				dialogOptions,
			) as Promise<string | undefined>,
		editor: (title, prefill, dialogOptions) =>
			uiRequest(entry, "editor", { title, prefill }, dialogOptions) as Promise<string | undefined>,
		askDialog: (questions, dialogOptions) =>
			uiRequest(entry, "askDialog", { questions }, dialogOptions) as Promise<
				ExtensionAskDialogResult | undefined
			>,
		formDialog: (html, dialogOptions) => formDialog(entry, html, dialogOptions),
		// The wire carries the prompt minus `compact`, which no web surface shows.
		approve: async (prompt, dialogOptions) => {
			const params: UiApprovalParams = {
				full: prompt.full,
				...(prompt.session ? { session: prompt.session } : {}),
				...(prompt.grants?.length ? { grants: prompt.grants.map((grant) => ({ ...grant })) } : {}),
			};
			return toApprovalAnswer(prompt, await uiRequest(entry, "approve", params, dialogOptions));
		},
		notify: (message, type) => notifyEvent(entry, message, type ?? "info"),
	});
}
