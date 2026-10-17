import type { ModelBrowserEntry, ModelLockReason } from "#lib/wire/protocol";
import { fuzzyRank } from "../prompt/autocomplete";

/** The sentence shown for a locked row; the wire carries only the code. */
export function lockMessage(locked: ModelLockReason, provider: string): string {
	return locked === "disabled"
		? `Provider "${provider}" is disabled.`
		: `No credentials for ${provider}. Run /login.`;
}

/** Thinking selectors that may follow a model id as `:level` (SDK `resolveCliModel` grammar). */
const THINKING_SUFFIXES: Record<string, true> = {
	auto: true,
	inherit: true,
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

export interface RankedModel {
	model: ModelBrowserEntry;
	/** `provider/id`, the selector handed to switchModel / setTaskModel. */
	selector: string;
	/** Selector is in the recent list. */
	recent: boolean;
}

/**
 * Split a trailing `:level` off a selector. Only a known thinking level counts,
 * so ids that carry their own colon (ollama `qwen3:8b`) stay intact.
 */
export function splitSelectorThinking(selector: string): { selector: string; thinking?: string } {
	const at = selector.lastIndexOf(":");
	if (at <= 0) return { selector };
	const suffix = selector.slice(at + 1);
	if (!Object.hasOwn(THINKING_SUFFIXES, suffix)) return { selector };
	return { selector: selector.slice(0, at), thinking: suffix };
}

/** TUI label parity: `minimal` renders as `min`; every other selector is its own wire value. */
export function thinkingLabel(selector: string): string {
	return selector === "minimal" ? "min" : selector;
}

/** Position of `level` in the ordered selector list; `index` is -1 when absent. */
export function thinkingOrdinal(
	selectors: readonly string[],
	level: string | undefined,
): { index: number; count: number } {
	const index = level === undefined ? -1 : selectors.indexOf(level);
	return { index, count: selectors.length };
}

/**
 * Rank the browser list for the quick picker. Empty query: usable recent rows
 * first (recent order), then the rest in provider/id order. Query: fuzzy order
 * (best score first; the current model wins ties). Locked rows always follow
 * every usable row and keep their reason on the entry.
 */
export function rankModels(
	models: readonly ModelBrowserEntry[],
	query: string,
	recent: readonly string[],
	current?: string,
): RankedModel[] {
	const needle = splitSelectorThinking(query.trim()).selector;
	const rows: Array<RankedModel & { score: number }> = [];
	for (const model of models) {
		const selector = `${model.provider}/${model.id}`;
		let score = 0;
		if (needle !== "") {
			const bySelector = fuzzyRank(needle, selector);
			const byId = fuzzyRank(needle, model.id);
			if (bySelector === null && byId === null) continue;
			score = Math.min(bySelector ?? Infinity, byId ?? Infinity);
		}
		rows.push({ model, selector, recent: recent.includes(selector), score });
	}
	const recentRank = (selector: string): number => {
		const at = recent.indexOf(selector);
		return at < 0 ? Infinity : at;
	};
	rows.sort((a, b) => {
		const locked = Number(a.model.locked !== undefined) - Number(b.model.locked !== undefined);
		if (locked !== 0) return locked;
		if (needle === "") {
			const byRecent = recentRank(a.selector) - recentRank(b.selector);
			if (Number.isFinite(byRecent) && byRecent !== 0) return byRecent;
			if (a.recent !== b.recent) return a.recent ? -1 : 1;
		} else {
			if (a.score !== b.score) return a.score - b.score;
			if (current !== undefined && a.selector !== b.selector) {
				if (a.selector === current) return -1;
				if (b.selector === current) return 1;
			}
		}
		return a.selector.localeCompare(b.selector);
	});
	return rows.map(({ model, selector, recent: isRecent }) => ({
		model,
		selector,
		recent: isRecent,
	}));
}
