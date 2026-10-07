// Pure browser UI boundary contract, shared by the host and browser renderer.
/** The single ui_request method carrying browser contributions (keeps the wire minimal). */
export const BROWSER_UI_METHOD = "browser_ui";

/** Contribution schema version. Contributions must pin exactly this version. */
export const BROWSER_UI_VERSION = 1;

/**
 * Upper bound on the serialized contribution JSON, in bytes. Oversize
 * contributions are rejected outright, never silently truncated.
 */
export const MAX_BROWSER_UI_PAYLOAD_BYTES = 64 * 1024;

/** Migration pointer embedded in every unsupported/isolation diagnostic: the contract module itself. */
export const BROWSER_UI_DOC = "lib/wire/browser-ui-contract.ts";

/** The eight browser-host capability slots. */
export type BrowserUiCapability =
	| "dialogs"
	| "editor"
	| "widget"
	| "actions"
	| "panel"
	| "renderer"
	| "composer"
	| "completion";

const CAPABILITY_NAMES: readonly BrowserUiCapability[] = [
	"dialogs",
	"editor",
	"widget",
	"actions",
	"panel",
	"renderer",
	"composer",
	"completion",
];

/** Availability of one capability slot. */
export interface Capability {
	available: boolean;
	reason?: string;
}

const CAPABILITIES: Record<BrowserUiCapability, Capability> = {
	dialogs: { available: true },
	widget: { available: true },
	actions: { available: true },
	panel: { available: true },
	renderer: {
		available: false,
		reason:
			"custom components ship executable code, which requires an isolation contract the browser host does not provide; contribute declarative text/code/list/actions blocks instead",
	},
	editor: {
		available: false,
		reason:
			"the browser has no shared composer channel readable/writable by extensions; use the editor() dialog",
	},
	composer: {
		available: false,
		reason:
			"the browser composer is web-local; extensions cannot replace it (custom editors are executable code)",
	},
	completion: {
		available: false,
		reason: "the browser has no completion-provider channel for extensions",
	},
};

export interface BrowserUiCapabilitiesSnapshot {
	version: number;
	maxPayloadBytes: number;
	capabilities: Record<BrowserUiCapability, Capability>;
}

/** Capability gate for the browser host. Returns fresh copies (callers cannot mutate the table). */
export function getBrowserUiCapabilities(): BrowserUiCapabilitiesSnapshot {
	const capabilities = {} as Record<BrowserUiCapability, Capability>;
	for (const name of CAPABILITY_NAMES) capabilities[name] = { ...CAPABILITIES[name] };
	return {
		version: BROWSER_UI_VERSION,
		maxPayloadBytes: MAX_BROWSER_UI_PAYLOAD_BYTES,
		capabilities,
	};
}

/** Type guard for the closed capability union (undeclared strings fail). */
export function isBrowserUiCapability(value: unknown): value is BrowserUiCapability {
	return typeof value === "string" && (CAPABILITY_NAMES as readonly string[]).includes(value);
}

/** Throw unless the capability slot is declared and available. */
export function assertCapabilityAvailable(kind: BrowserUiCapability): void {
	const capability = CAPABILITIES[kind];
	if (!capability) {
		throw new Error(
			`browser UI capability ${JSON.stringify(kind)} is not a declared capability ` +
				`(declared: ${CAPABILITY_NAMES.join(", ")}). Undeclared capabilities are explicitly unsupported ` +
				`(see ${BROWSER_UI_DOC}).`,
		);
	}
	if (!capability.available) {
		throw new Error(
			`browser UI capability "${kind}" is not available in the web host: ${capability.reason} ` +
				`(see ${BROWSER_UI_DOC}).`,
		);
	}
}

// ---------------------------------------------------------------------------
// Declarative payload: allowlisted blocks, string fields with length caps.
// ---------------------------------------------------------------------------

/** Allowlisted declarative blocks. Anything else renders nothing and is rejected here. */
export type BrowserUiBlock =
	| { type: "text"; text: string; markdown?: boolean }
	| { type: "code"; code: string; language?: string }
	| { type: "list"; items: string[]; ordered?: boolean }
	| { type: "actions"; actions: Array<{ id: string; label: string }> };

export interface BrowserUiPayload {
	blocks: BrowserUiBlock[];
	placement?: "aboveEditor" | "belowEditor" | "modal";
}

