/**
 * Readable load-failure state for a fleet-stored session (ANA-12).
 *
 * A missing session (HTTP 404) never succeeds on retry, so it names the
 * session and offers no Retry. Anything else (including a 503 "unavailable"
 * store) keeps Retry.
 */
import { ApiError } from "../../store/fleet-api";

export interface StoredLoadError {
	title: string;
	retryable: boolean;
}

export function storedLoadError(err: unknown, sessionId: string): StoredLoadError {
	if (err instanceof ApiError && err.status === 404) {
		return { title: `Session ${sessionId} is not in fleet storage.`, retryable: false };
	}
	const detail = err instanceof Error ? err.message : String(err);
	return { title: `Failed to load this stored session: ${detail}`, retryable: true };
}
