import { formatCompactTokens } from "./context";

/** Compact context-window label for model rows, e.g. "ctx 128k" / "ctx 1.2M". */
export function formatCtx(tokens: number | null | undefined): string | undefined {
	if (!tokens || tokens <= 0) return undefined;
	return `ctx ${formatCompactTokens(tokens, false)}`;
}
