import { call, pushNotice, setState, state } from "../state";

/** Temporary effective model, persisted presets, and read-only branch-local
 * mention mirrors. Optional operations require advertised capabilities. */
export interface ModelPreset {
	name: string;
	modelRoles: Record<string, string>;
	defaultThinkingLevel?: string;
}

export interface ModelMention {
	agent: string;
	selector: string;
	name: string;
}

/** `^selector` tokens in composer text (shared TUI regex semantics). */
export const MODEL_MENTION_RE = /(^|\s)\^([^\s^]+)(?=\s|$)/g;

function requireModelCapability(key: "temporaryModel" | "modelPresets" | "modelMentions"): void {
	const capability = state.capabilities?.[key];
	if (capability?.available !== true) {
		throw new Error(capability?.reason ?? `${key} is unavailable on this server.`);
	}
}

/**
 * Argument-aware `/model` routing (P0 owns the authoritative command table;
 * this is the P2 semantic helper it can call). Bare `/model` keeps the role
 * wizard; anything else resolves as an explicit selector or subcommand and
 * NEVER falls through to accidental agent input.
 */
export type ModelRoute =
	| { kind: "wizard" }
	| { kind: "temp"; selector: string; thinking?: string }
	| { kind: "cycle"; backward: boolean }
	| { kind: "preset"; action: "list" | "save" | "apply" | "delete"; name?: string }
	| { kind: "error"; message: string };

export function modelRoute(args: string): ModelRoute {
	const text = args.trim();
	if (!text) return { kind: "wizard" };
	const [head, ...rest] = text.split(/\s+/);
	const tail = rest.join(" ").trim();
	const lower = head.toLowerCase();
	if (lower === "cycle" || lower === "next" || lower === "prev" || lower === "previous") {
		return { kind: "cycle", backward: lower === "prev" || lower === "previous" };
	}
	if (lower === "preset" || lower === "presets") {
		const [action, name] = rest;
		const a = (action ?? "list").toLowerCase();
		if (a === "list") return { kind: "preset", action: "list" };
		if (a === "save" || a === "apply" || a === "delete") {
			if (!name) return { kind: "error", message: `Usage: /model preset ${a} <name>` };
			if (!/^[a-zA-Z][\w-]*$/.test(name)) {
				return {
					kind: "error",
					message: `Invalid preset name "${name}": letter, then letters/digits/-/_`,
				};
			}
			return { kind: "preset", action: a, name };
		}
		return { kind: "error", message: "Usage: /model preset <list|save|apply|delete> [name]" };
	}
	if (lower === "temp" || lower === "temporary" || lower === "use") {
		if (!tail) return { kind: "error", message: "Usage: /model temp <provider/model[:thinking]>" };
		const { selector, thinking } = splitThinking(tail);
		if (!selector.includes("/")) {
			return {
				kind: "error",
				message: `Bad model selector "${tail}": want provider/model[:thinking]`,
			};
		}
		return { kind: "temp", selector, ...(thinking ? { thinking } : {}) };
	}
	// Bare selector: provider/model[:thinking] is a temporary switch, NOT a
	// persisted role edit. Anything else is a precise error, never agent input.
	if (text.includes("/")) {
		const { selector, thinking } = splitThinking(text);
		if (selector.includes("/"))
			return { kind: "temp", selector, ...(thinking ? { thinking } : {}) };
	}
	return {
		kind: "error",
		message: `Usage: /model [provider/model[:thinking] | temp <selector> | cycle | preset <list|save|apply|delete>]`,
	};
}

function splitThinking(selector: string): { selector: string; thinking?: string } {
	const idx = selector.lastIndexOf(":");
	if (idx <= 0) return { selector };
	return { selector: selector.slice(0, idx), thinking: selector.slice(idx + 1) };
}

/** Run a parsed /model route. Wizard/cycle/preset errors surface as
 *  notices; temp failures name entitlement/effort-clamp causes. */
export async function runModelRoute(route: ModelRoute): Promise<void> {
	switch (route.kind) {
		case "wizard":
			setState("modal", "model");
			return;
		case "cycle":
			await cycleModel(route.backward);
			return;
		case "temp":
			await setTemporaryModel(route.selector, route.thinking);
			return;
		case "preset":
			await runPresetRoute(route.action, route.name);
			return;
		case "error":
			pushNotice("error", route.message);
			return;
	}
}

/**
 * Temporary switch: session-only, never writes settings or role values.
 * Shows effort-clamp feedback when the server reports the level was clamped.
 */
