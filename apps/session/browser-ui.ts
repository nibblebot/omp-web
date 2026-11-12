// Browser-host capability contract (G12: browser extension UI).
//
// Terminal TUI hooks (custom components, raw input, editor chrome, themes)
// cannot run in the headless web host. This module is the single place that
// decides what the browser does with them instead (see wrapTerminalHooks):
//
// - `BrowserUiCapability` names the eight capability slots; only the
//   available ones accept contributions.
// - Contributions are versioned, JSON-serializable, declarative payloads
//   (allowlisted text/code/list/actions blocks). Anything executable
//   (component factories, function values, html/raw/eval keys) never crosses
//   to the browser, which has no isolation boundary for it: the contract
//   rejects such payloads, and the terminal hooks that take code are no-ops.
// - Transport stays minimal: ONE ui_request method ("browser_ui") over the
//   existing browser socket ui_request/ui_response/ui_request_end path.
//   No new transport, no new bus (no OMP_PROTO bump; additive-only wire).
// - Lifecycle is owner-scoped: same (owner, id) supersedes; dispose rings
//   ui_request_end; ui_response with an undefined result cancels (existing
//   index.ts semantics); scoping is per SessionEntry object (plus its
//   handle), so a session change orphans prior contributions.
//
// The pure validation contract is shared with the browser. Runtime imports
// between this module and ui-context are only used when constructing/requesting UI.

import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { SessionEntry } from "./session-entry";
import { broadcastTo, streams, type ClientConsumer } from "./client-delivery";
import type { ServerFrame } from "#lib/wire/protocol";
import { hasBrowserUiClient, webUiRequest } from "./ui-context";
import { callerPlugin } from "./plugin-attribution";
import {
	BROWSER_UI_METHOD,
	BROWSER_UI_PLUGIN_OWNER_PREFIX,
	BROWSER_UI_STATUS_PREFIX,
	BROWSER_UI_VERSION,
	BROWSER_UI_WIDGET_PREFIX,
	BROWSER_UI_WORKING_ID,
	buildBrowserUiParams,
	type BrowserUiBlock,
	type BrowserUiCapability,
	type BrowserUiContribution,
	type BrowserUiPayload,
} from "#lib/wire/browser-ui-contract";
export * from "#lib/wire/browser-ui-contract";

// ---------------------------------------------------------------------------
// Owner-scoped lifecycle over the existing ui_request path.
// ---------------------------------------------------------------------------

interface ActiveContribution {
	requestId: string;
	contribution: BrowserUiContribution;
}

/** Live contributions per owning session entry. WeakMap: session close drops the scope. */
const activeByEntry = new WeakMap<SessionEntry, Map<string, ActiveContribution>>();

/** A contribution ended by its owner: superseded by a newer update or disposed. */
class BrowserUiReplacedError extends Error {}

function contributionKey(owner: string, id: string): string {
	return JSON.stringify([owner, id]);
}

/**
 * Make a validated contribution the live browser_ui request of its (owner, id). Update
 * semantics: the live one it replaces rejects with a "superseded" error and its
 * ui_request_end rings. `open` registers the pending request (calling `onRegistered` with its
 * id; `webUiRequest` rejects at once when no client is attached). Resolves with the
 * ui_response result; an undefined result is the client's cancel.
 */
function showContribution(
	entry: SessionEntry,
	valid: BrowserUiContribution,
	open: (onRegistered: (id: string) => void) => Promise<unknown>,
): Promise<unknown> {
	const key = contributionKey(valid.owner, valid.id);
	let actives = activeByEntry.get(entry);
	if (!actives) {
		actives = new Map();
		activeByEntry.set(entry, actives);
	}
	const prior = actives.get(key);
	if (prior) {
		actives.delete(key);
		const pending = entry.pendingUiRequests.get(prior.requestId);
		if (pending) {
			entry.pendingUiRequests.delete(prior.requestId);
			pending.reject(
				new BrowserUiReplacedError(
					`browser_ui contribution "${valid.id}" (owner "${valid.owner}") superseded by a newer update.`,
				),
			);
			broadcastTo(entry.handle, { type: "ui_request_end", id: prior.requestId });
		}
	}
	let requestId: string | undefined;
	const sessionId = entry.session?.sessionId;
	const handle = entry.handle;
	const promise = open((id) => {
		requestId = id;
		actives.set(key, { requestId: id, contribution: valid });
	}).then((result) => {
		if (entry.handle !== handle || entry.session?.sessionId !== sessionId) {
			throw new Error("browser_ui response belongs to a replaced session.");
		}
		if (result === undefined) return undefined;
		if (
			result === null ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			!("actionId" in result) ||
			typeof result.actionId !== "string" ||
			Object.keys(result).length !== 1 ||
			!valid.payload.blocks.some(
				(block) =>
					block.type === "actions" && block.actions.some((action) => action.id === result.actionId),
			)
		) {
			throw new Error(
				"browser_ui response must select a declared actionId or cancel with undefined.",
			);
		}
		return { actionId: result.actionId };
	});
	const forget = (): void => {
		if (actives.get(key)?.requestId === requestId) actives.delete(key);
	};
	void promise.then(forget, forget);
	return promise;
}

