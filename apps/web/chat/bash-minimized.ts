import { isRecord } from "#lib/wire/type-guards";

/**
 * Bash output the SDK's minimizer rewrote: the call's `details.meta.minimized` names the filter that
 * ran and the bytes before and after (`MinimizedMeta`, pi-tui `tools/output-meta.ts`). The card
 * shows what the TUI shows (`formatMinimizedMeta`): `git 120.4KB → 3.2KB`. Pure, so the rules test
 * without a DOM.
 */

/** Widest filter label, in characters (the TUI's `TRUNCATE_LENGTHS.SHORT`). */
const LABEL_MAX = 40;

// CSI sequences first (the escape is a control character, so the class matches it without a literal control byte), so their parameters do not outlive the stripped escape.
const ANSI_CSI = /\p{Cc}\[[0-?]*[ -/]*[@-~]/gu;
const CONTROL_OR_SPACE = /[\p{Cc}\s]+/gu;

/**
 * A filter label as one plain line: a rehydrated session or an extension may carry any text, so
 * escape sequences and control characters go, whitespace runs fold to a space, and a long label
 * ends in an ellipsis. Mirrors the TUI's sanitize, flatten and truncate; home-path shortening is
 * left out (the browser does not know the host's home directory).
 */
function filterLabel(filter: string): string {
	const line = filter.replace(ANSI_CSI, "").replace(CONTROL_OR_SPACE, " ").trim();
	const chars = Array.from(line);
	return chars.length <= LABEL_MAX ? line : `${chars.slice(0, LABEL_MAX - 1).join("")}…`;
}

/** A byte count as the SDK words it: `512B`, `1.5KB`, `2.3MB`, `1.2GB`. */
export function formatMinimizedBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

const isByteCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The minimizer line of a bash call's settled `details` (`git 120.4KB → 3.2KB`), or undefined when
 * the output was not rewritten or the meta is not the shape the SDK writes.
 */
export function minimizedSummary(details: unknown): string | undefined {
	if (!isRecord(details) || !isRecord(details.meta)) return undefined;
	const minimized = details.meta.minimized;
	if (!isRecord(minimized)) return undefined;
	const { filter, inputBytes, outputBytes } = minimized;
	if (typeof filter !== "string" || !isByteCount(inputBytes) || !isByteCount(outputBytes))
		return undefined;
	const sizes = `${formatMinimizedBytes(inputBytes)} → ${formatMinimizedBytes(outputBytes)}`;
	const label = filterLabel(filter);
	return label === "" ? sizes : `${label} ${sizes}`;
}