/** Versioned, owner-scoped contribution. Identity is (owner, id): stable IDs only. */
export interface BrowserUiContribution {
	id: string;
	kind: BrowserUiCapability;
	owner: string;
	title: string;
	payload: BrowserUiPayload;
	version: number;
}

const MAX_ID_CHARS = 128;
const MAX_TITLE_CHARS = 512;
const MAX_BLOCKS = 64;
const MAX_TEXT_CHARS = 16 * 1024;
const MAX_CODE_CHARS = 32 * 1024;
const MAX_LANGUAGE_CHARS = 64;
const MAX_LIST_ITEMS = 512;
const MAX_LIST_ITEM_CHARS = 2048;
const MAX_ACTIONS = 32;
const MAX_ACTION_ID_CHARS = 256;
const MAX_ACTION_LABEL_CHARS = 256;

// Keys that smuggle executable or raw-markup content. Any occurrence rejects
// the whole contribution with the isolation error (never a silent drop).
// Static table, so a Record (not a Set).
const EXECUTABLE_KEYS: Record<string, true> = {
	html: true,
	raw: true,
	eval: true,
	factory: true,
	component: true,
	render: true,
	script: true,
	iframe: true,
	embed: true,
	object: true,
	dangerouslySetInnerHTML: true,
	__html: true,
	javascript: true,
	function: true,
};

function isolationError(where: string, detail: string): Error {
	return new Error(
		`browser_ui ${where} rejected: ${detail} ` +
			`Executable extension code requires an isolation contract the browser host does not provide; ` +
			`contribute declarative text/code/list/actions blocks instead (see ${BROWSER_UI_DOC} § trust and isolation).`,
	);
}

/** Classify a non-allowlisted key: executable (isolation error), unsafe, or merely unknown. */
function unknownKeyError(where: string, key: string, value: unknown): Error {
	if (typeof value === "function" || EXECUTABLE_KEYS[key] === true || /^on[A-Z]/.test(key)) {
		return isolationError(where, `key "${key}" carries executable code.`);
	}
	if (key === "__proto__" || key === "constructor" || key === "prototype") {
		return new Error(`browser_ui ${where} rejected: key "${key}" is never allowed.`);
	}
	return new Error(
		`browser_ui ${where} rejected: unknown key "${key}". ` +
			`Allowlisted keys only (see ${BROWSER_UI_DOC}); unknown/html/raw/eval payloads are never rendered.`,
	);
}

function checkString(value: unknown, what: string, max: number, allowEmpty: boolean): string {
	if (typeof value === "function") throw isolationError(what, `value is executable code.`);
	if (typeof value !== "string") {
		throw new Error(`browser_ui ${what} must be a string, got ${typeof value}.`);
	}
	if (!allowEmpty && value.length === 0) {
		throw new Error(`browser_ui ${what} must be a non-empty string.`);
	}
	if (value.length > max) {
		throw new Error(`browser_ui ${what} exceeds ${max} characters (got ${value.length}).`);
	}
	return value;
}

function checkOptionalBoolean(value: unknown, what: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "function") throw isolationError(what, `value is executable code.`);
	if (typeof value !== "boolean")
		throw new Error(`browser_ui ${what} must be a boolean, got ${typeof value}.`);
	return value;
}