/**
 * Owner-scoped dispose: forget the (owner, id) contribution, so no client is primed with it,
 * then reject its live request and ring its ui_request_end so every attached tab dismisses it.
 * Best-effort no-op when nothing is kept or live.
 */
export function disposeBrowserUi(
	entry: SessionEntry,
	owner: string,
	id: string,
	reason = "browser_ui contribution disposed",
): void {
	const key = contributionKey(owner, id);
	retainedByEntry.get(entry)?.delete(key);
	const actives = activeByEntry.get(entry);
	const record = actives?.get(key);
	if (!record || !actives) return;
	actives.delete(key);
	const pending = entry.pendingUiRequests.get(record.requestId);
	if (!pending) return;
	entry.pendingUiRequests.delete(record.requestId);
	pending.reject(new BrowserUiReplacedError(reason));
	broadcastTo(entry.handle, { type: "ui_request_end", id: record.requestId });
}

/**
 * The bars of plugins disabled in this session, per entry, by (owner, id): taken down, and
 * kept current while the plugin's still-loaded code updates them, so enabling the plugin again
 * shows them without waiting for its next update.
 */
const heldByEntry = new WeakMap<SessionEntry, Map<string, BrowserUiContribution>>();

function hold(entry: SessionEntry, contribution: BrowserUiContribution): void {
	let held = heldByEntry.get(entry);
	if (!held) {
		held = new Map();
		heldByEntry.set(entry, held);
	}
	const key = contributionKey(contribution.owner, contribution.id);
	held.delete(key);
	held.set(key, contribution);
	// Bounded like the kept set: a disabled plugin cannot grow it without limit.
	for (const oldest of held.keys()) {
		if (held.size <= MAX_RETAINED_BROWSER_UI) break;
		held.delete(oldest);
	}
	disposeBrowserUi(entry, contribution.owner, contribution.id, "plugin disabled");
}

/** Keep `contribution` as its (owner, id)'s current one and show it to any attached browser. */
function keepAndShow(entry: SessionEntry, contribution: BrowserUiContribution): void {
	retain(entry, contribution);
	if (!hasBrowserUiClient(entry)) return;
	void showContribution(entry, contribution, (onRegistered) =>
		webUiRequest(entry, BROWSER_UI_METHOD, contribution, onRegistered),
	).catch((err: unknown) => logEnded(contribution.kind, contribution.id, err));
}

/**
 * Follow a plugin switched in this session: disabling takes down every bar traced to it,
 * enabling shows them again. Its code stays loaded either way until the next boot.
 */
export function setPluginBrowserUiEnabled(
	entry: SessionEntry,
	name: string,
	enabled: boolean,
): void {
	const owner = `${BROWSER_UI_PLUGIN_OWNER_PREFIX}${name}`;
	if (!enabled) {
		for (const kept of retainedByEntry.get(entry)?.values() ?? []) {
			if (kept.owner === owner) hold(entry, kept);
		}
		return;
	}
	const held = heldByEntry.get(entry);
	for (const [key, contribution] of held ?? []) {
		if (contribution.owner !== owner) continue;
		held?.delete(key);
		keepAndShow(entry, contribution);
	}
}

// ---------------------------------------------------------------------------
// Kept display contributions, primed to every client that attaches.
// ---------------------------------------------------------------------------

/** The most display contributions a session keeps; the browser shows at most 32 contributions. */
export const MAX_RETAINED_BROWSER_UI = 32;

/**
 * The current display contribution per (owner, id) of each session entry, kept whether or not a
 * client is attached: an extension sets its status once at `session_start`, before the first
 * browser attaches. Each is validated (at most 64 KiB), so a session keeps at most 2 MiB.
 * Scoped to the entry, which lives through new, switch and branch like the extension runner
 * that sets them: as in the terminal, an extension's status stays until the extension changes
 * or clears it. A client's dismiss ends only the live copy; the next client primed sees it.
 */