export async function setTemporaryModel(selector: string, thinking?: string): Promise<void> {
	requireModelCapability("temporaryModel");
	const slash = selector.indexOf("/");
	if (slash <= 0)
		throw new Error(`Bad model selector "${selector}": want provider/model[:thinking]`);
	const provider = selector.slice(0, slash);
	const id = selector.slice(slash + 1);
	if (!provider || !id)
		throw new Error(`Bad model selector "${selector}": want provider/model[:thinking]`);
	try {
		const data = (await call("setModelTemporary", [
			provider,
			id,
			...(thinking ? [thinking] : []),
		])) as { provider: string; id: string; clampedThinking?: string };
		pushNotice(
			"info",
			`Temporary model: ${data.provider}/${data.id}${data.clampedThinking ? ` (effort clamped to ${data.clampedThinking})` : ""} — roles unchanged`,
		);
		return;
	} catch (err) {
		pushNotice(
			"error",
			`Temporary switch failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		throw err;
	}
}

/** Cycle the scoped/available model set (temporary, like the TUI): never
 *  rewrites persisted roles. */
export async function cycleModel(backward = false): Promise<void> {
	requireModelCapability("temporaryModel");
	const data = (await call("cycleModel", backward ? ["backward"] : [])) as {
		model?: { provider: string; id: string };
		isScoped?: boolean;
	} | null;
	if (!data?.model) {
		pushNotice("info", "Only one model available; nothing to cycle.");
		return;
	}
	pushNotice(
		"info",
		`Model: ${data.model.provider}/${data.model.id}${data.isScoped ? " (scoped)" : ""}`,
	);
}

async function runPresetRoute(
	action: "list" | "save" | "apply" | "delete",
	name?: string,
): Promise<void> {
	requireModelCapability("modelPresets");
	try {
		if (action === "list") {
			const data = (await call("getModelPresets", [])) as {
				names: string[];
				active?: string;
			};
			const names = data.names;
			pushNotice(
				"info",
				names.length === 0
					? "No saved model presets."
					: `Presets: ${names.map((n) => (n === data.active ? `${n} (active)` : n)).join(", ")}`,
			);
			return;
		}
		if (!name) {
			pushNotice("error", `Usage: /model preset ${action} <name>`);
			return;
		}
		if (action === "save") {
			const data = (await call("saveModelPreset", [name])) as { message: string };
			pushNotice("info", data.message);
			return;
		}
		if (action === "apply") {
			const data = (await call("applyModelPreset", [name])) as {
				applied: string;
				warnings: string[];
			};
			pushNotice(
				data.warnings.length ? "warning" : "info",
				`Applied preset "${data.applied}"${data.warnings.length ? `: ${data.warnings.join("; ")}` : ""}.`,
			);
			return;
		}
		const data = (await call("deleteModelPreset", [name])) as {
			result: "deleted" | "project" | "missing";
		};
		if (data.result === "missing") pushNotice("warning", `No preset named "${name}".`);
		else if (data.result === "project") {
			pushNotice("warning", `Preset "${name}" lives in a project/overlay config; remove it there.`);
		} else pushNotice("info", `Deleted preset "${name}".`);
	} catch (err) {
		pushNotice(
			"error",
			`Preset ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		throw err;
	}
}

// --- Model-worker chips (branch-local pseudonyms) ---

let mentionCache: ModelMention[] | null = null;
let mentionCacheGen = -1;

/** Branch-local mentions, restored on resume/rewind from the journal
 *  (server-owned; the browser only mirrors). A chip is the REQUESTED
 *  delegation target, never proof a worker launched. Pass the graph
 *  generation when known so resume/rewind invalidates the mirror; -1
 *  bypasses the generation check. */
export async function getModelMentions(graphGen = -1): Promise<ModelMention[]> {
	requireModelCapability("modelMentions");
	if (mentionCache && (graphGen < 0 || mentionCacheGen === graphGen)) return mentionCache;
	const data = (await call("getModelMentions", [])) as { mentions: ModelMention[] };
	mentionCache = data.mentions;
	mentionCacheGen = graphGen;
	return mentionCache;
}

/** Forget the mirror after branch/resume/rewind; the next read restores. */
export function invalidateMentions(): void {
	mentionCache = null;
	mentionCacheGen = -1;
}

/** SDK prompt handling expands and journals `^selector` tokens using its
 * private registry. Keep text literal until submit: allocating aliases in the
 * browser would desynchronize that registry and falsely imply persistence. */
export async function expandMentionChips(
	text: string,
): Promise<{ text: string; mentions: ModelMention[] }> {
	if (state.capabilities?.modelMentions?.available !== true) {
		return { text, mentions: [] };
	}
	return { text, mentions: await getModelMentions() };
}

/** Restore `<model agent="mN">` tags to editable `^selector` chips using
 *  the branch-local mapping; unknown agents stay literal. */
export function expandTagsForEdit(text: string, mentions: ModelMention[]): string {
	return text.replace(/<model agent="(m\d+)" name="([^"]*)"\/>/g, (tag: string, agent: string) => {
		const m = mentions.find((x) => x.agent === agent);
		return m ? `^${m.selector}` : tag;
	});
}
