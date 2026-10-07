// Browser-host capability contract (G12: browser extension UI).
//
// Terminal TUI hooks (custom components, raw input, editor chrome, themes)
// cannot run in the headless web host. This module is the single place that
// decides what the browser CAN do instead:
//
// - `BrowserUiCapability` names the eight capability slots; only the
//   available ones accept contributions.
// - Contributions are versioned, JSON-serializable, declarative payloads
//   (allowlisted text/code/list/actions blocks). Anything executable
//   (component factories, function values, html/raw/eval keys) is rejected
//   with an isolation-contract-required error: extension payloads run in the
//   browser with no isolation boundary, so code never crosses it.
// - Transport stays minimal: ONE ui_request method ("browser_ui") over the
//   existing POST /command + SSE ui_request/ui_response/ui_request_end path.
//   No new transport, no new bus (OMP_PROTO stays 2; additive-only wire).
// - Lifecycle is owner-scoped: same (owner, id) supersedes; dispose rings
//   ui_request_end; ui_response with an undefined result cancels (existing
//   index.ts semantics); scoping is per SessionEntry object (plus its
//   handle), so a session change orphans prior contributions.
//
// The pure validation contract is shared with the browser. Runtime imports
// between this module and ui-context are only used when constructing/requesting UI.

import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "./session-entry";
import { broadcastTo } from "./sse-delivery";
import { hasBrowserUiClient, webUiRequest } from "./ui-context";
import {
	BROWSER_UI_DOC,
	BROWSER_UI_METHOD,
	BROWSER_UI_VERSION,
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

/**
 * Send one browser_ui request for a validated contribution. Update semantics:
 * sending the same (owner, id) supersedes the live one (its pending promise
 * rejects with a "superseded" error and its ui_request_end rings). Resolves
 * with the ui_response result; an undefined result is the client's cancel.
 * Rejects explicitly when no client is attached (never hangs, never a false
 * success).
 */
export function requestBrowserUi(entry: SessionEntry, contribution: unknown): Promise<unknown> {
	const valid = buildBrowserUiParams(contribution);
	const key = JSON.stringify([valid.owner, valid.id]);
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
				new Error(
					`browser_ui contribution "${valid.id}" (owner "${valid.owner}") superseded by a newer update.`,
				),
			);
			broadcastTo(entry.handle, { type: "ui_request_end", id: prior.requestId });
		}
	}
	let requestId: string | undefined;
	const sessionId = entry.session?.sessionId;
	const handle = entry.handle;
	const promise = webUiRequest(entry, BROWSER_UI_METHOD, valid, (id) => {
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
 * Owner-scoped dispose: reject the live (owner, id) request and ring its
 * ui_request_end so every attached tab dismisses it. Best-effort no-op when
 * nothing is live (e.g. already answered or disposed).
 */
export function disposeBrowserUi(
	entry: SessionEntry,
	owner: string,
	id: string,
	reason = "browser_ui contribution disposed",
): void {
	const actives = activeByEntry.get(entry);
	const record = actives?.get(JSON.stringify([owner, id]));
	if (!record || !actives) return;
	actives.delete(JSON.stringify([owner, id]));
	const pending = entry.pendingUiRequests.get(record.requestId);
	if (!pending) return;
	entry.pendingUiRequests.delete(record.requestId);
	pending.reject(new Error(reason));
	broadcastTo(entry.handle, { type: "ui_request_end", id: record.requestId });
}
/** Dispose every live contribution of one session entry (session close / teardown). */
export function disposeEntryBrowserUi(
	entry: SessionEntry,
	reason = "browser_ui contributions disposed with the session",
): void {
	const actives = activeByEntry.get(entry);
	if (!actives) return;
	for (const record of actives.values()) {
		disposeBrowserUi(entry, record.contribution.owner, record.contribution.id, reason);
	}
}

export interface BrowserUiContributionSummary {
	id: string;
	kind: BrowserUiCapability;
	owner: string;
	title: string;
	requestId: string;
}

/** Live-contribution mirror for the integrations dispatch rows (capability responses, diagnostics). */
export function listBrowserUiContributions(entry: SessionEntry): BrowserUiContributionSummary[] {
	const actives = activeByEntry.get(entry);
	if (!actives) return [];
	return [...actives.values()].map((record) => ({
		id: record.contribution.id,
		kind: record.contribution.kind,
		owner: record.contribution.owner,
		title: record.contribution.title,
		requestId: record.requestId,
	}));
}

// ---------------------------------------------------------------------------
// Migration adapter: terminal hooks -> browser contributions.
// ---------------------------------------------------------------------------

/** Default owner for adapter-sent contributions (callers may pass their own per-extension owner). */
export const TERMINAL_HOOKS_OWNER = "terminal-hooks";

function hookUnsupported(hook: string, capability: BrowserUiCapability, detail: string): Error {
	return new Error(
		`${hook} is not supported in the web host: ${detail} ` +
			`(browser capability "${capability}"; migration: wrapTerminalHooks() in apps/session/browser-ui.ts; ` +
			`see ${BROWSER_UI_DOC})`,
	);
}

function hookIsolation(hook: string, detail: string): Error {
	return new Error(
		`${hook} is not supported in the web host: ${detail} ` +
			`Executable extension code requires an isolation contract the browser host does not provide; ` +
			`contribute declarative text/code/list/actions blocks instead (see ${BROWSER_UI_DOC}).`,
	);
}

function hookRejected(
	hook: string,
	capability: BrowserUiCapability,
	detail: string,
): Promise<never> {
	return Promise.reject(hookUnsupported(hook, capability, detail));
}

/**
 * wrapTerminalHooks-style migration adapter. Presentation hooks with a
 * browser equivalent become browser_ui contributions (fire-and-forget:
 * sync hooks cannot await answers; transport failures log to stderr, never
 * stdout); hooks without one throw/reject explicit unsupported errors.
 * Non-presentation hooks (select/confirm/input/editor/askDialog/notify)
 * pass through untouched from `base`.
 */
export function wrapTerminalHooks(
	entry: SessionEntry,
	base: Pick<
		ExtensionUIContext,
		"select" | "confirm" | "input" | "editor" | "askDialog" | "notify"
	>,
	owner: string = TERMINAL_HOOKS_OWNER,
): ExtensionUIContext {
	// SDK presentation setters are synchronous: reject malformed payloads and
	// absent clients synchronously; report later transport/disposal failures.
	const send = (
		id: string,
		kind: BrowserUiCapability,
		title: string,
		blocks: BrowserUiBlock[],
		placement?: BrowserUiPayload["placement"],
	): void => {
		const contribution = buildBrowserUiParams({
			id,
			kind,
			owner,
			title,
			payload: placement === undefined ? { blocks } : { blocks, placement },
			version: BROWSER_UI_VERSION,
		});
		if (!hasBrowserUiClient(entry))
			throw new Error("No connected client to receive browser UI contribution");
		void requestBrowserUi(entry, contribution).catch((err: unknown) => {
			console.error(
				`omp-session: browser_ui ${kind} "${id}" ended: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	};
	return {
		select: base.select,
		confirm: base.confirm,
		input: base.input,
		editor: base.editor,
		askDialog: base.askDialog,
		notify: base.notify,
		get theme(): never {
			throw hookUnsupported("theme", "renderer", "terminal themes are unavailable in the browser");
		},
		onTerminalInput: () => {
			throw hookUnsupported(
				"onTerminalInput",
				"composer",
				"the browser has no raw keystroke channel (composer covers submitted text, not keystrokes)",
			);
		},
		setStatus: (key, text) => {
			if (text === undefined) {
				disposeBrowserUi(entry, owner, `status:${key}`);
				return;
			}
			send(`status:${key}`, "panel", `Status: ${key}`, [{ type: "text", text }]);
		},
		setWorkingMessage: (message) => {
			if (message === undefined) {
				disposeBrowserUi(entry, owner, "working");
				return;
			}
			send("working", "panel", "Working", [{ type: "text", text: message }]);
		},
		setWidget: (key, content, options) => {
			if (content === undefined) {
				disposeBrowserUi(entry, owner, `widget:${key}`);
				return;
			}
			if (typeof content === "function") {
				throw hookIsolation(
					"setWidget",
					`widget "${key}" is a component factory, which is executable code.`,
				);
			}
			if (!Array.isArray(content)) {
				throw hookUnsupported(
					"setWidget",
					"widget",
					`widget "${key}" content must be a string array or undefined (got ${typeof content})`,
				);
			}
			const blocks: BrowserUiBlock[] = content.map((line, i) => {
				if (typeof line !== "string") {
					throw hookUnsupported(
						"setWidget",
						"widget",
						`widget "${key}" line #${i} must be a string (got ${typeof line})`,
					);
				}
				return { type: "text", text: line } as BrowserUiBlock;
			});
			send(`widget:${key}`, "widget", `Widget: ${key}`, blocks, options?.placement);
		},
		setFooter: (factory) => {
			if (factory !== undefined) {
				throw hookIsolation(
					"setFooter",
					"custom footers are component factories, which are executable code.",
				);
			}
			throw hookUnsupported("setFooter", "renderer", "terminal footer chrome is unavailable");
		},
		setHeader: (factory) => {
			if (factory !== undefined) {
				throw hookIsolation(
					"setHeader",
					"custom headers are component factories, which are executable code.",
				);
			}
			throw hookUnsupported("setHeader", "renderer", "terminal header chrome is unavailable");
		},
		setTitle: (title) => {
			throw hookUnsupported(
				"setTitle",
				"panel",
				`the browser tab title is user-controlled and has no per-session channel (got ${JSON.stringify(title)}); send panel status text instead`,
			);
		},
		custom: () =>
			Promise.reject(
				hookIsolation(
					"custom",
					"custom components are focused component factories, which are executable code.",
				),
			),
		setEditorText: (text) => {
			throw hookUnsupported(
				"setEditorText",
				"editor",
				`the browser has no shared composer channel (got ${text.length} chars); use the editor() dialog`,
			);
		},
		pasteToEditor: (text) => {
			throw hookUnsupported(
				"pasteToEditor",
				"editor",
				`the browser has no shared composer channel (got ${text.length} chars); use the editor() dialog`,
			);
		},
		getEditorText: () => {
			throw hookUnsupported(
				"getEditorText",
				"editor",
				"the browser composer is web-local and unreadable here; use the editor() dialog",
			);
		},
		addAutocompleteProvider: () => {
			throw hookUnsupported(
				"addAutocompleteProvider",
				"completion",
				"the browser has no completion-provider channel for extensions",
			);
		},
		setEditorComponent: (factory) => {
			if (factory === undefined)
				throw hookUnsupported(
					"setEditorComponent",
					"composer",
					"terminal editor chrome is unavailable",
				);
			throw hookIsolation(
				"setEditorComponent",
				"custom editors are component factories, which are executable code.",
			);
		},
		getAllThemes: () =>
			hookRejected(
				"getAllThemes",
				"renderer",
				"browser theming is a user setting, not an extension channel",
			),
		getTheme: () =>
			hookRejected(
				"getTheme",
				"renderer",
				"browser theming is a user setting, not an extension channel",
			),
		setTheme: () =>
			hookRejected(
				"setTheme",
				"renderer",
				"browser theming is a user setting, not an extension channel",
			),
		getToolsExpanded: () => {
			throw hookUnsupported(
				"getToolsExpanded",
				"panel",
				"tool-output expansion state is web-local and unreadable here",
			);
		},
		setToolsExpanded: (expanded) => {
			throw hookUnsupported(
				"setToolsExpanded",
				"panel",
				`tool-output expansion state is web-local (got ${expanded})`,
			);
		},
	};
}