const retainedByEntry = new WeakMap<SessionEntry, Map<string, BrowserUiContribution>>();

let nextPrimedRequestId = 1;

/** Keep `valid` as the current contribution of its (owner, id); the least recently set goes past the cap. */
function retain(entry: SessionEntry, valid: BrowserUiContribution): void {
	let retained = retainedByEntry.get(entry);
	if (!retained) {
		retained = new Map();
		retainedByEntry.set(entry, retained);
	}
	const key = contributionKey(valid.owner, valid.id);
	retained.delete(key);
	retained.set(key, valid);
	for (const old of retained.values()) {
		if (retained.size <= MAX_RETAINED_BROWSER_UI) break;
		disposeBrowserUi(entry, old.owner, old.id, "browser_ui contribution evicted by newer ones");
	}
}

/**
 * The kept display contributions as `ui_request` frames for a client being primed, one per
 * (owner, id). One still live keeps its request id, so a resumed client that already shows it
 * replaces it in place. One with no live request (set while no client was attached, or whose
 * request ended when the last client left or a client dismissed it) is registered as a live
 * request without a broadcast: the clients already attached are not shown it again.
 */
export function browserUiPrimeFrames(entry: SessionEntry): ServerFrame[] {
	const retained = retainedByEntry.get(entry);
	if (!retained) return [];
	const frames: ServerFrame[] = [];
	for (const [key, contribution] of retained) {
		const live = activeByEntry.get(entry)?.get(key);
		let id: string;
		if (live?.contribution === contribution && entry.pendingUiRequests.has(live.requestId)) {
			id = live.requestId;
		} else {
			const primedId = `uib${nextPrimedRequestId++}`;
			id = primedId;
			void showContribution(entry, contribution, (onRegistered) => {
				const targets = new Set<ClientConsumer>();
				for (const stream of streams) if (stream.attached === entry.handle) targets.add(stream);
				const { promise, resolve, reject } = Promise.withResolvers<unknown>();
				entry.pendingUiRequests.set(primedId, {
					streams: targets,
					method: BROWSER_UI_METHOD,
					params: contribution,
					resolve,
					reject,
				});
				onRegistered(primedId);
				return promise;
			}).catch((err: unknown) => logEnded(contribution.kind, contribution.id, err));
		}
		frames.push({ type: "ui_request", id, method: BROWSER_UI_METHOD, params: contribution });
	}
	return frames;
}

// ---------------------------------------------------------------------------
// Terminal hooks -> browser contributions.
// ---------------------------------------------------------------------------

/** Default owner for adapter-sent contributions (callers may pass their own per-extension owner). */
export const TERMINAL_HOOKS_OWNER = "terminal-hooks";

/** Logs a contribution that ended unexpectedly; an owner's own update or dispose is routine. */
function logEnded(kind: BrowserUiCapability, id: string, err: unknown): void {
	if (err instanceof BrowserUiReplacedError) return;
	console.error(
		`omp-session: browser_ui ${kind} "${id}" ended: ${err instanceof Error ? err.message : String(err)}`,
	);
}

/**
 * The whole ExtensionUIContext over the dialog subset in `base`: select, confirm, input,
 * editor, askDialog, formDialog, approve and notify pass through untouched (a base without
 * `formDialog` leaves the ask tool on its field-by-field fallback).
 *
 * Every other hook is presentation or terminal-only. Extensions written for the SDK's terminal
 * and remote hosts call them whenever `ctx.hasUI` is true, often from un-awaited async code,
 * where a throw becomes an unhandled rejection that ends the session process. So none of them
 * throws or rejects; each behaves as on the SDK's remote hosts (modes/rpc/rpc-mode.ts
 * RpcExtensionUIContext, modes/acp/acp-agent.ts createAcpExtensionUiContext):
 * - status, working message and string-array widgets become browser_ui contributions: the
 *   latest one per key is kept whether or not a browser is attached (see
 *   {@link browserUiPrimeFrames}) and goes out at once to any attached browser; passing
 *   `undefined` clears it; an invalid payload or a later transport failure logs to stderr,
 *   never stdout;
 * - a widget's component factory, custom footers, headers and editors, the window title,
 *   writing to the composer, autocomplete providers and theme switching are no-ops, so no
 *   executable code reaches the browser;
 * - `custom` resolves `undefined` and `onTerminalInput` returns a no-op unsubscribe;
 * - getters answer as those hosts do: `theme` is the pi-tui singleton (initSdkTuiGlobals loads
 *   it at boot), no editor text or editor component, no other themes, tools collapsed.
 */
