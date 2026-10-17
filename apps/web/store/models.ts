import { createSignal } from "solid-js";
import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { call, pushNotice, setState, state } from "../state";

/** Persisted model preset (`config.yml` `modelPresets`). */
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

/** Session-only model switching, Task model override, presets, thinking
 * picks and Settings > Model role writes. Every action reports its outcome
 * as a transcript notice; failures carry the server's real error text. */

const RECENT_KEY = "omp-web.recentModels";
const RECENT_MAX = 8;

function readRecent(): string[] {
	try {
		const raw = globalThis.localStorage?.getItem(RECENT_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? parsed.filter((s): s is string => typeof s === "string").slice(0, RECENT_MAX)
			: [];
	} catch {
		// Corrupt or unavailable storage: start with no recents.
		return [];
	}
}

const [recent, setRecent] = createSignal<string[]>(readRecent());
/** Recently switched-to `provider/id` selectors, most recent first. */
export const recentModels = recent;

/** Replace the recents list (design-system stories seed it). */
export function seedRecentModels(selectors: string[]): void {
	setRecent(selectors.slice(0, RECENT_MAX));
}

function recordRecentModel(selector: string): void {
	const next = [selector, ...recent().filter((s) => s !== selector)].slice(0, RECENT_MAX);
	setRecent(next);
	try {
		globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// Storage full or disabled: recents survive this page load only.
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Open the quick model picker; `task` starts it in Task-model mode. */
export function openModelPicker(task = false): void {
	setState({ modelPickerTask: task, modal: "model" });
	void loadModelBrowser();
}

export function closeModelPicker(): void {
	setState("modal", null);
}

export async function loadModelBrowser(): Promise<void> {
	try {
		const models = (await call("getModelBrowser", [])) as ModelBrowserEntry[];
		setState("modelBrowser", models);
	} catch (err) {
		setState("modelBrowser", []);
		pushNotice("error", `Could not load models: ${errorText(err)}`);
	}
}

/** Session-only switch to a fuzzy selector (`:level` suffix allowed). Roles
 * and persisted settings are untouched. */
export async function switchSessionModel(selector: string): Promise<boolean> {
	try {
		const data = (await call("switchModel", [selector])) as {
			provider: string;
			id: string;
			thinkingLevel?: string;
		};
		const label = `${data.provider}/${data.id}`;
		recordRecentModel(label);
		pushNotice(
			"info",
			`Session-only model: ${label}${data.thinkingLevel ? ` (thinking ${data.thinkingLevel})` : ""}. Roles unchanged.`,
		);
		return true;
	} catch (err) {
		pushNotice("error", `Model switch failed: ${errorText(err)}`);
		return false;
	}
}

/** Session-only Task subagent model override. */
export async function pickTaskModel(selector: string): Promise<boolean> {
	try {
		await call("setTaskModel", [selector]);
		recordRecentModel(selector);
		pushNotice("info", `Task subagent model (session-only): ${selector}. Roles unchanged.`);
		return true;
	} catch (err) {
		pushNotice("error", `Task model failed: ${errorText(err)}`);
		return false;
	}
}

export async function clearTaskModel(): Promise<boolean> {
	try {
		await call("setTaskModel", [null]);
		pushNotice("info", "Task subagent model cleared; Task inherits the session model.");
		return true;
	} catch (err) {
		pushNotice("error", `Task model failed: ${errorText(err)}`);
		return false;
	}
}

export async function applyModelPreset(name: string): Promise<boolean> {
	try {
		const data = (await call("applyModelPreset", [name])) as {
			applied: string;
			warnings: string[];
		};
		pushNotice(
			data.warnings.length ? "warning" : "info",
			`Applied preset "${data.applied}"${data.warnings.length ? `: ${data.warnings.join("; ")}` : ""}.`,
		);
		return true;
	} catch (err) {
		pushNotice("error", `Preset apply failed: ${errorText(err)}`);
		return false;
	}
}

/** Step to the next (or previous) configured preset after the active one. */
export async function cycleModelPreset(backward = false): Promise<boolean> {
	const names = state.modelPresets?.names ?? [];
	if (names.length === 0) {
		pushNotice("info", "No model presets configured.");
		return false;
	}
	const active = state.modelPresets?.active;
	const at = active ? names.indexOf(active) : -1;
	const next =
		at < 0
			? names[backward ? names.length - 1 : 0]
			: names[(at + (backward ? -1 : 1) + names.length) % names.length];
	return applyModelPreset(next ?? names[0]);
}

export type ModelPresetAction = "list" | "save" | "apply" | "delete";

/** `/modelpreset [list|save|apply|delete] [name]`: every outcome is a notice. */
export async function runModelPresetCommand(
	action: ModelPresetAction,
	name?: string,
): Promise<void> {
	try {
		if (action === "list") {
			const data = (await call("getModelPresets", [])) as { names: string[]; active?: string };
			pushNotice(
				"info",
				data.names.length === 0
					? "No saved model presets."
					: `Presets: ${data.names.map((n) => (n === data.active ? `${n} (active)` : n)).join(", ")}`,
			);
			return;
		}
		if (!name) {
			pushNotice("error", `Usage: /modelpreset ${action} <name>`);
			return;
		}
		if (action === "save") {
			const data = (await call("saveModelPreset", [name])) as { message: string };
			pushNotice("info", data.message);
			return;
		}
		if (action === "apply") {
			await applyModelPreset(name);
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
		pushNotice("error", `Preset ${action} failed: ${errorText(err)}`);
	}
}

export function openThinkingPicker(): void {
	setState("modal", "thinking");
}

export function closeThinkingPicker(): void {
	setState("modal", null);
}

/** Set the session thinking level. The server rejects unsupported levels;
 * nothing is clamped silently. */
export async function setThinkingSelector(level: string): Promise<boolean> {
	try {
		await call("setThinkingLevel", [level]);
		pushNotice("info", `Thinking: ${level}.`);
		return true;
	} catch (err) {
		pushNotice("error", `Thinking change failed: ${errorText(err)}`);
		return false;
	}
}

/** `/model` bare: open Settings on the Model tab (the role editor). */
export function openModelSettings(): void {
	setState({ settingsTab: "model", modal: "settings" });
}

/** Read and clear the Settings tab requested by `openModelSettings`. */
export function consumeSettingsTab(): string | null {
	const tab = state.settingsTab;
	if (tab !== null) setState("settingsTab", null);
	return tab;
}

/** Persist (or clear, when `selector` is undefined) a model role in config.yml. */
export async function setModelRoleAssignment(
	role: string,
	selector: string | undefined,
	thinking?: string,
): Promise<boolean> {
	try {
		if (selector === undefined) {
			await call("clearModelRole", [role]);
			pushNotice("info", `Model role ${role} cleared.`);
			return true;
		}
		const slash = selector.indexOf("/");
		if (slash <= 0 || slash === selector.length - 1) {
			throw new Error(`Bad model selector "${selector}": want provider/model`);
		}
		await call("setModelRole", [
			role,
			selector.slice(0, slash),
			selector.slice(slash + 1),
			...(thinking ? [thinking] : []),
		]);
		pushNotice("info", `Model role ${role} set to ${selector}${thinking ? `:${thinking}` : ""}.`);
		return true;
	} catch (err) {
		pushNotice("error", `Model role ${role} failed: ${errorText(err)}`);
		return false;
	}
}

export async function setModelRoleHidden(role: string, hidden: boolean): Promise<boolean> {
	try {
		await call("setModelRoleHidden", [role, hidden]);
		return true;
	} catch (err) {
		pushNotice("error", `Model role ${role} failed: ${errorText(err)}`);
		return false;
	}
}