function validateBlock(raw: unknown, index: number): BrowserUiBlock {
	const where = `block #${index}`;
	if (typeof raw === "function") throw isolationError(where, "block is executable code.");
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`browser_ui ${where} must be an object with a "type" field.`);
	}
	const block = raw as Record<string, unknown>;
	const type = block.type;
	if (typeof type !== "string") {
		throw new Error(
			`browser_ui ${where} must declare type "text", "code", "list", or "actions" (got ${typeof type}).`,
		);
	}
	if (type !== "text" && type !== "code" && type !== "list" && type !== "actions") {
		if (EXECUTABLE_KEYS[type] === true) {
			throw isolationError(where, `block type "${type}" is executable/raw markup.`);
		}
		throw new Error(
			`browser_ui ${where} has unsupported type ${JSON.stringify(type)}: ` +
				`allowlisted types are text, code, list, actions (see ${BROWSER_UI_DOC}).`,
		);
	}
	switch (type) {
		case "text": {
			for (const key of Object.keys(block)) {
				if (key !== "type" && key !== "text" && key !== "markdown") {
					throw unknownKeyError(where, key, block[key]);
				}
			}
			const text = checkString(block.text, `${where} "text"`, MAX_TEXT_CHARS, true);
			const markdown = checkOptionalBoolean(block.markdown, `${where} "markdown"`);
			return markdown === undefined ? { type: "text", text } : { type: "text", text, markdown };
		}
		case "code": {
			for (const key of Object.keys(block)) {
				if (key !== "type" && key !== "code" && key !== "language") {
					throw unknownKeyError(where, key, block[key]);
				}
			}
			const code = checkString(block.code, `${where} "code"`, MAX_CODE_CHARS, true);
			const language =
				block.language === undefined
					? undefined
					: checkString(block.language, `${where} "language"`, MAX_LANGUAGE_CHARS, false);
			return language === undefined ? { type: "code", code } : { type: "code", code, language };
		}
		case "list": {
			for (const key of Object.keys(block)) {
				if (key !== "type" && key !== "items" && key !== "ordered") {
					throw unknownKeyError(where, key, block[key]);
				}
			}
			if (typeof block.items === "function") {
				throw isolationError(where, '"items" is executable code.');
			}
			if (!Array.isArray(block.items)) {
				throw new Error(`browser_ui ${where} "items" must be an array of strings.`);
			}
			if (block.items.length > MAX_LIST_ITEMS) {
				throw new Error(
					`browser_ui ${where} "items" exceeds ${MAX_LIST_ITEMS} entries (got ${block.items.length}).`,
				);
			}
			const items = block.items.map((item, i) =>
				checkString(item, `${where} item #${i}`, MAX_LIST_ITEM_CHARS, true),
			);
			const ordered = checkOptionalBoolean(block.ordered, `${where} "ordered"`);
			return ordered === undefined ? { type: "list", items } : { type: "list", items, ordered };
		}
		case "actions": {
			for (const key of Object.keys(block)) {
				if (key !== "type" && key !== "actions") {
					throw unknownKeyError(where, key, block[key]);
				}
			}
			if (typeof block.actions === "function") {
				throw isolationError(where, '"actions" is executable code.');
			}
			if (!Array.isArray(block.actions)) {
				throw new Error(`browser_ui ${where} "actions" must be an array of { id, label }.`);
			}
			if (block.actions.length === 0) {
				throw new Error(`browser_ui ${where} "actions" must list at least one action.`);
			}
			if (block.actions.length > MAX_ACTIONS) {
				throw new Error(
					`browser_ui ${where} "actions" exceeds ${MAX_ACTIONS} entries (got ${block.actions.length}).`,
				);
			}
			const actions = block.actions.map((entry, i) => {
				if (typeof entry === "function") {
					throw isolationError(where, `action #${i} is executable code.`);
				}
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
					throw new Error(
						`browser_ui ${where} action #${i} must be an object with string id and label.`,
					);
				}
				const action = entry as Record<string, unknown>;
				for (const key of Object.keys(action)) {
					if (key !== "id" && key !== "label") {
						throw unknownKeyError(`${where} action #${i}`, key, action[key]);
					}
				}
				return {
					id: checkString(action.id, `${where} action #${i} "id"`, MAX_ACTION_ID_CHARS, false),
					label: checkString(
						action.label,
						`${where} action #${i} "label"`,
						MAX_ACTION_LABEL_CHARS,
						false,
					),
				};
			});
			return { type: "actions", actions };
		}
	}
}

/**
 * Validate an untrusted contribution into a normalized copy (allowlisted keys
 * only). Throws explicit errors for malformed, oversize, unknown-capability,
 * or executable payloads. The returned object is frozen: post-validation
 * mutation cannot widen what was checked.
 */