export function wrapTerminalHooks(
	entry: SessionEntry,
	base: Pick<
		ExtensionUIContext,
		"select" | "confirm" | "input" | "editor" | "askDialog" | "formDialog" | "approve" | "notify"
	>,
	owner: string = TERMINAL_HOOKS_OWNER,
): ExtensionUIContext {
	/** Clear the bar `id` set by the calling extension. */
	const clear = (id: string): void => {
		const plugin = callerPlugin();
		const retained = retainedByEntry.get(entry);
		const held = heldByEntry.get(entry);
		const exact = contributionKey(
			plugin ? `${BROWSER_UI_PLUGIN_OWNER_PREFIX}${plugin.name}` : owner,
			id,
		);
		if (held?.delete(exact)) return;
		const kept = retained?.get(exact);
		if (kept) {
			disposeBrowserUi(entry, kept.owner, id);
			return;
		}
		// Set from a call the stack traced differently (a timer, a shared helper): clear the
		// bar of that id whoever was named its owner, so it never outlives its extension's clear.
		for (const [key, other] of held ?? []) {
			if (other.id === id) held?.delete(key);
		}
		for (const other of retained?.values() ?? []) {
			if (other.id === id) disposeBrowserUi(entry, other.owner, id);
		}
	};
	const send = (
		id: string,
		kind: BrowserUiCapability,
		title: string,
		blocks: BrowserUiBlock[],
		placement?: BrowserUiPayload["placement"],
	): void => {
		const plugin = callerPlugin();
		try {
			const contribution = buildBrowserUiParams({
				id,
				kind,
				owner: plugin ? `${BROWSER_UI_PLUGIN_OWNER_PREFIX}${plugin.name}` : owner,
				title,
				payload: placement === undefined ? { blocks } : { blocks, placement },
				version: BROWSER_UI_VERSION,
			});
			// A plugin disabled in this session keeps running until the next boot; its bars do
			// not show. Only its own copy is held: another extension may use the same id.
			if (plugin?.enabled === false) hold(entry, contribution);
			else keepAndShow(entry, contribution);
		} catch (err) {
			logEnded(kind, id, err);
		}
	};
	return {
		select: base.select,
		confirm: base.confirm,
		input: base.input,
		editor: base.editor,
		askDialog: base.askDialog,
		formDialog: base.formDialog,
		approve: base.approve,
		notify: base.notify,
		get theme() {
			return theme;
		},
		onTerminalInput: () => () => {},
		// No reply or transcript block to redraw, no pickable links.
		rerenderMessage: () => {},
		refreshTranscript: () => {},
		getLinkClicksAvailable: () => false,
		setStatus: (key, text) => {
			const id = `${BROWSER_UI_STATUS_PREFIX}${key}`;
			if (text === undefined) {
				clear(id);
				return;
			}
			send(id, "panel", `Status: ${key}`, [{ type: "text", text: Bun.stripANSI(text) }]);
		},
		setWorkingMessage: (message) => {
			if (message === undefined) {
				clear(BROWSER_UI_WORKING_ID);
				return;
			}
			send(BROWSER_UI_WORKING_ID, "panel", "Working", [
				{ type: "text", text: Bun.stripANSI(message) },
			]);
		},
		setWidget: (key, content, options) => {
			const id = `${BROWSER_UI_WIDGET_PREFIX}${key}`;
			if (content === undefined) {
				clear(id);
				return;
			}
			// A component factory draws in a terminal only (the SDK's built-in autoresearch
			// extension sets one: pi-tui/src/apps/autoresearch-dashboard.ts updateWidget).
			if (!Array.isArray(content)) return;
			// Extensions color these lines with the terminal theme; the browser shows plain text.
			const blocks = content.map((line): BrowserUiBlock => ({
				type: "text",
				text: Bun.stripANSI(String(line)),
			}));
			send(id, "widget", `Widget: ${key}`, blocks, options?.placement);
		},
		setFooter: () => {},
		setHeader: () => {},
		// The browser tab title is the user's; there is no per-session title channel.
		setTitle: () => {},
		custom: async () => undefined as never,
		// The browser composer is web-local: extensions can neither write nor read it.
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		// Browser theming is a user setting, not an extension channel.
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({
			success: false,
			error: "Theme changes are unavailable in the web host",
		}),
		// Tool-output expansion is web-local.
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
