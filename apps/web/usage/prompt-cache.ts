import type { PromptCacheStatusDto } from "#lib/wire/protocol";

/** How the indicator reads the cache: confirmed warm, warm by inference from a reopened transcript, or cold. */
export type PromptCacheTone = "warm" | "likely" | "cold";

export interface PromptCacheIndicator {
	tone: PromptCacheTone;
	/** The segment's short label. */
	label: string;
	/** The entry lapsed by the clock since the status was read: the segment shows cold before the next read says why. */
	expired: boolean;
}

/** Epoch ms the entry lapses; undefined when the provider never expires it. */
export function promptCacheExpiresAt(status: PromptCacheStatusDto): number | undefined {
	return status.ttlMs === undefined ? undefined : status.touchedAt + status.ttlMs;
}

/**
 * The segment's state at `nowMs`. A warm status flips to cold once `touchedAt + ttlMs` passes: nothing
 * announces a lapse, and the status itself was read earlier. The SDK's own text (brief, details) is never
 * recomputed here; a flip asks the session for a fresh read instead.
 */
export function promptCacheIndicator(
	status: PromptCacheStatusDto,
	nowMs: number,
): PromptCacheIndicator {
	if (status.state === "cold") return { tone: "cold", label: "cold", expired: false };
	const expiresAt = promptCacheExpiresAt(status);
	if (expiresAt !== undefined && nowMs >= expiresAt)
		return { tone: "cold", label: "cold", expired: true };
	return status.inferred
		? { tone: "likely", label: "likely warm", expired: false }
		: { tone: "warm", label: "warm", expired: false };
}