export function validateBrowserUiContribution(input: unknown): BrowserUiContribution {
	if (typeof input === "function") {
		throw isolationError("contribution", "contribution is executable code.");
	}
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error(
			"browser_ui contribution must be an object { id, kind, owner, title, payload, version }.",
		);
	}
	const contribution = input as Record<string, unknown>;
	for (const key of Object.keys(contribution)) {
		if (
			key !== "id" &&
			key !== "kind" &&
			key !== "owner" &&
			key !== "title" &&
			key !== "payload" &&
			key !== "version"
		) {
			throw unknownKeyError("contribution", key, contribution[key]);
		}
	}
	const id = checkString(contribution.id, 'contribution "id"', MAX_ID_CHARS, false);
	const kind = contribution.kind;
	if (!isBrowserUiCapability(kind)) {
		throw new Error(
			`browser UI capability ${JSON.stringify(kind)} is not a declared capability ` +
				`(declared: ${CAPABILITY_NAMES.join(", ")}). Undeclared capabilities are explicitly unsupported ` +
				`(see ${BROWSER_UI_DOC}).`,
		);
	}
	const owner = checkString(contribution.owner, 'contribution "owner"', MAX_ID_CHARS, false);
	const title = checkString(contribution.title, 'contribution "title"', MAX_TITLE_CHARS, true);
	if (typeof contribution.version !== "number" || !Number.isInteger(contribution.version)) {
		throw new Error('browser_ui contribution "version" must be an integer.');
	}
	if (contribution.version !== BROWSER_UI_VERSION) {
		throw new Error(
			`unsupported browser_ui version ${contribution.version}: this host speaks version ${BROWSER_UI_VERSION} ` +
				`(see ${BROWSER_UI_DOC}).`,
		);
	}
	if (typeof contribution.payload === "function")
		throw isolationError("payload", "payload is executable code.");
	if (
		typeof contribution.payload !== "object" ||
		contribution.payload === null ||
		Array.isArray(contribution.payload)
	) {
		throw new Error('browser_ui contribution "payload" must be an object { blocks, placement? }.');
	}
	const payload = contribution.payload as Record<string, unknown>;
	for (const key of Object.keys(payload)) {
		if (key !== "blocks" && key !== "placement") {
			throw unknownKeyError("payload", key, payload[key]);
		}
	}
	if (typeof payload.blocks === "function")
		throw isolationError("payload", "blocks are executable code.");
	if (!Array.isArray(payload.blocks)) {
		throw new Error('browser_ui contribution payload "blocks" must be an array.');
	}
	if (payload.blocks.length === 0 || payload.blocks.length > MAX_BLOCKS) {
		throw new Error(
			`browser_ui contribution payload "blocks" must hold 1..${MAX_BLOCKS} blocks ` +
				`(got ${payload.blocks.length}).`,
		);
	}
	const blocks = payload.blocks.map((block, i) => validateBlock(block, i));
	const actionIds = new Set<string>();
	for (const block of blocks) {
		if (block.type === "list") Object.freeze(block.items);
		if (block.type === "actions") {
			for (const action of block.actions) {
				if (actionIds.has(action.id))
					throw new Error(`browser_ui duplicate action id "${action.id}".`);
				actionIds.add(action.id);
				Object.freeze(action);
			}
			Object.freeze(block.actions);
		}
		Object.freeze(block);
	}
	let placement: BrowserUiPayload["placement"];
	if (payload.placement !== undefined) {
		const p = payload.placement;
		if (p !== "aboveEditor" && p !== "belowEditor" && p !== "modal") {
			throw new Error(
				`browser_ui contribution payload "placement" must be "aboveEditor", "belowEditor", or "modal" ` +
					`(got ${JSON.stringify(p)}).`,
			);
		}
		placement = p;
	}
	const normalized: BrowserUiContribution = {
		id,
		kind,
		owner,
		title,
		payload: placement === undefined ? { blocks } : { blocks, placement },
		version: BROWSER_UI_VERSION,
	};
	const bytes = new TextEncoder().encode(JSON.stringify(normalized)).length;
	if (bytes > MAX_BROWSER_UI_PAYLOAD_BYTES) {
		throw new Error(
			`browser_ui contribution "${id}" exceeds ${MAX_BROWSER_UI_PAYLOAD_BYTES} bytes serialized ` +
				`(got ${bytes}): split it into smaller contributions; oversize payloads are rejected, never truncated.`,
		);
	}
	Object.freeze(normalized.payload.blocks);
	Object.freeze(normalized.payload);
	Object.freeze(normalized);
	return normalized;
}

/** Validate + capability-gate a contribution, returning the well-formed params object. */
export function buildBrowserUiParams(input: unknown): BrowserUiContribution {
	const contribution = validateBrowserUiContribution(input);
	assertCapabilityAvailable(contribution.kind);
	return contribution;
}
