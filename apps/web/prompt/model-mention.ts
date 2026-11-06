/**
 * `^` model mention completion, ported from the SDK editor
 * (pi-tui prompt/model-mention-autocomplete.ts): `^` lists models, and after
 * `^provider/model:` the efforts that model supports. Pure: the caller hands
 * in the browser catalog (`getModelBrowser`, which carries each model's
 * SDK-derived `thinkingEfforts` and the `scoped` marker of the session's model scope) and the recent list.
 */
import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { formatCtx } from "../usage/model-options";
import { rankModels } from "../usage/model-search";

const MAX_MODEL_MENTION_SUGGESTIONS = 20;
const MAX_EFFORT_CANDIDATE_MODELS = 3;

export interface ModelMentionRow {
	/** Canonical selector inserted after `^`: `provider/id`, plus `:effort` for a level row. */
	value: string;
	/** Context window for a model row; `id · effort` for a level row. */
	detail?: string;
}

/**
 * Model rows for the text after `^`. Provider model ids may contain a colon or
 * end in a level name (`qwen3:8b`, `glm-4.7:max`), so literal selector matches
 * come before level rows, and a level row that names an available model is
 * dropped in favour of that model's own row.
 */
export function modelMentionRows(
	query: string,
	models: readonly ModelBrowserEntry[],
	recent: readonly string[],
): ModelMentionRow[] {
	// Chat models the session can use; roles-only kinds (search, tts) and locked rows cannot take a subagent.
	const usable = models.filter((model) => model.locked === undefined);
	const chat = usable.filter((model) => model.kind === "chat");
	// Like the SDK, a session model scope narrows the list; none marked = every usable chat model.
	const pool = models.some((model) => model.scoped) ? chat.filter((model) => model.scoped) : chat;
	const candidates = (text: string) => rankModels(pool, text, recent);
	const modelRow = ({ model, selector }: { model: ModelBrowserEntry; selector: string }) => ({
		value: selector,
		detail: formatCtx(model.contextWindow),
	});

	const colon = query.lastIndexOf(":");
	if (colon > 0) {
		const typed = query.slice(colon + 1).toLowerCase();
		const levelRows: ModelMentionRow[] = [];
		for (const { selector, model } of candidates(query.slice(0, colon)).slice(
			0,
			MAX_EFFORT_CANDIDATE_MODELS,
		)) {
			for (const effort of model.thinkingEfforts ?? []) {
				if (!effort.startsWith(typed)) continue;
				levelRows.push({ value: `${selector}:${effort}`, detail: `${model.id} · ${effort}` });
			}
		}
		if (levelRows.length > 0) {
			const lowered = query.toLowerCase();
			const literalRows: ModelMentionRow[] = [];
			for (const row of candidates(query)) {
				if (literalRows.length === MAX_MODEL_MENTION_SUGGESTIONS) break;
				if (row.selector.toLowerCase().includes(lowered)) literalRows.push(modelRow(row));
			}
			const literalValues = new Set(literalRows.map((row) => row.value));
			const available = new Set(usable.map((model) => `${model.provider}/${model.id}`));
			return [
				...literalRows,
				...levelRows.filter((row) => !literalValues.has(row.value) && !available.has(row.value)),
			].slice(0, MAX_MODEL_MENTION_SUGGESTIONS);
		}
	}
	return candidates(query).slice(0, MAX_MODEL_MENTION_SUGGESTIONS).map(modelRow);
}
